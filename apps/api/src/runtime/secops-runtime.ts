/**
 * Composición del BFF: C-16, C-17, C-18, C-19, C-20 y C-25 en un solo objeto de runtime.
 *
 * El estado SOC (candidatos, alertas, incidentes, auditoría y outbox) vive detrás de
 * `SocPersistence`. El composition root elige el adapter: PostgreSQL donde el estado debe
 * sobrevivir a un reinicio, memoria para specs y desarrollo. Los controladores solo ven
 * el puerto, así que el cambio de adapter no los toca.
 *
 * El despacho de C-20 consume directamente la cola durable del outbox SOC (claim con
 * lease) y guarda sus intentos en el `AttemptStore` inyectado; con PostgreSQL ambos
 * sobreviven a un reinicio. Un bucle (`NotificationDispatcher`) despacha sin intervención.
 *
 * Siguen en memoria, y así lo declara la matriz de C-22: sesiones, handshakes OIDC y
 * contadores de lockout/rate limit. Un reinicio cierra sesiones, pero no borra alertas,
 * veredictos, incidentes, auditoría ni notificaciones pendientes.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  beginAuthorization,
  constantTimeEquals,
  capabilitiesForRoles,
  decideSignIn,
  effectiveCapabilities,
  emptyCounter,
  evaluateLockout,
  evaluateNetwork,
  evaluateSession,
  consumeRateLimit,
  InMemoryAttemptStore,
  InMemoryHandshakeStore,
  InMemoryRateLimitStore,
  InMemorySessionStore,
  openSession,
  policyForNetwork,
  registerFailure,
  registerSuccess,
  resolveCallback,
  revokeSession,
  validateIdToken,
  type Actor,
  type Capability,
  type JwksProvider,
  type NetworkPolicy,
  type RequestOrigin,
  type Session,
  type SessionStore,
  type SignInDenialReason,
  type TokenExchange,
} from '@qapaq/access';
import { recordAudit, type AuditEventDraft, type AuditStore } from '@qapaq/audit';
import type { AccessConfig } from '@qapaq/configuration';
import {
  correlate,
  correlationHorizon,
  decidePromotion,
  DEFAULT_CORRELATION_POLICY,
  entityKeysOf,
  PRIORITIZATION_RULESET_ID,
  PRIORITIZATION_RULESET_VERSION,
  promotionKey,
  type CorrelationPolicy,
  type PrioritizationContext,
  type SignalCatalog,
} from '@qapaq/detection';
import {
  InMemorySoc,
  ingestCandidate,
  type EntityRefFactory,
  type SocDependencies,
  type SocPersistence,
} from '@qapaq/soc';
import {
  ConsoleFallbackChannel,
  drainOutbox,
  InMemoryAttemptStore as InMemoryNotificationStore,
  RETRY_POLICY,
  TeamsWorkflowTransport,
  type AttemptStore,
  type DispatchDependencies,
  type NotificationTransport,
  type OutboxReader,
} from '@qapaq/soar';
import type { SecurityEvent } from '@qapaq/contracts';

import {
  EntraJwksProvider,
  EntraTokenExchange,
  LocalJwksProvider,
  LocalTokenExchange,
} from '../access/identity-provider.js';
import { LocalDevelopmentIssuer, LOCAL_PRINCIPALS } from '../access/local-issuer.js';
import { csrfTokenFor } from '../http/csrf.js';
import { DEFAULT_RETURN_TO } from '../http/return-to.js';
import type { ProcessInfo } from '../soc/operations-health.js';
import type { EventsReader } from './events-reader.js';
import type { SourceHealthMonitor } from './source-health.js';
import type { RoleGrantsConfig } from '@qapaq/configuration';
import type { DirectoryStore, RoleAdministration } from '@qapaq/access';
import {
  notifyDevices,
  type FallbackChannel,
  type PushSender,
  type PushSubscriptionStore,
  type RecipientDirectory,
} from '@qapaq/soar';

/** Padrón disponible para la administración. */
export type RuntimeDirectory =
  | { readonly mode: 'disabled' }
  | {
      readonly mode: 'graph';
      readonly groupId: string;
      readonly intervalMs: number;
      readonly store: DirectoryStore;
    };
import { NotificationDispatcher } from './notification-dispatcher.js';
import { CONNECTED_SOURCE_SIGNAL_CATALOG } from './signal-catalog.js';
import { AssistantService } from './assistant.js';
import { entityRefFactory } from './entity-refs.js';
import { DEFAULT_ASSISTANT_MODEL } from '@qapaq/configuration';

/**
 * Diagnóstico de un inicio de sesión rechazado. Solo códigos: ni tokens, ni claims, ni texto
 * del proveedor. `stage` dice dónde se cortó y `code` el motivo técnico (p. ej. el AADSTS del
 * intercambio o la validación del ID token que falló).
 */
export interface SignInDiagnostic {
  readonly reason: SignInDenialReason;
  readonly stage: 'rate_limit' | 'callback' | 'network' | 'token_exchange' | 'jwks' | 'decision';
  readonly code?: string;
  readonly correlationId: string;
}

const DIAGNOSTIC_CODE = /^[A-Za-z0-9_.,-]{1,80}$/u;

function diagnosticCode(value: unknown): string | undefined {
  return typeof value === 'string' && DIAGNOSTIC_CODE.test(value) ? value : undefined;
}

/** Código técnico de un rechazo por decisión: qué faltó en el token o en los roles. */
function decisionDiagnostic(
  reason: SignInDenialReason,
  validation: ReturnType<typeof validateIdToken>,
): string {
  if (reason === 'LOCKED_OUT') return reason;
  if (!validation.ok) {
    return validation.code === 'AMR_NOT_ACCEPTED' && diagnosticCode(validation.detail)
      ? `AMR_NOT_ACCEPTED:${validation.detail}`
      : validation.code;
  }
  if (reason === 'MFA_REQUIRED' || reason === 'PASSKEY_REQUIRED') {
    return `amr:${(validation.claims.amr ?? []).join(',') || 'none'}`;
  }
  if (reason === 'NO_ROLE_ASSIGNED') {
    // Sin claim `groups`, la pertenencia al grupo admin solo puede salir del padrón de Graph.
    return `groups_claim:${validation.claims.groups === undefined ? 'absent' : 'present'}`;
  }
  return reason;
}

export interface RuntimeOptions {
  readonly access: AccessConfig;
  /** Clave CSRF compartida entre réplicas; solo efímera en perfiles de memoria/tests. */
  readonly csrfKey?: Buffer;
  readonly demoMfaExceptionUntil?: Date;
  readonly profile: string;
  readonly clientSecret?: string;
  readonly teamsWorkflowUrl?: string;
  readonly transport?: NotificationTransport;
  readonly clock?: () => Date;
  /** Adapter de estado SOC. Sin él, memoria: válido para specs y desarrollo. */
  readonly soc?: SocPersistence;
  /** Contexto de negocio de C-16 cargado desde configuración. */
  readonly detectionContext?: PrioritizationContext;
  readonly correlationPolicy?: CorrelationPolicy;
  /** Catálogo acción → señal de las fuentes conectadas; por defecto, el del MVP. */
  readonly signalCatalog?: SignalCatalog;
  /** Referencias opacas de entidad (D-10b). Sin ella, las alertas no se pueden pivotar. */
  readonly entityRefs?: EntityRefFactory;
  /** Sesiones del BFF (C-18). Sin él, memoria: un reinicio cierra todas las sesiones. */
  readonly sessions?: SessionStore;
  /** Intentos de notificación de C-20. Sin él, memoria. */
  readonly notifications?: AttemptStore;
  /** Intervalo del bucle de despacho; el bucle solo corre tras `startDispatcher()`. */
  readonly dispatchIntervalMs?: number;
  /** Reporte de fallos del bucle de despacho, sin datos del mensaje. */
  readonly onDispatchError?: (error: unknown) => void;
  /** Motivo técnico de cada inicio de sesión rechazado, para el log del proceso. */
  readonly onSignInDenied?: (diagnostic: SignInDiagnostic) => void;
  /** Métricas del proceso; las inyecta el entrypoint, único que puede leer `process`. */
  readonly processInfo?: () => ProcessInfo;
  /**
   * Roles concedidos por QAPAQ (asignaciones del deploy y dueños del grupo). Se suman a los
   * app roles del token; sin resolvedor, solo cuentan el token y la asignación temporal.
   */
  readonly roleGrants?: (
    oid: string | undefined,
    groups?: readonly string[],
  ) => Promise<readonly string[]>;
  /** Explorador de eventos (fase 1). Sin lector, la fuente de eventos está deshabilitada. */
  readonly events?: EventsReader;
  /** Fuente vigilada por la salud por fuente (fase 2); existe aunque esté deshabilitada. */
  readonly sourceHealth?: SourceHealthMonitor;
  /** Padrón del grupo de admisión (fase 3); sin él, la sincronización está deshabilitada. */
  readonly directory?: RuntimeDirectory;
  /** Roles concedidos por el deploy, para explicar el origen de cada rol en la administración. */
  readonly roleGrantsConfig?: RoleGrantsConfig;
  /**
   * Administración de roles: grants dinámicos y solicitudes, con la unidad de trabajo que los
   * confirma junto a su AuditEvent. Sin ella no se pueden pedir ni aprobar roles desde la consola;
   * para que los grants cuenten al iniciar sesión, el composition root los suma en `roleGrants`.
   */
  readonly roleAdministration?: RoleAdministration;
  /** Destinatarios de Teams por rol (Sprint 5); sin él, la tarjeta sale sin menciones. */
  readonly recipients?: RecipientDirectory;
  /**
   * Respaldo cuando Teams no confirma la entrega (Sprint 5: correo). Recibe la bandeja de la
   * consola como siguiente eslabón; sin él, el respaldo es solo la consola.
   */
  readonly fallbackChain?: (consoleFallback: FallbackChannel) => FallbackChannel;
  /** Avisos al dispositivo (Web Push, Sprint 5); sin él la consola los muestra deshabilitados. */
  readonly push?: { readonly store: PushSubscriptionStore; readonly sender: PushSender };
  /** Asistente Claude; sin él, uno sin configurar (el endpoint responde FEATURE_NOT_CONFIGURED). */
  readonly assistant?: AssistantService;
  /** Fallos del proveedor del asistente, solo con su código, para el log del proceso. */
  readonly onAssistantError?: (code: string) => void;
}

/** Tope de alertas que la correlación lee por evento; protege frente a entidades ruidosas. */
const CORRELATION_READ_LIMIT = 500;
/**
 * Lote que el despacho reclama por pasada. Los envíos del lote son secuenciales: el peor caso
 * de una pasada es `DISPATCH_BATCH × timeout del transporte` (5 × 10 s = 50 s).
 */
const DISPATCH_BATCH = 5;
/**
 * Lease del claim del outbox: al menos el doble del peor caso de una pasada, para que un
 * despachador sano nunca pierda su claim a mitad de lote. Si el proceso muere, el lease
 * vence, otro despachador reclama con un token nuevo (fencing) y el anterior ya no puede
 * cerrar el mensaje.
 */
const OUTBOX_LEASE_MS = Math.max(120_000, 2 * DISPATCH_BATCH * RETRY_POLICY.requestTimeoutMs);
const DEFAULT_DISPATCH_INTERVAL_MS = 5_000;
/** Pasadas de revocación tras un cambio de roles; cada una relee las sesiones activas. */
const ROLE_CHANGE_REVOCATION_ATTEMPTS = 3;

/**
 * Scopes que el BFF, como cliente confidencial, siempre solicita. El recorte real lo
 * hace el rol de la persona: la intersección vive en `effectiveCapabilities`.
 */
export const BFF_SCOPES = ['soc.read', 'soc.write', 'audit.read'] as const;

export type SignInFailure = { readonly reason: SignInDenialReason; readonly message: string };

export interface SignInSuccess {
  readonly session: Session;
  readonly supersededSessions: readonly string[];
}

export class SecOpsRuntime {
  public readonly handshakes = new InMemoryHandshakeStore();
  public readonly sessions: SessionStore;
  public readonly attempts = new InMemoryAttemptStore();
  public readonly rateLimits = new InMemoryRateLimitStore();
  public readonly soc: SocPersistence;
  public readonly notifications: AttemptStore;
  public readonly dispatcher: NotificationDispatcher;
  /** Bandeja de la consola: último eslabón del respaldo, siempre presente. */
  public readonly consoleFallback = new ConsoleFallbackChannel();

  /** Cadena de respaldo efectiva: correo → consola, o solo consola. */
  public get fallback(): FallbackChannel {
    this.#fallback ??= this.options.fallbackChain
      ? this.options.fallbackChain(this.consoleFallback)
      : this.consoleFallback;
    return this.#fallback;
  }

  #fallback: FallbackChannel | undefined;
  public readonly localIssuer: LocalDevelopmentIssuer | undefined;
  public readonly networkPolicy: NetworkPolicy;
  private readonly jwks: JwksProvider;
  private readonly tokens: TokenExchange;
  private readonly transport: NotificationTransport;
  private readonly clock: () => Date;
  /** Clave estable entre réplicas cuando el BFF usa persistencia compartida. */
  private readonly csrfKey: Buffer;
  /**
   * Contexto de priorización de C-16. Viene de configuración (`QAPAQ_DETECTION_*`); sin
   * ella, listas vacías y la prioridad depende solo de severidad y correlación.
   */
  public detectionContext: PrioritizationContext;
  private readonly correlationPolicy: CorrelationPolicy;
  private readonly signalCatalog: SignalCatalog;

  public constructor(private readonly options: RuntimeOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.csrfKey = options.csrfKey ?? randomBytes(32);
    this.soc = options.soc ?? new InMemorySoc();
    this.sessions = options.sessions ?? new InMemorySessionStore();
    this.notifications = options.notifications ?? new InMemoryNotificationStore();
    this.dispatcher = new NotificationDispatcher({
      drain: async () => (await drainOutbox(this.dispatchDependencies(), DISPATCH_BATCH)).length,
      intervalMs: options.dispatchIntervalMs ?? DEFAULT_DISPATCH_INTERVAL_MS,
      onError: options.onDispatchError ?? (() => undefined),
    });
    this.detectionContext = options.detectionContext ?? {
      privilegedIdentities: new Set(),
      criticalAssets: new Set(),
    };
    this.correlationPolicy = options.correlationPolicy ?? DEFAULT_CORRELATION_POLICY;
    this.signalCatalog = options.signalCatalog ?? CONNECTED_SOURCE_SIGNAL_CATALOG;
    this.networkPolicy = {
      allowedCidrs: options.access.allowedCidrs,
      trustedProxyCidrs: options.access.trustedProxyCidrs,
    };
    if (options.access.identityMode === 'local-development') {
      this.localIssuer = new LocalDevelopmentIssuer({
        issuer: options.access.issuer,
        audience: options.access.clientId,
        tenantId: options.access.tenantId,
        profile: options.profile,
      });
      this.jwks = new LocalJwksProvider(this.localIssuer);
      this.tokens = new LocalTokenExchange(this.localIssuer, this.clock);
    } else {
      this.jwks = new EntraJwksProvider(options.access.jwksUri);
      this.tokens = new EntraTokenExchange({
        tokenEndpoint: options.access.tokenEndpoint,
        clientId: options.access.clientId,
        clientSecret: options.clientSecret ?? '',
        scopes: options.access.scopes,
      });
    }
    this.transport =
      options.transport ??
      new TeamsWorkflowTransport({
        workflowUrl: options.teamsWorkflowUrl ?? 'https://localhost/teams-not-configured',
        destinationRef: 'teams:canal-soc',
      });
  }

  public now(): Date {
    return this.clock();
  }

  /**
   * Cadena de auditoría única: la escriben los casos de uso SOC, el inicio de sesión y el
   * despacho, y la lee C-19. Se resuelve en cada acceso porque el adapter en memoria
   * reemplaza su store al deshacer una transacción.
   */
  public get audit(): AuditStore {
    return this.soc.audit;
  }

  /** La cookie solo se marca `Secure` donde el transporte lo es: si no, no viajaría. */
  public get secureCookies(): boolean {
    return this.options.profile === 'production';
  }

  public get directory(): RuntimeDirectory | undefined {
    return this.options.directory;
  }

  public get roleGrantsConfig(): RoleGrantsConfig | undefined {
    return this.options.roleGrantsConfig;
  }

  public get roleAdministration(): RoleAdministration | undefined {
    return this.options.roleAdministration;
  }

  /** Tenant del padrón: el del app registration (instalación de un solo tenant). */
  public get tenantIdForDirectory(): string {
    return this.options.access.tenantId;
  }

  /** Fuente vigilada por la salud por fuente; `undefined` solo en specs que no la declaran. */
  public get sourceHealth(): SourceHealthMonitor | undefined {
    return this.options.sourceHealth;
  }

  public get push(): RuntimeOptions['push'] {
    return this.options.push;
  }

  public get access(): AccessConfig {
    return this.options.access;
  }

  private unconfiguredAssistant: AssistantService | undefined;

  /** Asistente Claude. Sin uno inyectado, existe igual pero sin configurar. */
  public get assistant(): AssistantService {
    if (this.options.assistant) return this.options.assistant;
    this.unconfiguredAssistant ??= new AssistantService({
      model: DEFAULT_ASSISTANT_MODEL,
      refOf: this.options.entityRefs ?? entityRefFactory(randomBytes(32).toString('base64url')),
      soc: () => this.soc,
    });
    return this.unconfiguredAssistant;
  }

  public reportAssistantError(code: string): void {
    this.options.onAssistantError?.(code);
  }

  /** Lector del explorador de eventos; `undefined` si no hay fuente configurada. */
  public get events(): EventsReader | undefined {
    return this.options.events;
  }

  public get isLocalIdentity(): boolean {
    return this.options.access.identityMode === 'local-development';
  }

  public get redirectUri(): string {
    return this.options.access.redirectUri;
  }

  public get tenantId(): string {
    return this.options.access.tenantId;
  }

  public socDependencies(): SocDependencies {
    return {
      unitOfWork: this.soc,
      clock: { now: () => this.now() },
      ids: { next: () => randomUUID() },
      ...(this.options.entityRefs ? { entityRefs: this.options.entityRefs } : {}),
    };
  }

  /** Referencia opaca de una clave de entidad, o `undefined` sin factory configurada. */
  public entityRefOf(tenantId: string, entityKey: string): string | undefined {
    return this.options.entityRefs?.(tenantId, entityKey);
  }

  /**
   * Puerto `OutboxReader` de C-20 sobre la cola durable del SOC. No hay copia intermedia:
   * lo que el despacho no publicó sigue en la cola y vuelve a ser reclamable al vencer el
   * lease.
   */
  private get outboxReader(): OutboxReader {
    return {
      claimPending: async (limit, now) => {
        const claimed = await this.soc.claimOutbox(now, limit, OUTBOX_LEASE_MS);
        for (const message of claimed) this.claimTokens.set(message.messageId, message.claimToken);
        return claimed;
      },
      // Sin token propio no hay nada que cerrar: el claim lo tiene otro despachador.
      markPublished: async (messageId, at) => {
        const token = this.claimTokens.get(messageId);
        this.claimTokens.delete(messageId);
        if (token) await this.soc.markOutboxPublished(messageId, token, at);
      },
      scheduleRetry: async (messageId, availableAt, errorCode) => {
        const token = this.claimTokens.get(messageId);
        this.claimTokens.delete(messageId);
        if (token) await this.soc.scheduleOutboxRetry(messageId, token, availableAt, errorCode);
      },
    };
  }

  /**
   * Tokens de los claims vivos de este proceso, por `messageId`. Es memoria de trabajo: si
   * el proceso muere, los claims vencen solos y otro despachador los toma con token nuevo.
   */
  private readonly claimTokens = new Map<string, string>();

  public dispatchDependencies(): DispatchDependencies {
    return {
      outbox: this.outboxReader,
      attempts: this.notifications,
      transport: this.transport,
      fallback: this.fallback,
      audit: this.soc.audit,
      clock: { now: () => this.now() },
      ids: { next: () => randomUUID() },
      consoleBaseUrl: this.options.access.consoleBaseUrl,
      ...(this.options.recipients ? { recipients: this.options.recipients } : {}),
      ...(this.options.push
        ? {
            devices: {
              notify: (tenantId: string, subjectKeys: readonly string[]) =>
                notifyDevices({
                  store: this.options.push!.store,
                  sender: this.options.push!.sender,
                  tenantId,
                  subjectKeys,
                  now: () => this.now(),
                }),
            },
          }
        : {}),
    };
  }

  /**
   * Puente C-16 → C-17: correlaciona, prioriza y materializa la alerta si corresponde.
   *
   * Orden deliberado:
   * 1. Idempotencia por evento: si ya hay alerta para este `recordId`, es `duplicate`
   *    aunque el ruleset haya cambiado de versión. Una alerta por evento es la regla del
   *    runtime; reevaluar con otra versión es un replay explícito, no un efecto lateral.
   * 2. Correlación sobre la ventana de alertas previas de las mismas entidades, excluida
   *    la propia alerta del evento si existiera.
   * 3. Priorización con contexto de negocio + correlación, y promoción.
   */
  public async promoteEvent(
    event: SecurityEvent,
  ): Promise<'promoted' | 'duplicate' | 'not_promoted'> {
    const tenantId = event.tenant.id;
    const key = promotionKey(tenantId, event.recordId, PRIORITIZATION_RULESET_VERSION);
    const existingAlert = await this.soc.alertByEventRecordId(tenantId, event.recordId);
    const existing = existingAlert
      ? {
          id: existingAlert.id,
          tenantId: existingAlert.tenantId,
          eventRecordId: existingAlert.eventRecordId,
          eventUid: event.eventUid,
          idempotencyKey: key,
          priority: existingAlert.priority,
          score: existingAlert.score,
          reasons: existingAlert.reasons,
          rulesetId: PRIORITIZATION_RULESET_ID,
          rulesetVersion: PRIORITIZATION_RULESET_VERSION,
          occurredAt: existingAlert.occurredAt,
          createdAt: existingAlert.createdAt,
          title: existingAlert.title,
          entityKeys: existingAlert.entityKeys,
          signal: existingAlert.signal ?? 'other',
          ruleId: existingAlert.ruleId,
          relatedAlertIds: existingAlert.relatedAlertIds,
        }
      : undefined;
    const recent = existing
      ? []
      : await this.soc.recentByEntities(
          tenantId,
          entityKeysOf(event),
          correlationHorizon(event, this.correlationPolicy),
          CORRELATION_READ_LIMIT,
        );
    const correlation = correlate(event, recent, this.correlationPolicy, this.signalCatalog);
    const decision = decidePromotion(
      event,
      { ...this.detectionContext, correlation },
      existing,
      this.now(),
    );
    if (decision.outcome !== 'promoted') return decision.outcome;
    await ingestCandidate(this.socDependencies(), decision.candidate);
    this.dispatcher.kick();
    return 'promoted';
  }

  /** Referencia `h:<sha256>` de una sesión: la forma en que la administración la nombra. */
  /**
   * Sprint 5 · fase 3 — revoca las sesiones activas de personas que perdieron acceso por un cambio
   * en el padrón (baja del grupo o pérdida de la propiedad). Idempotente: sin sesiones activas no
   * hace nada, así puede correr en cada ciclo de sincronización. Cada revocación queda auditada
   * con el motivo; un conflicto de revisión (la sesión cambió en paralelo) se reintenta en el
   * ciclo siguiente.
   */
  public async revokeSessionsByOid(
    oids: readonly string[],
    reason: 'membership_removed' | 'ownership_removed',
  ): Promise<number> {
    let revoked = 0;
    for (const oid of new Set(oids.map((value) => value.toLowerCase()))) {
      revoked += await this.revokeActiveSessionsOf(
        oid,
        reason,
        { id: 'system:directory-sync', type: 'service' },
        randomUUID(),
      );
    }
    return revoked;
  }

  /**
   * Cambio de roles desde la administración: revoca las sesiones activas de la persona para que
   * ninguna siga con los roles anteriores. A diferencia del padrón, no hay un ciclo siguiente que
   * reintente, así que un conflicto de revisión (la sesión justo registró actividad) se relee y
   * se reintenta aquí. `remaining` > 0 significa que alguna sigue activa tras los reintentos.
   */
  public async revokeSessionsForRoleChange(
    oid: string,
    actor: { readonly id: string; readonly sessionId: string },
    correlationId: string,
  ): Promise<{ readonly revoked: number; readonly remaining: number }> {
    const key = oid.toLowerCase();
    let revoked = 0;
    for (let attempt = 0; attempt < ROLE_CHANGE_REVOCATION_ATTEMPTS; attempt += 1) {
      revoked += await this.revokeActiveSessionsOf(
        key,
        'roles_changed',
        { id: actor.id, type: 'user', sessionId: actor.sessionId },
        correlationId,
      );
      if ((await this.sessions.activeByOid(this.tenantId, key)).length === 0) {
        return { revoked, remaining: 0 };
      }
    }
    return { revoked, remaining: (await this.sessions.activeByOid(this.tenantId, key)).length };
  }

  /** Una pasada sobre las sesiones activas de un OID; cada revocación queda auditada. */
  private async revokeActiveSessionsOf(
    oid: string,
    reason: 'membership_removed' | 'ownership_removed' | 'roles_changed',
    actor: AuditEventDraft['actor'],
    correlationId: string,
  ): Promise<number> {
    let revoked = 0;
    for (const session of await this.sessions.activeByOid(this.tenantId, oid)) {
      const at = this.now();
      if (!(await this.sessions.update(revokeSession(session, reason, at), session.revision))) {
        continue;
      }
      revoked += 1;
      await recordAudit(this.audit, {
        id: randomUUID(),
        tenantId: this.tenantId,
        occurredAt: at,
        actor,
        action: 'access.session.revoked',
        resource: { type: 'session', id: session.subjectId },
        outcome: 'succeeded',
        correlationId,
        reason,
        metadata: { reference: session.id },
      });
    }
    return revoked;
  }

  public sessionReferenceOf(sessionId: string): string {
    return `h:${createHash('sha256').update(sessionId, 'utf8').digest('hex')}`;
  }

  public processInfo(): ProcessInfo | null {
    return this.options.processInfo?.() ?? null;
  }

  /** Arranca el despacho continuo. Lo llama el entrypoint, no las specs. */
  public startDispatcher(): void {
    this.dispatcher.start();
  }

  public stopDispatcher(): Promise<void> {
    return this.dispatcher.stop();
  }

  /** Token CSRF de la sesión: se entrega en `GET /api/auth/session` y se exige al mutar. */
  public csrfTokenFor(sessionId: string): string {
    return csrfTokenFor(this.csrfKey, sessionId);
  }

  public async beginSignIn(
    origin: RequestOrigin,
    returnTo: string = DEFAULT_RETURN_TO,
  ): Promise<{
    readonly url: string;
    readonly state: string;
    readonly browserBinding: string;
    readonly network: ReturnType<typeof evaluateNetwork>;
  }> {
    const request = beginAuthorization(
      {
        tenantId: this.options.access.tenantId,
        clientId: this.options.access.clientId,
        authorizationEndpoint: this.options.access.authorizationEndpoint,
        redirectUri: this.options.access.redirectUri,
        allowedRedirectUris: this.options.access.allowedRedirectUris,
        scopes: this.options.access.scopes,
      },
      this.now(),
    );
    this.rememberNonce(request.state, request.nonce);
    this.pendingReturnTo.set(request.state, {
      returnTo,
      browserBinding: request.browserBinding,
    });
    await this.handshakes.save({
      state: request.state,
      nonce: request.nonce,
      codeVerifier: request.codeVerifier,
      browserBinding: request.browserBinding,
      redirectUri: this.options.access.redirectUri,
      createdAt: this.now(),
      expiresAt: request.expiresAt,
    });
    return {
      url: request.authorizationUrl,
      state: request.state,
      browserBinding: request.browserBinding,
      network: evaluateNetwork(origin, this.networkPolicy),
    };
  }

  /** Atajo del emisor local: entrega el código que Entra devolvería tras autenticar. */
  public localAuthorize(username: string, state: string): string {
    if (!this.localIssuer) throw new Error('LOCAL_ISSUER_NOT_ENABLED');
    const pending = this.handshakePeek(state);
    if (!pending) throw new Error('STATE_UNKNOWN');
    return this.localIssuer.issueCode(username, pending.nonce, this.now());
  }

  private readonly pendingNonces = new Map<string, { nonce: string }>();
  /** Destino ya validado por `safeReturnTo`, atado al `state` del handshake (B-03). */
  private readonly pendingReturnTo = new Map<
    string,
    { readonly returnTo: string; readonly browserBinding: string }
  >();

  /** Se consume una sola vez, igual que el `state` al que pertenece. */
  public takeReturnTo(state: string | undefined, browserBinding: string | undefined): string {
    if (!state) return DEFAULT_RETURN_TO;
    const pending = this.pendingReturnTo.get(state);
    if (
      !pending ||
      !browserBinding ||
      !constantTimeEquals(browserBinding, pending.browserBinding)
    ) {
      return DEFAULT_RETURN_TO;
    }
    this.pendingReturnTo.delete(state);
    return pending.returnTo;
  }

  public rememberNonce(state: string, nonce: string): void {
    this.pendingNonces.set(state, { nonce });
  }

  public handshakePeek(state: string): { readonly nonce: string } | undefined {
    return this.pendingNonces.get(state);
  }

  public async completeSignIn(
    input: {
      readonly state?: string;
      readonly code?: string;
      readonly error?: string;
      readonly browserBinding?: string;
    },
    origin: RequestOrigin,
    correlationId: string,
  ): Promise<
    | { readonly ok: true; readonly value: SignInSuccess }
    | { readonly ok: false; readonly failure: SignInFailure }
  > {
    const at = this.now();
    const network = evaluateNetwork(origin, this.networkPolicy);
    const originKey = network.clientIp ?? 'unknown';
    const rate = consumeRateLimit(
      await this.rateLimits.get(`auth:${originKey}`),
      `auth:${originKey}`,
      at,
    );
    await this.rateLimits.save(rate.state);
    if (!rate.allowed) {
      return this.denied('RATE_LIMITED', originKey, correlationId, at, network.clientIp, {
        stage: 'rate_limit',
      });
    }
    const stored = input.state
      ? await this.handshakes.consume(input.state, input.browserBinding, at)
      : undefined;
    const callback = resolveCallback(input, stored, at);
    if (!callback.ok) {
      return this.denied('TOKEN_INVALID', originKey, correlationId, at, network.clientIp, {
        stage: 'callback',
        code:
          callback.code === 'PROVIDER_ERROR' && diagnosticCode(callback.detail)
            ? `PROVIDER_ERROR:${callback.detail}`
            : callback.code,
      });
    }
    const policy = policyForNetwork(network.decision);
    if (!policy) {
      return this.denied('NETWORK_UNTRUSTED', originKey, correlationId, at, network.clientIp, {
        stage: 'network',
        code: network.decision,
      });
    }
    let idToken: string;
    try {
      idToken = (
        await this.tokens.exchange({
          code: callback.code,
          codeVerifier: callback.handshake.codeVerifier,
          redirectUri: callback.handshake.redirectUri,
        })
      ).idToken;
    } catch (error) {
      return this.denied('TOKEN_INVALID', originKey, correlationId, at, network.clientIp, {
        stage: 'token_exchange',
        code: diagnosticCode(error instanceof Error ? error.message : undefined) ?? 'UNKNOWN',
      });
    }
    let signingKeys: Awaited<ReturnType<JwksProvider['keys']>>;
    try {
      signingKeys = await this.jwks.keys();
    } catch (error) {
      return this.denied('TOKEN_INVALID', originKey, correlationId, at, network.clientIp, {
        stage: 'jwks',
        code: diagnosticCode(error instanceof Error ? error.message : undefined) ?? 'UNKNOWN',
      });
    }
    const validation = validateIdToken(
      idToken,
      signingKeys,
      {
        issuer: this.options.access.issuer,
        audience: this.options.access.clientId,
        tenantId: this.options.access.tenantId,
      },
      callback.handshake.nonce,
      at,
    );
    const subjectKey = validation.ok ? validation.claims.sub : `unknown:${originKey}`;
    const counter =
      (await this.attempts.get(subjectKey, originKey)) ?? emptyCounter(subjectKey, originKey, at);
    const lockout = evaluateLockout(counter, at);
    const backendBinding = this.options.access.mvpRoleBinding;
    const backendRole =
      validation.ok &&
      backendBinding &&
      validation.claims.oid?.toLowerCase() === backendBinding.oid &&
      at.getTime() < backendBinding.expiresAt.getTime()
        ? backendBinding.role
        : undefined;
    const granted =
      validation.ok && this.options.roleGrants
        ? await this.options.roleGrants(validation.claims.oid, validation.claims.groups)
        : [];
    const roles = validation.ok
      ? [
          ...new Set([
            ...(validation.claims.roles ?? []),
            ...(backendRole ? [backendRole] : []),
            ...granted,
          ]),
        ]
      : [];
    const capabilities = effectiveCapabilities(roles, BFF_SCOPES);
    let decision = decideSignIn({
      network: network.decision,
      locked: !lockout.allowed,
      rateLimited: false,
      ...(validation.ok ? { claims: validation.claims } : {}),
      roles,
      capabilities: capabilities as ReadonlySet<string>,
    });
    // Excepción temporal, solo para el demo: una identidad que QAPAQ ya autorizó (tiene al
    // menos una capacidad: dueño o miembro del grupo de admisión, o asignación del deploy)
    // entra aunque el `amr` del token no pruebe MFA/passkey. Nunca inventa evidencia de AMR
    // ni salta las comprobaciones de token, red, bloqueo o rol: la pertenencia a Accesos_SOC
    // es el control de admisión. Acotada a este despliegue (tenant/client/redirect fijos) y
    // con vencimiento obligatorio, con tope de 30 días para que no se vuelva permanente.
    const exceptionUntil = this.options.demoMfaExceptionUntil?.getTime() ?? Number.NaN;
    const demoMfaException =
      !decision.admitted &&
      (decision.reason === 'MFA_REQUIRED' || decision.reason === 'PASSKEY_REQUIRED') &&
      validation.ok &&
      capabilities.size > 0 &&
      this.options.access.redirectUri === 'https://app.jappi.net.pe/api/auth/callback' &&
      this.options.access.tenantId === '45f2f938-dbe3-4a3e-8a54-930893f94ef8' &&
      this.options.access.clientId === '336d44fe-b99d-4cfd-9c6e-0ed2d7e48998' &&
      Number.isFinite(exceptionUntil) &&
      exceptionUntil <= at.getTime() + 30 * 86_400_000 &&
      at.getTime() < exceptionUntil;
    if (demoMfaException) {
      decision = { admitted: true, requiredAmr: [] };
    }
    if (!decision.admitted) {
      await this.attempts.save(registerFailure(counter, at));
      await this.auditSignIn(
        'denied',
        subjectKey,
        correlationId,
        at,
        network.clientIp,
        decision.reason,
      );
      this.options.onSignInDenied?.({
        reason: decision.reason,
        stage: 'decision',
        correlationId,
        code: decisionDiagnostic(decision.reason, validation),
      });
      return { ok: false, failure: { reason: decision.reason, message: decision.publicMessage } };
    }
    await this.attempts.save(registerSuccess(counter, at));
    const claims = validation.ok ? validation.claims : undefined;
    const existing = await this.sessions.activeBySubject(this.tenantId, claims!.sub);
    const plan = openSession(
      {
        subjectId: claims!.sub,
        ...(claims!.oid ? { oid: claims!.oid } : {}),
        ...(claims!.name ? { displayName: claims!.name } : {}),
        ...(claims!.preferred_username ? { email: claims!.preferred_username } : {}),
        tenantId: this.tenantId,
        roles,
        scopes: [...this.options.access.scopes],
        capabilities: capabilities as ReadonlySet<Capability>,
        amr: claims!.amr ?? [],
        clientIp: network.clientIp ?? 'unknown',
        ...(claims!.sid ? { idpSessionId: claims!.sid } : {}),
      },
      existing,
      at,
    );
    // La sesión abierta con un rol temporal no debe sobrevivir al vencimiento de la asignación.
    let session = backendRole
      ? {
          ...plan.session,
          absoluteExpiresAt: new Date(
            Math.min(plan.session.absoluteExpiresAt.getTime(), backendBinding!.expiresAt.getTime()),
          ),
        }
      : plan.session;
    if (demoMfaException) {
      session = {
        ...session,
        absoluteExpiresAt: new Date(Math.min(session.absoluteExpiresAt.getTime(), exceptionUntil)),
      };
    }
    // Se revoca con la sesión que ya devolvió `activeBySubject`, no releyendo por id: el
    // store durable no conoce los ids originales (solo su hash) y `byId` solo acepta cookies.
    for (const id of plan.supersedes) {
      const previous = existing.find((candidate) => candidate.id === id);
      if (previous) {
        await this.sessions.update(revokeSession(previous, 'superseded', at), previous.revision);
      }
    }
    await this.sessions.create(session);
    await this.auditSignIn(
      'succeeded',
      claims!.sub,
      correlationId,
      at,
      network.clientIp,
      demoMfaException
        ? 'temporary_demo_mfa_exception'
        : backendRole
          ? 'backend_mvp_role_binding'
          : undefined,
    );
    return { ok: true, value: { session, supersededSessions: plan.supersedes } };
  }

  private async denied(
    reason: SignInDenialReason,
    originKey: string,
    correlationId: string,
    at: Date,
    clientIp: string | null,
    diagnostic: Pick<SignInDiagnostic, 'stage' | 'code'>,
  ): Promise<{ readonly ok: false; readonly failure: SignInFailure }> {
    this.options.onSignInDenied?.({ reason, correlationId, ...diagnostic });
    const decision = decideSignIn({
      network: reason === 'NETWORK_UNTRUSTED' ? 'untrusted_chain' : 'inside',
      locked: reason === 'LOCKED_OUT',
      rateLimited: reason === 'RATE_LIMITED',
      roles: [],
      capabilities: new Set(),
    });
    await this.auditSignIn('denied', `unknown:${originKey}`, correlationId, at, clientIp, reason);
    return {
      ok: false,
      failure: {
        reason,
        message: decision.admitted ? 'No fue posible iniciar sesión.' : decision.publicMessage,
      },
    };
  }

  private async auditSignIn(
    outcome: AuditEventDraft['outcome'],
    subjectId: string,
    correlationId: string,
    at: Date,
    clientIp: string | null,
    reason?: string,
  ): Promise<void> {
    await recordAudit(this.audit, {
      id: randomUUID(),
      tenantId: this.tenantId,
      occurredAt: at,
      actor: { id: subjectId, type: 'user', ...(clientIp ? { ip: clientIp } : {}) },
      action: 'access.sign_in',
      resource: { type: 'session', id: subjectId },
      outcome,
      correlationId,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  public async resolveActor(
    sessionId: string | undefined,
    origin: RequestOrigin,
  ): Promise<
    | { readonly ok: true; readonly actor: Actor; readonly session: Session }
    | {
        readonly ok: false;
        readonly reason: 'AUTH_REQUIRED' | 'SESSION_EXPIRED' | 'NETWORK_NOT_ALLOWED';
      }
  > {
    if (!sessionId) return { ok: false, reason: 'AUTH_REQUIRED' };
    const network = evaluateNetwork(origin, this.networkPolicy);
    if (network.decision === 'untrusted_chain') {
      return { ok: false, reason: 'NETWORK_NOT_ALLOWED' };
    }
    const stored = await this.sessions.byId(sessionId);
    const evaluation = evaluateSession(stored, this.now());
    if (!evaluation.valid) {
      return { ok: false, reason: stored ? 'SESSION_EXPIRED' : 'AUTH_REQUIRED' };
    }
    await this.sessions.update(evaluation.session, stored!.revision);
    return {
      ok: true,
      session: evaluation.session,
      actor: {
        subjectId: evaluation.session.subjectId,
        tenantId: evaluation.session.tenantId,
        sessionId: evaluation.session.id,
        capabilities: evaluation.session.capabilities,
        roles: evaluation.session.roles,
      },
    };
  }

  public async signOut(sessionId: string): Promise<void> {
    const session = await this.sessions.byId(sessionId);
    if (!session) return;
    await this.sessions.update(revokeSession(session, 'logout', this.now()), session.revision);
  }

  public static capabilitiesOf(roles: readonly string[]): ReadonlySet<Capability> {
    return capabilitiesForRoles(roles);
  }

  public static get localPrincipals(): typeof LOCAL_PRINCIPALS {
    return LOCAL_PRINCIPALS;
  }
}
