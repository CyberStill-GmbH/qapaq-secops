/**
 * Host del Analista IA dentro del proceso API (docs/27, «Implementación 2026-11-14»).
 *
 * El runner del dominio (`InvestigationRunner`) es agnóstico del host; aquí solo se compone:
 *
 * - **Trabajo**: `concurrency` bucles estilo `NotificationDispatcher` (intervalo + `kick`); cada
 *   pasada procesa trabajos hasta quedar `idle`. El claim con lease/fencing del store permite
 *   varias réplicas sin coordinación adicional.
 * - **Encolado**: tras el commit de una alerta nueva (`alertCreated`, nunca dentro de la
 *   transacción; un fallo solo se registra), y un barrido periódico del atraso (alertas abiertas
 *   sin trabajo, P1 primero, lote chico) para drenar la cola existente.
 * - **Resumen diario**: a la hora de Lima de los ajustes, una vez por día (clave por fecha), por
 *   la vía de notificación existente.
 * - **Apagado**: `stop()` aborta la señal del host (el runner devuelve el intento sin contarlo) y
 *   espera las pasadas en curso.
 *
 * Los registros estructurados llevan códigos, etapas e ids; nunca prompts ni evidencia.
 * Sin `QAPAQ_ANALYST_ENABLED=true` no arranca ningún bucle, pero la fachada sigue sirviendo la
 * lista, el presupuesto y los ajustes a la consola.
 */

import { randomUUID } from 'node:crypto';

import {
  buildDigest,
  DEFAULT_ANALYST_SETTINGS,
  fingerprintOf,
  InvestigationRunner,
  POLICY_VERSION,
  utcDayStart,
  type AnalystSettings,
  type AnalystSettingsStore,
  type EvidenceReader,
  type InvestigationCursor,
  type InvestigationJob,
  type InvestigationPriority,
  type InvestigationRunnerOptions,
  type InvestigationSource,
  type InvestigationStore,
  type OperationsDigest,
  type SocActions,
  type StoredAnalystSettings,
} from '@qapaq/assistant';
import type { Alert, SocReadModel } from '@qapaq/soc';
import type { AnalystDigestInput, DigestLine } from '@qapaq/soar';

import type { AnalystConfig } from '../assistant/analyst-config.js';
import { EVIDENCE_LIMITS } from '../assistant/analyst-evidence.js';
import { NotificationDispatcher } from './notification-dispatcher.js';

/** Autor de las notas del analista (marca durable del barrido de incidentes). */
const ANALYST_ACTOR = 'svc:qapaq-ai-analyst';

/** Lima no tiene horario de verano: UTC−5 fijo. */
export const LIMA_OFFSET_MS = 5 * 3_600_000;
const PRIORITY_ORDER: readonly InvestigationPriority[] = ['P1', 'P2', 'P3', 'P4'];

export const ANALYST_RUNNER_LIMITS = Object.freeze({
  // La recolección pagina hasta agotar la evidencia de la entidad: más plazo que una muestra.
  leaseMs: 240_000,
  heartbeatMs: 20_000,
  maxAttempts: 3,
  /** Paquete al modelo: muestra amplia + agregados completos. El techo diario sigue mandando. */
  maxInputTokens: 24_000,
  /** Techo del despliegue; los ajustes acotan 200–4000 y la política por nivel. */
  maxOutputTokens: 4_000,
  deadlineMs: 180_000,
});

export const ANALYST_HOST_DEFAULTS = Object.freeze({
  workIntervalMs: 15_000,
  sweepIntervalMs: 5 * 60_000,
  digestIntervalMs: 5 * 60_000,
  /**
   * Trabajos nuevos por pasada del barrido del atraso (cada 5 min). Tras una versión nueva de la
   * política, las alertas abiertas se reinvestigan con ella (P1 primero) a este ritmo.
   */
  sweepBatch: 25,
  /** Incidentes abiertos sin expediente del analista documentados por pasada. */
  incidentSweepBatch: 5,
  /** Trabajos leídos como máximo para un resumen (20 páginas de 100). */
  digestJobScan: 2_000,
  digestLookbackMs: 7 * 86_400_000,
});

export type AnalystLog = (
  event: string,
  fields: Readonly<Record<string, string | number | boolean>>,
) => void;

export interface AnalystHostOptions {
  readonly tenantId: string;
  readonly config: AnalystConfig;
  readonly store: InvestigationStore;
  /** Ajustes tal como los guarda la consola (sin recortar al techo del despliegue). */
  readonly settings: AnalystSettingsStore;
  readonly evidence: EvidenceReader;
  readonly actions: SocActions;
  readonly models: InvestigationRunnerOptions['models'];
  readonly soc: Pick<SocReadModel, 'listAlerts'> &
    Partial<Pick<SocReadModel, 'listIncidents' | 'listIncidentAlerts' | 'listIncidentNotes'>>;
  readonly clock: () => Date;
  readonly consoleBaseUrl: string;
  /** Envía el resumen diario por la vía de notificación (idempotente por fecha). */
  readonly sendDigest?: (input: AnalystDigestInput) => Promise<void>;
  readonly log?: AnalystLog;
  readonly intervals?: Partial<
    Pick<typeof ANALYST_HOST_DEFAULTS, 'workIntervalMs' | 'sweepIntervalMs' | 'digestIntervalMs'>
  >;
  /** Solo pruebas: espera entre reintentos del runner. */
  readonly retryDelayMs?: (attempt: number) => number;
}

/**
 * Estado del host EN ESTE PROCESO (memoria, se pierde al reiniciar; con varias réplicas cada una
 * informa el suyo). Solo lectura: lo consume `GET /api/ai-investigations/activity`.
 */
export interface AnalystHostStatus {
  /** `QAPAQ_ANALYST_ENABLED` del despliegue. */
  readonly enabled: boolean;
  /** Bucles iniciados y no detenidos. */
  readonly running: boolean;
  /** Última pasada de un worker (haya o no trabajo). */
  readonly lastTickAt: Date | null;
  /** Último trabajo que un worker terminó de procesar. */
  readonly lastProcessedAt: Date | null;
  /** Pasadas del runner en curso ahora. */
  readonly inFlight: number;
  readonly concurrency: number;
  /** Código del fallo más reciente aún no superado (worker, barrido o resumen); nunca mensajes. */
  readonly lastErrorCode: string | null;
}

export interface AnalystBacklog {
  /** `null`: sin dato (lectura incompleta o fallida). */
  readonly openAlertsWithoutCaseFile: number | null;
  readonly openIncidentsWithoutCaseFile: number | null;
}

/** Tope de alertas/incidentes leídos para el atraso y su vigencia en memoria. */
export const ANALYST_BACKLOG_LIMITS = Object.freeze({
  maxAlerts: 2_000,
  maxIncidentNoteReads: 200,
  cacheMs: 60_000,
});

const INCIDENT_SWEEP_STATUSES = ['open', 'contained', 'eradicated', 'resolved'] as const;

/** Ajustes efectivos para el runner: el techo diario nunca supera el del despliegue. */
export function clampSettings(settings: AnalystSettings, deploymentCeiling: number | null): AnalystSettings {
  const ceiling = settings.budget.dailyCeilingMicroUsd;
  const effective =
    deploymentCeiling === null || ceiling === null ? null : Math.min(ceiling, deploymentCeiling);
  return effective === ceiling
    ? settings
    : { ...settings, budget: { ...settings.budget, dailyCeilingMicroUsd: effective } };
}

class ClampedSettingsStore implements AnalystSettingsStore {
  public constructor(
    private readonly inner: AnalystSettingsStore,
    private readonly ceiling: number | null,
  ) {}

  public async get(tenantId: string): Promise<StoredAnalystSettings | undefined> {
    const stored = await this.inner.get(tenantId);
    return stored ? { ...stored, settings: clampSettings(stored.settings, this.ceiling) } : undefined;
  }

  public put(
    tenantId: string,
    settings: AnalystSettings,
    expectedRevision: number,
    by: string,
    at: Date,
  ): Promise<'ok' | 'conflict'> {
    return this.inner.put(tenantId, settings, expectedRevision, by, at);
  }
}

/** Instante UTC del inicio del día local de Lima `AAAA-MM-DD`. */
export function limaDayStart(day: string): Date {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + LIMA_OFFSET_MS);
}

/** Día local de Lima (`AAAA-MM-DD`) y hora (0–23) de un instante. */
export function limaClock(at: Date): { readonly day: string; readonly hour: number } {
  const local = new Date(at.getTime() - LIMA_OFFSET_MS);
  return { day: local.toISOString().slice(0, 10), hour: local.getUTCHours() };
}

export class AnalystHost {
  public readonly store: InvestigationStore;
  public readonly settingsStore: AnalystSettingsStore;
  private readonly runner: InvestigationRunner;
  private readonly abort = new AbortController();
  private readonly workers: NotificationDispatcher[] = [];
  private readonly sweeper: NotificationDispatcher | undefined;
  private readonly digester: NotificationDispatcher | undefined;
  /** Alertas que ya tienen trabajo del sistema (evita releer el store en cada barrido). */
  private readonly known = new Set<string>();
  /** Incidentes con expediente (nota del analista) o con trabajo ya encolado. */
  private readonly documented = new Set<string>();
  // Estado en memoria de este proceso (`status()`).
  private started = false;
  private stopped = false;
  private lastTickAt: Date | null = null;
  private lastProcessedAt: Date | null = null;
  private inFlight = 0;
  /** Fallo vigente por componente; el orden de inserción da el más reciente. */
  private readonly failures = new Map<'worker' | 'sweep' | 'digest', string>();
  private backlogCache: { readonly at: number; readonly value: Promise<AnalystBacklog> } | undefined;

  public constructor(private readonly options: AnalystHostOptions) {
    this.store = options.store;
    this.settingsStore = options.settings;
    const intervals = { ...ANALYST_HOST_DEFAULTS, ...options.intervals };
    this.runner = new InvestigationRunner({
      store: options.store,
      evidence: options.evidence,
      models: options.models,
      rateCard: options.config.rateCard,
      limits: {
        ...ANALYST_RUNNER_LIMITS,
        dailyCeilingMicroUsd: options.config.dailyCeilingMicroUsd,
      },
      clock: { now: options.clock },
      settings: new ClampedSettingsStore(options.settings, options.config.dailyCeilingMicroUsd),
      actions: options.actions,
      ...(options.retryDelayMs ? { retryDelayMs: options.retryDelayMs } : {}),
      onEvent: (event) => {
        // Solo etapa, tipo e ids: ni detalle libre ni evidencia.
        if (event.kind === 'failed' || (event.stage === 'writing' && event.kind === 'completed')) {
          this.log('analyst.run.event', {
            jobId: event.jobId,
            stage: event.stage,
            kind: event.kind,
            ...(typeof event.detail['status'] === 'string' ? { status: event.detail['status'] } : {}),
            ...(typeof event.detail['code'] === 'string' ? { code: event.detail['code'] } : {}),
          });
        }
      },
    });
    if (!options.config.enabled) return;
    for (let slot = 0; slot < options.config.concurrency; slot += 1) {
      this.workers.push(
        new NotificationDispatcher({
          drain: async () => ((await this.pass()) === 'processed' ? 1 : 0),
          intervalMs: intervals.workIntervalMs,
          errorIntervalMs: Math.max(intervals.workIntervalMs, 60_000),
          onError: () => this.log('analyst.worker.failed', { code: 'RUNNER_FAILED' }),
        }),
      );
    }
    this.sweeper = options.config.backlogSweep
      ? new NotificationDispatcher({
          drain: async () => {
            const created = (await this.sweepBacklog()) + (await this.sweepIncidents());
            this.failures.delete('sweep');
            if (created > 0) this.kick();
            return 0;
          },
          intervalMs: intervals.sweepIntervalMs,
          onError: () => {
            this.fail('sweep', 'SWEEP_FAILED');
            this.log('analyst.sweep.failed', { code: 'SWEEP_FAILED' });
          },
        })
      : undefined;
    this.digester = options.sendDigest
      ? new NotificationDispatcher({
          drain: async () => {
            await this.runDailyDigest();
            this.failures.delete('digest');
            return 0;
          },
          intervalMs: intervals.digestIntervalMs,
          onError: () => {
            this.fail('digest', 'DIGEST_FAILED');
            this.log('analyst.digest.failed', { code: 'DIGEST_FAILED' });
          },
        })
      : undefined;
  }

  /** Bucle activo en este proceso (`QAPAQ_ANALYST_ENABLED`). */
  public get enabled(): boolean {
    return this.options.config.enabled;
  }

  public get config(): AnalystConfig {
    return this.options.config;
  }

  private log(event: string, fields: Readonly<Record<string, string | number | boolean>>): void {
    try {
      this.options.log?.(event, fields);
    } catch {
      // Un registro que falla no detiene al analista.
    }
  }

  /** Ajustes guardados (o los de fábrica) tal como los ve la consola. */
  public async currentSettings(): Promise<{
    readonly stored: StoredAnalystSettings | undefined;
    readonly settings: AnalystSettings;
  }> {
    const stored = await this.options.settings.get(this.options.tenantId);
    return { stored, settings: stored?.settings ?? DEFAULT_ANALYST_SETTINGS };
  }

  /** Techo diario efectivo (ajustes recortados al despliegue); `null` = sin inferencia. */
  public effectiveCeiling(settings: AnalystSettings): number | null {
    if (!settings.enabled) return null;
    return clampSettings(settings, this.options.config.dailyCeilingMicroUsd).budget
      .dailyCeilingMicroUsd;
  }

  /** Encola (idempotente) una investigación para una alerta del tenant. */
  public async enqueueAlert(
    alert: Alert,
    input: {
      readonly source: InvestigationSource;
      readonly initiatedBy?: string;
      /** Clave propia (p. ej. `incident:<id>` del barrido de incidentes). */
      readonly idempotencyKey?: string;
    },
  ): Promise<{ readonly job: InvestigationJob; readonly created: boolean }> {
    if (alert.tenantId !== this.options.tenantId) throw new Error('ANALYST_TENANT_MISMATCH');
    const manual = input.source === 'manual';
    const result = await this.store.enqueue({
      id: randomUUID(),
      tenantId: alert.tenantId,
      subject: { kind: 'alert', id: alert.id, title: alert.title, ruleId: alert.ruleId },
      alertIds: [alert.id],
      priority: PRIORITY_ORDER.includes(alert.priority as InvestigationPriority)
        ? (alert.priority as InvestigationPriority)
        : 'P4',
      trigger: manual ? 'user' : 'system',
      source: input.source,
      initiatedBy: manual ? (input.initiatedBy ?? null) : null,
      // Sistema: un trabajo por alerta y versión de la política (una política mejor reinvestiga
      // lo que sigue abierto). Persona: uno por revisión de la alerta (repetir el pedido sobre la
      // misma alerta sin cambios reutiliza el trabajo).
      idempotencyKey:
        input.idempotencyKey ??
        (manual ? `manual:${alert.id}:${alert.revision}` : `alert:${alert.id}:${POLICY_VERSION}`),
      fingerprint: fingerprintOf(
        alert.tenantId,
        [alert.id],
        `${alert.id}:${alert.revision}:${alert.updatedAt.toISOString()}`,
        POLICY_VERSION,
      ),
      policyVersion: POLICY_VERSION,
      createdAt: this.options.clock(),
    });
    if (!manual && input.idempotencyKey === undefined) this.known.add(alert.id);
    if (result.created) {
      this.log('analyst.job.enqueued', {
        jobId: result.job.id,
        source: input.source,
        priority: result.job.priority,
      });
      this.kick();
    }
    return result;
  }

  /** ¿Debe el sistema investigar esta alerta? Ajustes activos y prioridad en alcance. */
  private async accepts(alert: Alert): Promise<boolean> {
    if (!this.enabled) return false;
    const { settings } = await this.currentSettings();
    return (
      settings.enabled &&
      settings.scope.priorities.includes(alert.priority as InvestigationPriority)
    );
  }

  /**
   * Gancho posterior al commit de una alerta nueva. Nunca lanza ni bloquea a quien lo llama: un
   * fallo se registra y el barrido del atraso la recoge después.
   */
  public alertCreated(alert: Alert): void {
    if (!this.enabled) return;
    void (async () => {
      if (await this.accepts(alert)) await this.enqueueAlert(alert, { source: 'new_alert' });
    })().catch(() => this.log('analyst.enqueue.failed', { code: 'ENQUEUE_FAILED' }));
  }

  /** Alertas abiertas sin trabajo, P1 primero; a lo sumo `sweepBatch` trabajos nuevos. */
  public async sweepBacklog(): Promise<number> {
    if (!this.enabled || !this.options.config.backlogSweep) return 0;
    const { settings } = await this.currentSettings();
    if (!settings.enabled) return 0;
    let created = 0;
    const eligible: Alert[] = [];
    for (const priority of PRIORITY_ORDER) {
      if (!settings.scope.priorities.includes(priority)) continue;
      const page = await this.options.soc.listAlerts({
        tenantId: this.options.tenantId,
        status: 'open',
        priority,
      });
      eligible.push(...page.items.filter((alert) => alert.tenantId === this.options.tenantId));
    }
    const group = (alert: Alert) =>
      alert.ruleId?.startsWith('qapaq-correlator:') === true &&
      alert.relatedAlertIds.length > 0 &&
      alert.relatedAlertIds.length <= EVIDENCE_LIMITS.maxRelatedAlerts;
    // Within a priority, enqueue the Go case first. Its evidence reader includes the members.
    const pending = eligible.sort((left, right) =>
      PRIORITY_ORDER.indexOf(left.priority) - PRIORITY_ORDER.indexOf(right.priority) ||
      Number(group(right)) - Number(group(left)) ||
      left.createdAt.getTime() - right.createdAt.getTime(),
    );
    const covered = new Map<string, InvestigationJob>();
    for (const alert of pending) {
        if (this.abort.signal.aborted) return created;
        const parent = covered.get(alert.id);
        // New evidence or a P1 always gets its own immediate path. Never suppress source alerts.
        if (parent && alert.priority !== 'P1' && alert.updatedAt <= parent.createdAt) continue;
        if (this.known.has(alert.id) && !group(alert)) continue;
        const result = await this.enqueueAlert(alert, { source: 'backlog' });
        if (group(alert) && ['queued', 'running', 'completed', 'requires_review'].includes(result.job.status)) {
          for (const memberId of alert.relatedAlertIds) covered.set(memberId, result.job);
        }
        if (result.created) created += 1;
        if (created >= ANALYST_HOST_DEFAULTS.sweepBatch) return created;
    }
    if (created > 0) this.log('analyst.sweep.completed', { created });
    return created;
  }

  /**
   * Incidentes ABIERTOS sin expediente del analista (ninguna nota de `svc:qapaq-ai-analyst`):
   * los más graves y antiguos primero, en lote chico. Encola un trabajo (`backlog`, clave
   * `incident:<id>`) sobre la alerta de mayor prioridad del incidente; al terminar, el informe se
   * adjunta como nota del incidente y, según los ajustes, se pide revisión humana. Nunca cierra
   * ni cambia el estado del incidente: solo documenta y recomienda. La nota es la marca durable:
   * tras un reinicio, un incidente ya documentado no se vuelve a encolar.
   */
  public async sweepIncidents(): Promise<number> {
    const soc = this.options.soc;
    if (!this.enabled || !this.options.config.backlogSweep) return 0;
    if (!soc.listIncidents || !soc.listIncidentAlerts || !soc.listIncidentNotes) return 0;
    const { settings } = await this.currentSettings();
    if (!settings.enabled) return 0;
    const severityRank: Readonly<Record<string, number>> = { critical: 0, high: 1, medium: 2, low: 3 };
    const page = await soc.listIncidents({
      tenantId: this.options.tenantId,
      statuses: [...INCIDENT_SWEEP_STATUSES],
    });
    const pending = [...page.items]
      .filter((incident) => incident.tenantId === this.options.tenantId)
      .filter((incident) => !this.documented.has(incident.id))
      .sort(
        (left, right) =>
          (severityRank[left.severity] ?? 9) - (severityRank[right.severity] ?? 9) ||
          left.openedAt.getTime() - right.openedAt.getTime(),
      );
    let created = 0;
    for (const incident of pending) {
      if (this.abort.signal.aborted || created >= ANALYST_HOST_DEFAULTS.incidentSweepBatch) break;
      const notes = await soc.listIncidentNotes(this.options.tenantId, incident.id);
      if (notes.some((note) => note.authorId === ANALYST_ACTOR)) {
        this.documented.add(incident.id);
        continue;
      }
      const alerts = await soc.listIncidentAlerts(this.options.tenantId, incident.id, 50);
      const target = [...alerts.items]
        .filter((alert) => alert.incidentId === incident.id)
        .sort(
          (left, right) =>
            PRIORITY_ORDER.indexOf(left.priority as InvestigationPriority) -
              PRIORITY_ORDER.indexOf(right.priority as InvestigationPriority) ||
            left.createdAt.getTime() - right.createdAt.getTime(),
        )[0];
      if (!target) continue;
      const result = await this.enqueueAlert(target, {
        source: 'backlog',
        idempotencyKey: `incident:${incident.id}`,
      });
      // El trabajo ya existía: queda a la espera de su nota sin volver a contarlo.
      if (!result.created) this.documented.add(incident.id);
      else created += 1;
    }
    if (created > 0) this.log('analyst.incident_sweep.completed', { created });
    return created;
  }

  /** Expedientes y acciones de `[from, to)` en un resumen determinista (sin modelo). */
  public async buildDigest(from: Date, to: Date): Promise<OperationsDigest> {
    const tenantId = this.options.tenantId;
    const jobs: InvestigationJob[] = [];
    const lookback = from.getTime() - ANALYST_HOST_DEFAULTS.digestLookbackMs;
    let cursor: InvestigationCursor | undefined;
    while (jobs.length < ANALYST_HOST_DEFAULTS.digestJobScan) {
      const page = await this.store.list(tenantId, {
        pageSize: 100,
        ...(cursor ? { cursor } : {}),
      });
      jobs.push(...page.items);
      const last = page.items.at(-1);
      if (!page.next || !last || last.createdAt.getTime() < lookback) break;
      cursor = page.next;
    }
    const actions = await this.store.actionsBetween(tenantId, from, to);
    let estimatedMicroUsd = 0;
    for (
      let day = utcDayStart(from).getTime();
      day < to.getTime() && day - from.getTime() < 32 * 86_400_000;
      day += 86_400_000
    ) {
      const snapshot = await this.store.budgetSnapshot(tenantId, new Date(day));
      estimatedMicroUsd += snapshot.settledMicroUsd;
    }
    return buildDigest(jobs, actions, from, to, { estimatedMicroUsd });
  }

  /** Resumen diario a la hora de Lima configurada; una vez por día (idempotente por fecha). */
  public async runDailyDigest(): Promise<boolean> {
    if (!this.enabled || !this.options.sendDigest) return false;
    const { settings } = await this.currentSettings();
    if (!settings.enabled || settings.reports.digest !== 'daily') return false;
    const now = this.options.clock();
    const { day, hour } = limaClock(now);
    if (hour < settings.reports.digestHourLima) return false;
    const to = new Date(limaDayStart(day).getTime() + settings.reports.digestHourLima * 3_600_000);
    const from = new Date(to.getTime() - 86_400_000);
    const digest = await this.buildDigest(from, to);
    const base = this.options.consoleBaseUrl.replace(/\/+$/u, '');
    const lines: DigestLine[] = digest.pendingReview.slice(0, 50).map((item) => ({
      title: item.title.slice(0, 200),
      priority: item.priority,
      source: 'Analista IA',
      count: 1,
      firstSeen: from.toISOString(),
      lastSeen: to.toISOString(),
      url: `${base}/app/qapaq-ai-analyst?id=${encodeURIComponent(item.jobId)}`,
      reason: item.reason,
    }));
    await this.options.sendDigest({
      date: day,
      from,
      to,
      lines,
      total: digest.pendingReview.length,
    });
    return true;
  }

  /** Una pasada del runner (pruebas y drenado manual). */
  public runOnce(): Promise<'idle' | 'processed'> {
    return this.pass();
  }

  /** Pasada del runner con el estado en memoria al día (`status()`). */
  private async pass(): Promise<'idle' | 'processed'> {
    this.lastTickAt = this.options.clock();
    this.inFlight += 1;
    try {
      const outcome = await this.runner.runOnce(this.abort.signal);
      this.failures.delete('worker');
      if (outcome === 'processed') this.lastProcessedAt = this.options.clock();
      return outcome;
    } catch (error) {
      this.fail('worker', 'RUNNER_FAILED');
      throw error;
    } finally {
      this.inFlight -= 1;
    }
  }

  private fail(component: 'worker' | 'sweep' | 'digest', code: string): void {
    this.failures.delete(component);
    this.failures.set(component, code);
  }

  /** Foto de solo lectura del host en este proceso. */
  public status(): AnalystHostStatus {
    const codes = [...this.failures.values()];
    return {
      enabled: this.enabled,
      running: this.enabled && this.started && !this.stopped,
      lastTickAt: this.lastTickAt,
      lastProcessedAt: this.lastProcessedAt,
      inFlight: this.inFlight,
      concurrency: this.options.config.concurrency,
      lastErrorCode: codes.length > 0 ? codes[codes.length - 1]! : null,
    };
  }

  /**
   * Atraso sin expediente (vigencia `cacheMs`, una lectura a la vez): alertas abiertas sin trabajo
   * del sistema (`alert:<id>`) e incidentes abiertos sin trabajo (`incident:<id>`) ni nota del
   * analista. Lectura incompleta (más filas que el tope) o fallida ⇒ `null`, nunca un número parcial.
   */
  public backlog(): Promise<AnalystBacklog> {
    const now = Date.now();
    if (this.backlogCache && now - this.backlogCache.at < ANALYST_BACKLOG_LIMITS.cacheMs) {
      return this.backlogCache.value;
    }
    const value = Promise.all([
      this.alertsWithoutCaseFile().catch(() => {
        this.log('analyst.backlog.failed', { code: 'BACKLOG_ALERTS_FAILED' });
        return null;
      }),
      this.incidentsWithoutCaseFile().catch(() => {
        this.log('analyst.backlog.failed', { code: 'BACKLOG_INCIDENTS_FAILED' });
        return null;
      }),
    ]).then(([openAlertsWithoutCaseFile, openIncidentsWithoutCaseFile]) => ({
      openAlertsWithoutCaseFile,
      openIncidentsWithoutCaseFile,
    }));
    this.backlogCache = { at: now, value };
    return value;
  }

  private async alertsWithoutCaseFile(): Promise<number | null> {
    const page = await this.options.soc.listAlerts({ tenantId: this.options.tenantId, status: 'open' });
    const items = page.items.filter((alert) => alert.tenantId === this.options.tenantId);
    if (items.length < page.total || items.length > ANALYST_BACKLOG_LIMITS.maxAlerts) return null;
    if (items.length === 0) return 0;
    // Clave del sistema con la versión vigente: una alerta investigada con una política anterior
    // cuenta como pendiente (el barrido la reinvestiga).
    const keyOf = (alert: Alert) => `alert:${alert.id}:${POLICY_VERSION}`;
    const found = await this.store.existingKeys(this.options.tenantId, items.map(keyOf));
    return items.filter((alert) => !found.has(keyOf(alert))).length;
  }

  private async incidentsWithoutCaseFile(): Promise<number | null> {
    const soc = this.options.soc;
    if (!soc.listIncidents || !soc.listIncidentNotes) return null;
    const page = await soc.listIncidents({
      tenantId: this.options.tenantId,
      statuses: [...INCIDENT_SWEEP_STATUSES],
    });
    const items = page.items.filter((incident) => incident.tenantId === this.options.tenantId);
    if (items.length < page.total || items.length > ANALYST_BACKLOG_LIMITS.maxAlerts) return null;
    if (items.length === 0) return 0;
    const found = await this.store.existingKeys(
      this.options.tenantId,
      items.map((incident) => `incident:${incident.id}`),
    );
    const pending = items.filter(
      (incident) => !found.has(`incident:${incident.id}`) && !this.documented.has(incident.id),
    );
    // La nota del analista es la marca durable (p. ej. un incidente creado por una escalación).
    if (pending.length > ANALYST_BACKLOG_LIMITS.maxIncidentNoteReads) return null;
    let without = 0;
    for (const incident of pending) {
      const notes = await soc.listIncidentNotes(this.options.tenantId, incident.id);
      if (notes.some((note) => note.authorId === ANALYST_ACTOR)) this.documented.add(incident.id);
      else without += 1;
    }
    return without;
  }

  public kick(): void {
    for (const worker of this.workers) worker.kick();
  }

  public start(): void {
    if (!this.enabled) return;
    this.started = true;
    for (const worker of this.workers) worker.start();
    this.sweeper?.start();
    this.digester?.start();
    this.log('analyst.started', {
      concurrency: this.workers.length,
      backlogSweep: this.sweeper !== undefined,
      inference: this.options.config.dailyCeilingMicroUsd !== null,
    });
  }

  /** Aborta el trabajo en curso (el intento se devuelve) y espera las pasadas. */
  public async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await Promise.all([
      ...this.workers.map((worker) => worker.stop()),
      this.sweeper?.stop(),
      this.digester?.stop(),
    ]);
  }
}
