/**
 * Registro vivo de los canales de aviso (Teams, correo, push) con su configuración y salud.
 *
 * - **Teams**: la URL del Workflow viene de `QAPAQ_TEAMS_WORKFLOW_URL` (arranque) y la puede
 *   reemplazar un administrador desde la consola; el valor de la base manda. Se guarda cifrada
 *   (AES-256-GCM con una clave derivada de `QAPAQ_ENTITY_REF_KEY`, AAD = tenant y canal) y el
 *   cambio aplica en caliente: el transporte lee la URL vigente en cada envío. Otras réplicas la
 *   recogen en la siguiente relectura (60 s).
 * - **Correo** y **push**: se configuran por despliegue (`QAPAQ_ALERT_MAIL_SENDER`, VAPID); aquí
 *   solo se encienden o apagan y se prueban.
 * - Cada envío actualiza la salud del canal (último éxito/fallo, HTTP, motivo), en memoria y
 *   en la base (sin bloquear el aviso si la base falla).
 *
 * - **Inicialización** (`initialize()`, una vez por arranque): cada canal sin fila recibe una,
 *   escrita por `system:bootstrap` y auditada. Si el despliegue trae la URL de Teams y hay clave,
 *   se guarda cifrada; el canal nace activo solo si quedó configurado. Una fila existente no se
 *   toca: la base manda sobre el entorno.
 * - **Concurrencia**: los cambios de configuración son compare-and-set sobre `revision`; la
 *   salud se guarda aparte y no la mueve, así que un envío nunca pisa un cambio de la consola.
 *
 * Nunca se registra ni devuelve la URL: solo su máscara.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';

import { recordAudit, type AuditStore } from '@qapaq/audit';
import {
  CHANNEL_IDS,
  emptyChannel,
  maskWebhookUrl,
  RETRY_POLICY,
  TeamsWorkflowTransport,
  validateTeamsWebhookUrl,
  type ChannelHealth,
  type ChannelId,
  type ChannelRecord,
  type ChannelStore,
  type DeliveryEvidence,
  type DeliveryOutcome,
  type FallbackChannel,
  type FallbackNotification,
  type MailChannel,
  type NotificationChannel,
  type NotificationTransport,
  type TeamsMessage,
} from '@qapaq/soar';

const REFRESH_MS = 60_000;

export function deriveChannelKey(masterKey: string | Buffer): Buffer {
  return createHmac('sha256', masterKey).update('qapaq.notification-channel.key.v1').digest();
}

export function encryptSecret(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
}

export function decryptSecret(key: Buffer, value: string, aad: string): string {
  const [version, iv, tag, ciphertext] = value.split(':');
  if (version !== 'v1' || !iv || !tag || ciphertext === undefined) throw new Error('CHANNEL_SECRET_FORMAT');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

export interface ChannelView {
  readonly id: ChannelId;
  readonly label: string;
  readonly enabled: boolean;
  readonly configured: boolean;
  /** `database` (consola), `environment` (despliegue) o `none`. */
  readonly source: 'database' | 'environment' | 'none';
  /** Máscara del destino; nunca la URL. */
  readonly destination: string | null;
  readonly status: 'ok' | 'degraded' | 'failing' | 'disabled' | 'not_configured' | 'unknown';
  readonly health: {
    readonly lastSuccessAt: string | null;
    readonly lastFailureAt: string | null;
    readonly lastHttpStatus: number | null;
    readonly lastFailureReason: string | null;
  };
  readonly lastTest: {
    readonly at: string | null;
    readonly outcome: 'accepted' | 'failed' | null;
    readonly httpStatus: number | null;
    readonly providerMessageId: string | null;
  };
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly note: string | null;
  /** Revisión de la configuración; la consola la devuelve como `expectedRevision`. */
  readonly revision: number;
  /**
   * Paso de puesta en marcha pendiente: `configure` (falta el destino), `enable` (configurado
   * pero apagado), `verify` (activo, sin ningún envío aceptado todavía) o `ready`.
   */
  readonly setup: ChannelSetupStep;
  /** `setup !== 'ready'`: el canal todavía no demostró que puede entregar. */
  readonly needsSetup: boolean;
}

export type ChannelSetupStep = 'configure' | 'enable' | 'verify' | 'ready';

/** Autor de las filas que escribe la inicialización del arranque. */
export const BOOTSTRAP_ACTOR = 'system:bootstrap';

export interface ChannelSeed {
  readonly channelId: ChannelId;
  readonly enabled: boolean;
  readonly configured: boolean;
  /** `true` si la URL de entorno quedó guardada cifrada en la base. */
  readonly secretStored: boolean;
  /** Por qué no se guardó el secreto pese a haber URL de entorno, si aplica. */
  readonly secretSkipped: 'ENCRYPTION_KEY_MISSING' | 'ENVIRONMENT_URL_REJECTED' | null;
}

export interface ChannelInitialization {
  /** Canales cuya fila escribió esta llamada. Vacío = ya estaban inicializados. */
  readonly seeded: readonly ChannelSeed[];
  /** Canales sin fila que no se pudieron sembrar (base no disponible). */
  readonly failed: readonly ChannelId[];
}

export type ChannelChange =
  | { readonly ok: true; readonly view: ChannelView }
  | { readonly ok: false; readonly code: 'REVISION_CONFLICT' };

const LABELS: Readonly<Record<ChannelId, string>> = Object.freeze({
  teams: 'Microsoft Teams (Workflows)',
  email: 'Correo (Microsoft Graph)',
  push: 'Consola y avisos del navegador (Web Push)',
});

export interface RegistryOptions {
  readonly tenantId: string;
  readonly store: ChannelStore;
  /** Clave de cifrado; sin ella no se puede guardar un webhook desde la consola. */
  readonly key?: Buffer;
  readonly environmentTeamsUrl?: string;
  readonly emailConfigured: boolean;
  readonly pushConfigured: boolean;
  readonly clock: () => Date;
  readonly fetchImplementation?: typeof fetch;
  readonly onError?: (code: string) => void;
}

export class NotificationChannelRegistry {
  private records = new Map<ChannelId, ChannelRecord>();
  private databaseTeamsUrl: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  public constructor(private readonly options: RegistryOptions) {}

  private aad(channelId: ChannelId): string {
    return `${this.options.tenantId}|${channelId}`;
  }

  private seedAudit: AuditStore | undefined;

  /** Sin fila (base caída en el arranque) el canal se comporta como la siembra: configurado ⇒ activo. */
  private record(channelId: ChannelId): ChannelRecord {
    return (
      this.records.get(channelId) ?? {
        ...emptyChannel(this.options.tenantId, channelId, this.options.clock()),
        enabled: this.configured(channelId),
      }
    );
  }

  /**
   * Inicialización idempotente: escribe la fila de cada canal que aún no la tiene y no toca las
   * existentes (la base manda sobre el entorno). Segura con el store en memoria, con varias
   * réplicas arrancando a la vez (inserción «solo si no existe») y sin clave de cifrado: en ese
   * caso la URL de entorno sigue sirviendo desde el entorno y se informa `secretSkipped`.
   */
  public async initialize(options: { readonly audit?: AuditStore } = {}): Promise<ChannelInitialization> {
    if (options.audit) this.seedAudit = options.audit;
    let existing: ReadonlySet<ChannelId>;
    try {
      const rows = await this.options.store.list(this.options.tenantId);
      existing = new Set(rows.map((row) => row.channelId));
    } catch {
      this.options.onError?.('CHANNEL_STORE_UNAVAILABLE');
      return { seeded: [], failed: [...CHANNEL_IDS] };
    }
    const seeded: ChannelSeed[] = [];
    const failed: ChannelId[] = [];
    for (const channelId of CHANNEL_IDS) {
      if (existing.has(channelId)) continue;
      const at = this.options.clock();
      const environmentUrl = channelId === 'teams' ? this.options.environmentTeamsUrl : undefined;
      let secret: { readonly ciphertext: string; readonly hint: string } | undefined;
      let secretSkipped: ChannelSeed['secretSkipped'] = null;
      if (environmentUrl) {
        const validation = validateTeamsWebhookUrl(environmentUrl);
        if (!this.options.key) secretSkipped = 'ENCRYPTION_KEY_MISSING';
        else if (!validation.ok) secretSkipped = 'ENVIRONMENT_URL_REJECTED';
        else {
          secret = {
            ciphertext: encryptSecret(this.options.key, validation.url, this.aad(channelId)),
            hint: maskWebhookUrl(validation.url),
          };
        }
      }
      // Antes de sembrar no hay fila: `configured` solo depende del despliegue.
      const configured = this.configured(channelId);
      const seed: ChannelSeed = {
        channelId,
        enabled: configured,
        configured,
        secretStored: secret !== undefined,
        secretSkipped,
      };
      try {
        const created = await this.options.store.create({
          ...emptyChannel(this.options.tenantId, channelId, at),
          enabled: configured,
          secretCiphertext: secret?.ciphertext ?? null,
          secretHint: secret?.hint ?? null,
          updatedBy: BOOTSTRAP_ACTOR,
          revision: 1,
        });
        // `false`: otra réplica la sembró (o un administrador la creó) entre la lectura y aquí.
        if (!created) continue;
      } catch {
        this.options.onError?.('CHANNEL_SEED_NOT_SAVED');
        failed.push(channelId);
        continue;
      }
      seeded.push(seed);
      await this.auditSeed(seed, at, environmentUrl);
    }
    if (seeded.length > 0) await this.refresh();
    return { seeded, failed };
  }

  /** Evidencia de la siembra: actor de sistema y solo la máscara del destino. */
  private async auditSeed(seed: ChannelSeed, at: Date, environmentUrl: string | undefined): Promise<void> {
    if (!this.seedAudit) return;
    try {
      await recordAudit(this.seedAudit, {
        id: randomUUID(),
        tenantId: this.options.tenantId,
        occurredAt: at,
        actor: { id: BOOTSTRAP_ACTOR, type: 'service' },
        action: 'notifications.channel.initialized',
        resource: { type: 'notification_channel', id: seed.channelId },
        outcome: 'succeeded',
        correlationId: randomUUID(),
        metadata: {
          enabled: seed.enabled,
          configured: seed.configured,
          source: environmentUrl ? 'environment' : seed.configured ? 'deployment' : 'none',
          destination: environmentUrl ? maskWebhookUrl(environmentUrl) : null,
          secretStored: seed.secretStored,
          secretSkipped: seed.secretSkipped,
        },
      });
    } catch {
      this.options.onError?.('CHANNEL_SEED_NOT_AUDITED');
    }
  }

  /**
   * Compare-and-set de un cambio de configuración. Con `expectedRevision`, cualquier diferencia
   * es conflicto. Sin él (clientes anteriores) se reintenta una vez sobre la fila recién leída:
   * el cambio se aplica al estado vigente, nunca a una copia vieja.
   */
  private async writeConfig(
    channelId: ChannelId,
    expectedRevision: number | undefined,
    change: (current: ChannelRecord) => ChannelRecord,
  ): Promise<ChannelRecord | undefined> {
    // Otra réplica pudo cambiar la fila después de la última relectura de esta.
    if (expectedRevision !== undefined && expectedRevision !== this.record(channelId).revision) {
      await this.refresh();
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = this.record(channelId);
      if (expectedRevision !== undefined && expectedRevision !== current.revision) return undefined;
      const next: ChannelRecord = { ...change(current), revision: current.revision + 1 };
      if (await this.options.store.saveConfig(next, current.revision)) {
        this.records.set(channelId, next);
        return next;
      }
      await this.refresh();
      if (expectedRevision !== undefined) return undefined;
    }
    return undefined;
  }

  /** Lee la base; un fallo deja la última configuración conocida (nunca vacía la URL). */
  public async refresh(): Promise<void> {
    try {
      const rows = await this.options.store.list(this.options.tenantId);
      const next = new Map<ChannelId, ChannelRecord>();
      for (const row of rows) next.set(row.channelId, row);
      const teams = next.get('teams');
      let url: string | undefined;
      if (teams?.secretCiphertext && this.options.key) {
        try {
          url = decryptSecret(this.options.key, teams.secretCiphertext, this.aad('teams'));
        } catch {
          this.options.onError?.('CHANNEL_SECRET_UNREADABLE');
          url = this.databaseTeamsUrl;
        }
      }
      this.records = next;
      this.databaseTeamsUrl = url;
    } catch {
      this.options.onError?.('CHANNEL_STORE_UNAVAILABLE');
    }
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  public enabled(channelId: ChannelId): boolean {
    return this.record(channelId).enabled;
  }

  public teamsUrl(): { readonly url: string; readonly source: 'database' | 'environment' } | undefined {
    if (this.databaseTeamsUrl) return { url: this.databaseTeamsUrl, source: 'database' };
    if (this.options.environmentTeamsUrl) {
      return { url: this.options.environmentTeamsUrl, source: 'environment' };
    }
    return undefined;
  }

  /** Registra el resultado de un envío real o de prueba (memoria + base, sin bloquear). */
  public async recordOutcome(channelId: ChannelId, evidence: DeliveryEvidence, test = false, expectedRevision?: number): Promise<void> {
    const current = this.record(channelId);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) return;
    const at = new Date(evidence.at);
    const accepted = evidence.outcome === 'accepted';
    const next: ChannelRecord = {
      ...current,
      ...(accepted ? { lastSuccessAt: at } : { lastFailureAt: at, lastFailureReason: evidence.reason }),
      lastHttpStatus: evidence.httpStatus,
      ...(test
        ? {
            lastTestAt: at,
            lastTestOutcome: evidence.outcome,
            lastTestHttpStatus: evidence.httpStatus,
            lastTestProviderId: evidence.providerMessageId,
          }
        : {}),
    };
    try {
      // Solo columnas de salud: no pisa `enabled`, el webhook ni la revisión de la consola.
      const { tenantId } = this.options;
      if (!(await this.options.store.saveHealth(tenantId, channelId, next, expectedRevision))) {
        if (expectedRevision !== undefined) {
          await this.refresh();
          return;
        }
        // Sin fila (la siembra del arranque no llegó a la base): se siembra y se reintenta.
        await this.initialize();
        this.records.set(channelId, { ...this.record(channelId), ...healthOf(next) });
        await this.options.store.saveHealth(tenantId, channelId, next);
      }
      if (this.record(channelId).revision === current.revision) this.records.set(channelId, next);
    } catch {
      this.options.onError?.('CHANNEL_HEALTH_NOT_SAVED');
    }
  }

  /** Transporte de Teams que siempre usa la URL vigente y respeta `enabled`. */
  public readonly teamsTransport: NotificationTransport = {
    destinationRef: 'teams:canal-soc',
    send: async (message: TeamsMessage, clientRequestId: string): Promise<DeliveryOutcome> => {
      if (!this.enabled('teams')) {
        return {
          delivered: false,
          failure: { class: 'permanent', code: 'CHANNEL_DISABLED', detail: 'El canal Teams está desactivado.' },
        };
      }
      const expectedRevision = this.record('teams').revision;
      const target = this.teamsUrl();
      if (!target) {
        return {
          delivered: false,
          failure: { class: 'permanent', code: 'CHANNEL_NOT_CONFIGURED', detail: 'Sin webhook de Teams.' },
        };
      }
      const outcome = await new TeamsWorkflowTransport({
        workflowUrl: target.url,
        destinationRef: 'teams:canal-soc',
        timeoutMs: RETRY_POLICY.requestTimeoutMs,
        ...(this.options.fetchImplementation ? { fetchImplementation: this.options.fetchImplementation } : {}),
      }).send(message, clientRequestId);
      await this.recordOutcome('teams', {
        channel: 'teams',
        outcome: outcome.delivered ? 'accepted' : 'failed',
        at: this.options.clock().toISOString(),
        httpStatus: outcome.httpStatus ?? null,
        providerMessageId: outcome.providerMessageId ?? null,
        providerLink: null,
        reason: outcome.delivered ? null : (outcome.failure?.code ?? 'UNKNOWN'),
      }, false, expectedRevision);
      return outcome;
    },
  };

  /** Envuelve el correo: respeta `enabled` y registra la salud. */
  public mail(inner: MailChannel): MailChannel {
    return {
      send: async (input) => {
        if (!this.enabled('email')) {
          return {
            channel: 'email',
            outcome: 'failed',
            at: this.options.clock().toISOString(),
            httpStatus: null,
            providerMessageId: null,
            providerLink: null,
            reason: 'CHANNEL_DISABLED',
          };
        }
        const evidence = await inner.send(input);
        await this.recordOutcome('email', evidence);
        return evidence;
      },
    };
  }

  /** Envuelve el aviso a dispositivos (Web Push): con el canal apagado no se envía nada. */
  public devices(inner: {
    notify(tenantId: string, subjectKeys: readonly string[]): Promise<number>;
  }): { notify(tenantId: string, subjectKeys: readonly string[]): Promise<number> } {
    return {
      notify: (tenantId, subjectKeys) =>
        this.enabled('push') ? inner.notify(tenantId, subjectKeys) : Promise.resolve(0),
    };
  }

  /** El respaldo por correo también respeta `enabled` (si está apagado, va a la consola). */
  public fallback(mailFallback: FallbackChannel, consoleFallback: FallbackChannel): FallbackChannel {
    return {
      notify: async (notification: FallbackNotification) => {
        const channel = this.enabled('email') ? mailFallback : consoleFallback;
        const result: {
          readonly channel: NotificationChannel;
          readonly reference: string;
          readonly evidence?: readonly DeliveryEvidence[];
        } = await channel.notify(notification);
        for (const item of result.evidence ?? []) {
          if (item.channel === 'email') await this.recordOutcome('email', item);
        }
        return result;
      },
    };
  }

  public async setTeamsUrl(raw: unknown, actorId: string, expectedRevision?: number): Promise<
    | { readonly ok: true; readonly view: ChannelView; readonly previous: string | null }
    | { readonly ok: false; readonly code: string }
  > {
    const validation = validateTeamsWebhookUrl(raw);
    if (!validation.ok) return { ok: false, code: validation.code };
    const key = this.options.key;
    if (!key) return { ok: false, code: 'ENCRYPTION_KEY_MISSING' };
    const previous = this.teamsUrl();
    const saved = await this.writeConfig('teams', expectedRevision, (current) => ({
      ...current,
      secretCiphertext: encryptSecret(key, validation.url, this.aad('teams')),
      secretHint: maskWebhookUrl(validation.url),
      updatedAt: this.options.clock(),
      updatedBy: actorId,
      // Destino nuevo: la salud anterior era de otro webhook.
      lastSuccessAt: null,
      lastFailureAt: null,
      lastHttpStatus: null,
      lastFailureReason: null,
      lastTestAt: null,
      lastTestOutcome: null,
      lastTestHttpStatus: null,
      lastTestProviderId: null,
    }));
    if (!saved) return { ok: false, code: 'REVISION_CONFLICT' };
    this.databaseTeamsUrl = validation.url;
    return {
      ok: true,
      view: this.view('teams'),
      previous: previous ? maskWebhookUrl(previous.url) : null,
    };
  }

  public async setEnabled(
    channelId: ChannelId,
    enabled: boolean,
    actorId: string,
    expectedRevision?: number,
  ): Promise<ChannelChange> {
    const saved = await this.writeConfig(channelId, expectedRevision, (current) => ({
      ...current,
      enabled,
      updatedAt: this.options.clock(),
      updatedBy: actorId,
    }));
    return saved ? { ok: true, view: this.view(channelId) } : { ok: false, code: 'REVISION_CONFLICT' };
  }

  public configured(channelId: ChannelId): boolean {
    if (channelId === 'teams') return this.teamsUrl() !== undefined;
    if (channelId === 'email') return this.options.emailConfigured;
    return this.options.pushConfigured;
  }

  public view(channelId: ChannelId): ChannelView {
    const record = this.record(channelId);
    const configured = this.configured(channelId);
    const teams = channelId === 'teams' ? this.teamsUrl() : undefined;
    const lastSuccess = record.lastSuccessAt?.getTime() ?? 0;
    const lastFailure = record.lastFailureAt?.getTime() ?? 0;
    const status: ChannelView['status'] = !configured
      ? 'not_configured'
      : !record.enabled
        ? 'disabled'
        : lastSuccess === 0 && lastFailure === 0
          ? 'unknown'
          : lastFailure > lastSuccess
            ? lastSuccess === 0
              ? 'failing'
              : 'degraded'
            : 'ok';
    const setup: ChannelSetupStep = !configured
      ? 'configure'
      : !record.enabled
        ? 'enable'
        : lastSuccess === 0 || lastFailure > lastSuccess
          ? 'verify'
          : 'ready';
    return {
      revision: record.revision,
      setup,
      needsSetup: setup !== 'ready',
      id: channelId,
      label: LABELS[channelId],
      enabled: record.enabled,
      configured,
      source: teams ? teams.source : configured ? 'environment' : 'none',
      destination: teams ? maskWebhookUrl(teams.url) : null,
      status,
      health: {
        lastSuccessAt: record.lastSuccessAt?.toISOString() ?? null,
        lastFailureAt: record.lastFailureAt?.toISOString() ?? null,
        lastHttpStatus: record.lastHttpStatus,
        lastFailureReason: record.lastFailureReason,
      },
      lastTest: {
        at: record.lastTestAt?.toISOString() ?? null,
        outcome: record.lastTestOutcome,
        httpStatus: record.lastTestHttpStatus,
        providerMessageId: record.lastTestProviderId,
      },
      updatedAt: record.secretHint || record.updatedBy ? record.updatedAt.toISOString() : null,
      updatedBy: record.updatedBy,
      note:
        channelId === 'teams'
          ? 'HTTP 202 = Microsoft aceptó el mensaje; la publicación en el canal la hace el Workflow (revisa su historial de ejecuciones si no aparece).'
          : channelId === 'email' && !configured
            ? 'Requiere QAPAQ_ALERT_MAIL_SENDER y el permiso de aplicación Mail.Send con consentimiento.'
            : null,
    };
  }

  public views(): readonly ChannelView[] {
    return (['teams', 'email', 'push'] as const).map((id) => this.view(id));
  }
}

function healthOf(record: ChannelRecord): ChannelHealth {
  return {
    lastSuccessAt: record.lastSuccessAt,
    lastFailureAt: record.lastFailureAt,
    lastHttpStatus: record.lastHttpStatus,
    lastFailureReason: record.lastFailureReason,
    lastTestAt: record.lastTestAt,
    lastTestOutcome: record.lastTestOutcome,
    lastTestHttpStatus: record.lastTestHttpStatus,
    lastTestProviderId: record.lastTestProviderId,
  };
}
