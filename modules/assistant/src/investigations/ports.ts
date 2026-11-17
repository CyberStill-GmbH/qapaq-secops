/**
 * Analista IA — puertos. El dominio no conoce PostgreSQL, el proveedor del modelo ni el API.
 *
 * Regla de fencing: toda mutación del worker presenta `WorkerLease` (`jobId` + `fencingToken`
 * del claim). Si otro worker reclamó el trabajo, o este ya no está `running`, la operación no
 * escribe y lo indica en su retorno. Un worker que perdió el lease no puede escribir nada.
 */

import type { InvestigationAction, PlannedAction } from './actions.js';
import type {
  EvidenceBundle,
  InferenceTier,
  InvestigationEvent,
  InvestigationEventDetail,
  InvestigationEventKind,
  InvestigationEvidenceSummary,
  InvestigationInference,
  InvestigationInvocation,
  InvestigationJob,
  InvestigationPriority,
  InvestigationResult,
  InvestigationStage,
  InvestigationStatus,
  InvestigationTerminalStatus,
  InvocationPhase,
  InvocationUsage,
  NewInvestigationJob,
} from './types.js';

export interface Clock {
  now(): Date;
}

export interface WorkerLease {
  readonly jobId: string;
  readonly fencingToken: number;
}

export interface InvestigationEventDraft {
  readonly at: Date;
  readonly stage: InvestigationStage;
  readonly kind: InvestigationEventKind;
  readonly detail?: InvestigationEventDetail;
}

export interface InvestigationCheckpoint {
  readonly at: Date;
  /** Etapa que pasa a estar en curso. */
  readonly stage: InvestigationStage;
  readonly inference?: InvestigationInference;
  readonly evidence?: InvestigationEvidenceSummary;
  /** Evento que se agrega en la misma transacción. */
  readonly event?: {
    readonly kind: InvestigationEventKind;
    readonly detail?: InvestigationEventDetail;
  };
}

export interface InvestigationFinish {
  readonly at: Date;
  readonly status: InvestigationTerminalStatus;
  readonly result: InvestigationResult | null;
  readonly inference: InvestigationInference;
  readonly evidence?: InvestigationEvidenceSummary | null;
  readonly errorCode?: string | null;
  /** Evento final, agregado en la misma escritura que el cierre. */
  readonly event?: InvestigationEventDraft;
}

export interface InvestigationRetryRelease {
  readonly at: Date;
  readonly availableAt: Date;
  readonly errorCode: string;
  /** Con `attempt >= maxAttempts` el trabajo queda `failed` (cuarentena). */
  readonly maxAttempts: number;
  /** Devuelve el intento (apagado ordenado del host): no cuenta para la cuarentena. */
  readonly refundAttempt?: boolean;
}

/** Resultado decidido + acciones planificadas, persistidos juntos antes de actuar. */
export interface InvestigationActionPlan {
  readonly at: Date;
  readonly status: InvestigationTerminalStatus;
  readonly result: InvestigationResult | null;
  readonly inference: InvestigationInference;
  readonly evidence?: InvestigationEvidenceSummary | null;
  readonly errorCode?: string | null;
  readonly actions: readonly PlannedAction[];
}

export interface ActionMark {
  readonly at: Date;
  readonly state: 'executed' | 'skipped' | 'failed';
  readonly ref?: InvestigationAction['ref'];
  readonly errorCode?: string | null;
}

export type HeartbeatOutcome = 'ok' | 'cancel_requested' | 'lost';
export type RetryReleaseOutcome = 'requeued' | 'quarantined' | 'cancelled' | 'stale';
/**
 * Resultado de una orden humana. `conflict`: la revisión no coincide, o `retry` sobre un trabajo
 * aún activo. `terminal`: el trabajo ya terminó (`requestCancel`) o su estado final no admite
 * reintento (`retry` sobre `completed` / `usage_unreconciled`).
 */
export type InvestigationCommandOutcome = 'ok' | 'conflict' | 'not_found' | 'terminal';

export interface InvestigationCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface InvestigationListOptions {
  readonly status?: InvestigationStatus;
  readonly cursor?: InvestigationCursor;
  /** 1–100; por defecto 25. */
  readonly pageSize?: number;
}

export interface InvestigationPage {
  readonly items: readonly InvestigationJob[];
  readonly next: InvestigationCursor | null;
}

export interface InvocationReservationRequest {
  readonly at: Date;
  readonly phase: InvocationPhase;
  /** Huella de la evidencia leída en este run. */
  readonly fingerprint: string;
  readonly tier: InferenceTier;
  readonly model: string;
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
  /** Peor caso con la tarifa vigente. */
  readonly reservedMicroUsd: number;
  readonly rateCardVersion: string;
  /** Techo diario del tenant (día UTC) en micro-USD estimados. */
  readonly dailyCeilingMicroUsd: number;
  /** Invocaciones no liberadas permitidas por trabajo. */
  readonly maxCallsPerRun: number;
}

export type InvocationReservation =
  | {
      readonly ok: true;
      readonly invocation: InvestigationInvocation;
      /**
       * `true`: la fila ya existía. Solo se despacha si `invocation.state === 'reserved'`; una
       * fila `dispatching`, `usage_unknown` o `settled` NO se vuelve a enviar al proveedor.
       */
      readonly reused: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: 'DAILY_CAP' | 'RUN_CAP' | 'CANCELLED' | 'STALE_LEASE';
    };

export type DispatchOutcome = 'ok' | 'cancelled' | 'stale';

export interface InvocationSettlement {
  readonly at: Date;
  readonly usage: InvocationUsage;
  readonly estimatedMicroUsd: number;
}

/** Totales del día UTC de un tenant. Importes estimados, no facturación. */
export interface BudgetSnapshot {
  readonly tenantId: string;
  /** `YYYY-MM-DD` (UTC). */
  readonly day: string;
  /** Techo configurado; `null` = inferencia deshabilitada. */
  readonly limitMicroUsd: number | null;
  /** Peor caso de filas `reserved` y `dispatching`. */
  readonly reservedMicroUsd: number;
  /** Estimado de filas `settled`. */
  readonly settledMicroUsd: number;
  readonly unknownCount: number;
  /** Peor caso de filas `usage_unknown` (cuenta contra el techo hasta conciliar). */
  readonly unknownMicroUsd: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  /** Trabajos terminados hoy por nivel de inferencia. */
  readonly runsToday: {
    readonly none: number;
    readonly economy: number;
    readonly advanced: number;
  };
}

export interface InvestigationStore {
  /** Idempotente por (`tenantId`, `idempotencyKey`): la segunda vez devuelve el trabajo existente. */
  enqueue(
    draft: NewInvestigationJob,
  ): Promise<{ readonly job: InvestigationJob; readonly created: boolean }>;

  /**
   * Reclama un trabajo (prioridad P1→P4 primero, luego antigüedad: un atraso grande nunca deja
   * sin atender un P1 nuevo) con semántica `FOR UPDATE SKIP LOCKED`:
   * incrementa `fencingToken` y `attempt`, recupera leases vencidos y omite los cancelados. Un
   * lease vencido con `attempt >= maxAttempts` o con cancelación pedida se cierra aquí
   * (`failed` / `usage_unreconciled` / `cancelled`) en vez de reclamarse.
   */
  claim(at: Date, leaseMs: number, maxAttempts: number): Promise<InvestigationJob | null>;

  heartbeat(lease: WorkerLease, at: Date, leaseMs: number): Promise<HeartbeatOutcome>;
  appendEvent(lease: WorkerLease, event: InvestigationEventDraft): Promise<boolean>;
  /** Cambia la etapa en curso y, opcionalmente, agrega un evento en la misma escritura. */
  checkpoint(lease: WorkerLease, checkpoint: InvestigationCheckpoint): Promise<boolean>;
  /**
   * Cierre monótono: solo desde `running` con el token vigente. Si hay cancelación pedida el
   * estado final es `cancelled` y no se guarda resultado. Devuelve el estado escrito o `null`
   * si el token es viejo.
   */
  finish(
    lease: WorkerLease,
    finish: InvestigationFinish,
  ): Promise<InvestigationTerminalStatus | null>;
  releaseForRetry(
    lease: WorkerLease,
    release: InvestigationRetryRelease,
  ): Promise<RetryReleaseOutcome>;

  /**
   * Guarda el resultado y el estado final decididos (`plannedStatus`) y registra las acciones,
   * una por (trabajo, tipo). Idempotente: una acción ya `executed` o `planned` se conserva; una
   * `failed`/`skipped` vuelve a `planned`. Devuelve el libro del trabajo o `null` si el token es
   * viejo.
   */
  planActions(
    lease: WorkerLease,
    plan: InvestigationActionPlan,
  ): Promise<readonly InvestigationAction[] | null>;
  /** `planned → executed|skipped|failed`. */
  markAction(
    lease: WorkerLease,
    kind: InvestigationAction['kind'],
    mark: ActionMark,
  ): Promise<boolean>;
  actions(tenantId: string, jobId: string): Promise<readonly InvestigationAction[]>;
  /** Acciones del tenant registradas en `[from, to)` (para el resumen de operación). */
  actionsBetween(tenantId: string, from: Date, to: Date): Promise<readonly InvestigationAction[]>;
  /** Pedidos de revisión `immediate` del tenant desde `since` (tope por hora). */
  countImmediateReviews(tenantId: string, since: Date): Promise<number>;

  /** `queued` ⇒ `cancelled` de inmediato; `running` ⇒ marca `cancelRequested`. */
  requestCancel(
    tenantId: string,
    jobId: string,
    expectedRevision: number,
    at: Date,
  ): Promise<InvestigationCommandOutcome>;
  /** Vuelve a encolar un trabajo terminado reintentable. No repite invocaciones ya liquidadas. */
  retry(
    tenantId: string,
    jobId: string,
    expectedRevision: number,
    at: Date,
  ): Promise<InvestigationCommandOutcome>;

  byId(tenantId: string, jobId: string): Promise<InvestigationJob | undefined>;
  /** Más recientes primero (`createdAt` desc, `id` desc), paginado por clave. */
  list(tenantId: string, options?: InvestigationListOptions): Promise<InvestigationPage>;
  /** Orden ascendente por `sequence`. Vacío si el trabajo es de otro tenant. */
  events(tenantId: string, jobId: string): Promise<readonly InvestigationEvent[]>;
  invocations(tenantId: string, jobId: string): Promise<readonly InvestigationInvocation[]>;

  /**
   * Trabajo más reciente del tenant (distinto de `excludeJobId`) con una invocación `settled`
   * para la misma huella de evidencia: la misma evidencia no se factura dos veces.
   */
  findPriorInference(
    tenantId: string,
    fingerprint: string,
    excludeJobId: string,
  ): Promise<InvestigationJob | undefined>;

  /**
   * Reserva atómica del peor caso ANTES del envío. Serializa por tenant, verifica el tope de
   * llamadas del run y el techo diario contando `reserved` + `dispatching` + `usage_unknown`
   * (peor caso) y `settled` (estimado). Idempotente: ver `InvocationReservation.reused`.
   */
  reserveInvocation(
    lease: WorkerLease,
    request: InvocationReservationRequest,
  ): Promise<InvocationReservation>;
  /** `reserved → dispatching`, justo antes de enviar. Se niega si hay cancelación pedida. */
  markDispatching(lease: WorkerLease, invocationId: string, at: Date): Promise<DispatchOutcome>;
  /** `dispatching → settled` con el `usage` del proveedor (también si ya se pidió cancelar). */
  settleInvocation(
    lease: WorkerLease,
    invocationId: string,
    settlement: InvocationSettlement,
  ): Promise<boolean>;
  /** `reserved|dispatching → released`: solo cuando se demuestra que no se envió. */
  releaseInvocation(lease: WorkerLease, invocationId: string, at: Date): Promise<boolean>;
  /** `dispatching → usage_unknown`: pudo llegar al proveedor; no se reintenta a ciegas. */
  markUsageUnknown(lease: WorkerLease, invocationId: string, at: Date): Promise<boolean>;

  budgetSnapshot(
    tenantId: string,
    at: Date,
    limitMicroUsd?: number | null,
  ): Promise<BudgetSnapshot>;

  // ── Panel de actividad (lecturas acotadas: conteos agregados, nunca contenido) ──────────

  /** Cola actual del tenant y trabajos terminados en `[from, to)` por nivel y estado. */
  activityCounts(tenantId: string, from: Date, to: Date): Promise<InvestigationActivityCounts>;
  /**
   * Trabajos `running` y los terminados desde `since`, actividad más reciente primero
   * (`finishedAt`, si no `startedAt`); a lo sumo `limit` (1–100).
   */
  recentJobs(tenantId: string, since: Date, limit: number): Promise<readonly InvestigationJob[]>;
  /**
   * Escalaciones ejecutadas en `[from, to)` con su disposición (incidente nuevo o adjuntado),
   * tal como la dejó el runner en la bitácora; a lo sumo 1000, más recientes primero.
   */
  escalationOutcomes(tenantId: string, from: Date, to: Date): Promise<readonly EscalationOutcome[]>;
  /** Cuáles de estas claves de idempotencia ya tienen trabajo en el tenant (a lo sumo 2000). */
  existingKeys(tenantId: string, keys: readonly string[]): Promise<ReadonlySet<string>>;
}

export const ACTIVITY_LIMITS = Object.freeze({
  recentJobs: 100,
  escalationOutcomes: 1_000,
  existingKeys: 2_000,
});

/** Cola en este instante: no depende de ninguna ventana. */
export interface InvestigationQueueSnapshot {
  readonly queued: number;
  readonly running: number;
  /** `createdAt` del trabajo `queued` más antiguo; `null` sin cola. */
  readonly oldestQueuedAt: Date | null;
  /** Trabajos `queued` por prioridad. */
  readonly byPriority: Readonly<Record<InvestigationPriority, number>>;
}

export interface InvestigationActivityCounts {
  readonly queue: InvestigationQueueSnapshot;
  /** Trabajos con `finishedAt` en `[from, to)`. */
  readonly finished: {
    readonly total: number;
    readonly byInference: {
      readonly none: number;
      readonly economy: number;
      readonly advanced: number;
    };
    readonly byStatus: Readonly<Partial<Record<InvestigationStatus, number>>>;
  };
  /** Estimado de las invocaciones `settled` creadas en `[from, to)`. No es facturación. */
  readonly settledMicroUsd: number;
}

export interface EscalationOutcome {
  readonly jobId: string;
  readonly at: Date;
  readonly disposition: 'created' | 'attached';
}

/** Lector de evidencia (lo implementa el API con rutas allowlisted y alcance del tenant). */
export interface EvidenceReader {
  collect(job: InvestigationJob, signal: AbortSignal): Promise<EvidenceBundle>;
}

/**
 * El adaptador del modelo la lanza SOLO cuando se demuestra que el proveedor no procesó la
 * solicitud (fallo antes del envío o rechazo explícito sin `usage`). Cualquier otro error se
 * trata como ambiguo: la reserva queda `usage_unknown` y no se reintenta.
 */
export class InferenceNotSentError extends Error {
  public constructor(public readonly code: string = 'MODEL_NOT_SENT') {
    super(code);
    this.name = 'InferenceNotSentError';
  }
}

/** Inicio (inclusive) del día UTC de `at`; el techo diario se cuenta en esa ventana. */
export function utcDayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}
