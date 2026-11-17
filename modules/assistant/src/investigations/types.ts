/**
 * Analista IA — tipos del dominio de investigaciones en segundo plano (shadow mode).
 *
 * Una investigación nunca cierra alertas, cambia severidad ni notifica: produce un expediente
 * (`InvestigationResult`) que una persona revisa. Los tipos de este archivo son el contrato con
 * el API, la consola y el host del worker; cambiarlos exige versionar `POLICY_VERSION`.
 */

import type { Citation } from '../ports.js';

export const INVESTIGATION_PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type InvestigationPriority = (typeof INVESTIGATION_PRIORITIES)[number];

export const INVESTIGATION_STATUSES = [
  'queued',
  'running',
  'completed',
  'requires_review',
  'partial',
  'budget_exhausted',
  'usage_unreconciled',
  'cancelled',
  'failed',
] as const;
export type InvestigationStatus = (typeof INVESTIGATION_STATUSES)[number];

/** Estados finales: solo `retry` (decisión humana) reabre un trabajo que llegó a uno de ellos. */
export const INVESTIGATION_TERMINAL_STATUSES = [
  'completed',
  'requires_review',
  'partial',
  'budget_exhausted',
  'usage_unreconciled',
  'cancelled',
  'failed',
] as const;
export type InvestigationTerminalStatus = (typeof INVESTIGATION_TERMINAL_STATUSES)[number];

/** Estados finales que `retry` puede volver a encolar. `completed` y `usage_unreconciled` no. */
export const INVESTIGATION_RETRYABLE_STATUSES: readonly InvestigationStatus[] = [
  'requires_review',
  'partial',
  'budget_exhausted',
  'cancelled',
  'failed',
];

export const INVESTIGATION_STAGES = [
  'fetching_evidence',
  'triage',
  'model',
  'validating',
  'writing',
  'acting',
] as const;
export type InvestigationStage = (typeof INVESTIGATION_STAGES)[number];

export const INFERENCE_TIERS = ['economy', 'advanced'] as const;
/** Nivel de modelo. Lo elige la política versionada, nunca el modelo ni el texto de la alerta. */
export type InferenceTier = (typeof INFERENCE_TIERS)[number];
/** `none`: el expediente se resolvió sin llamar a ningún modelo. */
export type InvestigationInference = 'none' | InferenceTier;

export const INVESTIGATION_TRIGGERS = ['system', 'user'] as const;
export type InvestigationTrigger = (typeof INVESTIGATION_TRIGGERS)[number];

/** Origen del trabajo: alerta nueva, barrido del atraso (más antiguas primero) o pedido manual. */
export const INVESTIGATION_SOURCES = ['new_alert', 'backlog', 'manual'] as const;
export type InvestigationSource = (typeof INVESTIGATION_SOURCES)[number];

export interface InvestigationSubject {
  readonly kind: 'alert' | 'candidate';
  readonly id: string;
  readonly title: string;
  /** Regla de origen (para agrupar pedidos de revisión y el resumen por regla). */
  readonly ruleId?: string | null;
}

/** Resumen de la evidencia leída (conteos y cobertura; nunca contenido). */
export interface InvestigationEvidenceSummary {
  readonly alertCount: number;
  readonly relatedAlertCount: number;
  readonly eventCount: number;
  readonly sourceCount: number;
  /** Fuentes no frescas o en estado no sano al leer. */
  readonly unhealthySourceCount: number;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly gaps: readonly string[];
  readonly watermark: string;
  /** Huella de la evidencia leída (`fingerprintOf` con el watermark de la lectura). */
  readonly fingerprint: string;
  /** Tokens de entrada estimados del paquete enviado; `null` si no se armó paquete. */
  readonly estimatedInputTokens: number | null;
  /** El paquete enviado al modelo omitió ejemplares para caber en el presupuesto. */
  readonly packTruncated: boolean;
}

export interface InvestigationJob {
  readonly id: string;
  readonly tenantId: string;
  readonly subject: InvestigationSubject;
  readonly alertIds: readonly string[];
  readonly priority: InvestigationPriority;
  readonly trigger: InvestigationTrigger;
  /** `new_alert` | `backlog` para `trigger: 'system'`; `manual` para `trigger: 'user'`. */
  readonly source: InvestigationSource;
  /** Persona que la pidió (`trigger: 'user'`); `null` para el sistema. */
  readonly initiatedBy: string | null;
  readonly idempotencyKey: string;
  /** Huella de la evidencia conocida al encolar. */
  readonly fingerprint: string;
  readonly policyVersion: string;
  readonly status: InvestigationStatus;
  /** Etapa en curso; `null` cuando el trabajo no está `running`. */
  readonly stage: InvestigationStage | null;
  /** Nivel realmente despachado; `null` hasta que se decide. */
  readonly inference: InvestigationInference | null;
  /** Veces que un worker lo reclamó. */
  readonly attempt: number;
  readonly availableAt: Date;
  readonly leaseUntil: Date | null;
  /** Crece en cada claim. Toda escritura del worker lo presenta; uno viejo no escribe. */
  readonly fencingToken: number;
  readonly cancelRequested: boolean;
  /** Código saneado `UPPER_SNAKE`; nunca mensajes del proveedor. */
  readonly lastErrorCode: string | null;
  readonly result: InvestigationResult | null;
  /**
   * Estado final ya decidido mientras se ejecutan las acciones (`acting`). Si un worker cae en
   * esa etapa, el siguiente retoma desde aquí sin repetir evidencia, modelo ni acciones hechas.
   */
  readonly plannedStatus: InvestigationTerminalStatus | null;
  readonly evidence: InvestigationEvidenceSummary | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  /**
   * Compare-and-set de las órdenes humanas (`requestCancel`, `retry`). Solo avanza con cambios
   * de estado (claim, cierre, reintento, cancelación); latidos y eventos no lo mueven.
   */
  readonly revision: number;
}

export interface NewInvestigationJob {
  readonly id: string;
  readonly tenantId: string;
  readonly subject: InvestigationSubject;
  readonly alertIds: readonly string[];
  readonly priority: InvestigationPriority;
  readonly trigger: InvestigationTrigger;
  /** Por defecto `new_alert` (sistema) o `manual` (persona). */
  readonly source?: InvestigationSource;
  readonly initiatedBy: string | null;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly policyVersion: string;
  readonly createdAt: Date;
  /** Por defecto `createdAt`. */
  readonly availableAt?: Date;
}

export const INVESTIGATION_EVENT_KINDS = ['started', 'completed', 'skipped', 'failed'] as const;
export type InvestigationEventKind = (typeof INVESTIGATION_EVENT_KINDS)[number];
export type InvestigationEventDetail = Readonly<Record<string, string | number | boolean>>;

/** Bitácora append-only de progreso. Nunca lleva prompts, texto del modelo ni evidencia cruda. */
export interface InvestigationEvent {
  readonly jobId: string;
  /** Monotónica por trabajo, desde 1. */
  readonly sequence: number;
  readonly at: Date;
  readonly stage: InvestigationStage;
  readonly kind: InvestigationEventKind;
  readonly detail: InvestigationEventDetail;
}

export type InvocationPhase = 'analysis';
export const INVOCATION_STATES = [
  'reserved',
  'dispatching',
  'settled',
  'released',
  'usage_unknown',
] as const;
export type InvocationState = (typeof INVOCATION_STATES)[number];

/** Uso reportado por el proveedor. Las cuatro cuentas son disjuntas. */
export interface InvocationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/**
 * Libro de invocaciones: una fila por (trabajo, fase, huella). `reserved → dispatching →
 * settled`; `released` si se demuestra que no se envió; `usage_unknown` si pudo llegar al
 * proveedor y no hay `usage`. Todos los importes son **estimaciones** con tarifa versionada.
 */
export interface InvestigationInvocation {
  readonly id: string;
  readonly jobId: string;
  readonly tenantId: string;
  readonly phase: InvocationPhase;
  readonly fingerprint: string;
  readonly tier: InferenceTier;
  /** Identificador del modelo configurado por el host. */
  readonly model: string;
  readonly state: InvocationState;
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
  /** Peor caso reservado antes del envío. */
  readonly reservedMicroUsd: number;
  readonly usage: InvocationUsage | null;
  readonly estimatedMicroUsd: number | null;
  readonly rateCardVersion: string;
  readonly createdAt: Date;
  readonly settledAt: Date | null;
}

export const INVESTIGATION_VERDICTS = [
  'likely_true_positive',
  'likely_false_positive',
  'inconclusive',
] as const;
export type InvestigationVerdict = (typeof INVESTIGATION_VERDICTS)[number];
export const INVESTIGATION_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type InvestigationConfidence = (typeof INVESTIGATION_CONFIDENCES)[number];

export interface CitedStatement {
  readonly text: string;
  /** IDs de evidencia presentes en el paquete del run. */
  readonly citations: readonly string[];
}

/** Expediente. Es una recomendación para revisión humana: no autoriza cierre ni supresión. */
export interface InvestigationResult {
  readonly summary: string;
  readonly verdict: InvestigationVerdict;
  readonly confidence: InvestigationConfidence;
  /** Sugerencia; la prioridad oficial no cambia. */
  readonly recommendedPriority: InvestigationPriority | null;
  readonly facts: readonly CitedStatement[];
  readonly inferences: readonly CitedStatement[];
  readonly gaps: readonly string[];
  readonly nextSteps: readonly string[];
  readonly citations: readonly Citation[];
  /** `false`: hubo citas fuera del paquete, hechos sin cita o salida inválida. */
  readonly verified: boolean;
  /** Códigos de la política determinista y del runner que explican el resultado. */
  readonly deterministic: { readonly reasons: readonly string[] };
}

// ── Evidencia de entrada (la produce otra capa: `EvidenceReader`) ────────────────────────────

export interface EvidenceAlert {
  readonly id: string;
  readonly title: string;
  readonly priority: InvestigationPriority;
  readonly status: string;
  readonly ruleId: string | null;
  readonly signal: string | null;
  readonly score: number;
  readonly reasonCodes: readonly string[];
  /** ISO 8601. */
  readonly occurredAt: string;
  /** Referencias opacas (`ent_…`), nunca UPN ni IP. */
  readonly entityRefs: readonly string[];
  readonly verdict: string | null;
  readonly relatedAlertIds: readonly string[];
  /** Incidente abierto al que ya está unida la alerta. */
  readonly incidentId?: string | null;
  /** Identificador de la fuente de origen. */
  readonly source?: string | null;
}

export interface EvidenceCandidate {
  readonly id: string;
  readonly patternId: string;
  readonly score: number;
  readonly riskScore: number;
  readonly memberCount: number;
  readonly sources: readonly string[];
  readonly tactics: readonly string[];
  readonly stages: readonly string[];
  readonly explanation: string;
}

/** Historial de la misma regla y entidad en 30 días. */
export interface EvidenceHistory {
  readonly total: number;
  readonly falsePositive: number;
  readonly truePositive: number;
  readonly open: number;
}

/** Evento proyectado por allowlist: sin cuerpo crudo ni `full_log`. */
export interface EvidenceEvent {
  readonly id: string;
  /** ISO 8601. */
  readonly occurredAt: string;
  readonly source: string;
  readonly category?: string | null;
  readonly action?: string | null;
  readonly outcome?: string | null;
  readonly entityRefs?: readonly string[];
}

export interface EvidenceSourceHealth {
  readonly id: string;
  readonly label: string;
  /** `healthy` | `degraded` | `failed` | `disabled` | `unknown` (catálogo de `modules/soc`). */
  readonly state: string;
  readonly fresh: boolean;
}

export interface EvidenceCompleteness {
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly alertsScanned: number;
  readonly eventsScanned: number;
  readonly gaps: readonly string[];
}

/** Regla de detección que generó la alerta (conocimiento SOC versionado), sin texto libre largo. */
export interface EvidenceRule {
  readonly id: string;
  readonly level: number | null;
  readonly description: string;
  readonly mitre: readonly {
    readonly id: string;
    readonly name: string;
    readonly tactics: readonly string[];
  }[];
  readonly runbooks: readonly string[];
  /** Falsos positivos conocidos documentados para el caso de uso. */
  readonly knownFalsePositives: readonly string[];
  /** Criterios documentados para escalar (qué separa lo habitual de lo que no encaja). */
  readonly escalateWhen?: readonly string[];
  /** Prioridad típica del caso de uso (orientativa; la política QAPAQ manda). */
  readonly priorityHint?: string | null;
}

/** Incidente abierto que involucra a la entidad: conteos y título, nunca el texto de las notas. */
export interface EvidenceIncident {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly severity: string;
  readonly alertCount: number;
  readonly taskCount: number;
  readonly noteCount: number;
  /** ISO 8601. */
  readonly openedAt: string;
}

/** Riesgo de la entidad según el correlador privado. */
export interface EvidenceEntityRisk {
  /** Referencia opaca `ent_…`. */
  readonly entityRef: string;
  readonly score: number;
  readonly peak: number;
  readonly observations: number;
  readonly tactics: readonly string[];
  readonly sources: readonly string[];
}

/** Actividad de la entidad: alertas en 7 días y eventos en 24 h (conteos acotados). */
export interface EvidenceActivity {
  readonly entityRef: string;
  readonly alerts7d: number;
  /** `null`: no hay lector de eventos o no respondió. */
  readonly events24h: number | null;
  readonly eventsScanned: number;
  readonly complete: boolean;
}

/** Estado de los avisos de la alerta (sin destinos ni contenido). */
export interface EvidenceNotification {
  readonly status: string;
  readonly channel: string;
  /** ISO 8601. */
  readonly at: string;
}

/** Acción auditada reciente sobre la alerta o su incidente (sin metadatos libres). */
export interface EvidenceAuditAction {
  readonly action: string;
  readonly outcome: string;
  /** `user` | `service`. */
  readonly actorType: string;
  /** ISO 8601. */
  readonly at: string;
}

/**
 * Contexto ampliado del SOC (el mismo alcance de lectura que Qapaqzito, reunido sin modelo). Cada
 * parte ausente debe figurar como vacío en `completeness.gaps`.
 */
export interface EvidenceContext {
  readonly rule: EvidenceRule | null;
  readonly incidents: readonly EvidenceIncident[];
  readonly entityRisk: EvidenceEntityRisk | null;
  readonly activity: EvidenceActivity | null;
  readonly notifications: readonly EvidenceNotification[];
  readonly audit: readonly EvidenceAuditAction[];
}

/** Un conteo por valor (fuente, acción, resultado, categoría), de mayor a menor. */
export interface EvidenceCount {
  readonly value: string;
  readonly count: number;
}

/**
 * Resumen de TODOS los eventos de la entidad leídos (no de la muestra): el modelo siempre lo
 * recibe completo aunque el paquete recorte ejemplares, así la muestra nunca oculta volumen.
 */
export interface EvidenceEventSummary {
  /** Ventana ±N min alrededor de la alerta. */
  readonly window: {
    readonly from: string;
    readonly to: string;
    readonly scanned: number;
    readonly matching: number;
  };
  /** Actividad de 24 h de la entidad (todas las coincidencias). */
  readonly day: { readonly scanned: number; readonly matching: number } | null;
  readonly bySource: readonly EvidenceCount[];
  readonly byAction: readonly EvidenceCount[];
  readonly byOutcome: readonly EvidenceCount[];
  readonly byCategory: readonly EvidenceCount[];
  readonly firstAt: string | null;
  readonly lastAt: string | null;
  /** Lectura dirigida por entidad (`true`) o barrido del tenant (`false`, sin entidad). */
  readonly entityScoped: boolean;
}

/** Dominio de la alerta: define cómo se explica y qué señales aplican (assessment.ts). */
export const EVIDENCE_DOMAINS = [
  'vulnerability',
  'platform',
  'file_integrity',
  'rootcheck',
  'identity',
  'generic',
] as const;
export type EvidenceDomain = (typeof EVIDENCE_DOMAINS)[number];

/**
 * Datos estructurados del evento de la propia alerta, por lista blanca de campos y por dominio
 * (CVE/KEV/EPSS de una vulnerabilidad, chequeo y componente de la salud de plataforma, ruta de
 * FIM…). Nunca el registro crudo completo; las cadenas llegan enmascaradas y recortadas.
 */
export interface EvidenceSubject {
  readonly domain: EvidenceDomain;
  readonly details: Readonly<Record<string, string | number | boolean>>;
}

export interface EvidenceBundle {
  readonly alerts: readonly EvidenceAlert[];
  readonly relatedAlerts: readonly EvidenceAlert[];
  /** Detalles del evento de la alerta principal; opcional para adaptadores antiguos. */
  readonly subject?: EvidenceSubject | null;
  readonly candidate?: EvidenceCandidate | null;
  readonly history: EvidenceHistory;
  /** Eventos de la entidad conservados (hasta el tope de almacenamiento, no de modelo). */
  readonly events: readonly EvidenceEvent[];
  /** Agregados de todos los eventos leídos; opcional para adaptadores antiguos. */
  readonly eventSummary?: EvidenceEventSummary | null;
  readonly sourceHealth: readonly EvidenceSourceHealth[];
  /** Contexto ampliado (regla, incidentes, riesgo, actividad, avisos, auditoría). Opcional. */
  readonly context?: EvidenceContext | null;
  readonly completeness: EvidenceCompleteness;
  /** Marca estable del estado de origen leído; cambia solo si cambia la evidencia. */
  readonly watermark: string;
}

// ── Saneamiento compartido por los adaptadores ───────────────────────────────────────────────

const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;

/** Código de error apto para persistir; cualquier otra cosa se vuelve `UNKNOWN_ERROR`. */
export function sanitizeErrorCode(value: unknown): string {
  return typeof value === 'string' && ERROR_CODE.test(value) ? value : 'UNKNOWN_ERROR';
}

export const EVENT_DETAIL_LIMITS = Object.freeze({ maxKeys: 16, maxKeyChars: 40, maxChars: 200 });

/** Detalle de evento acotado: claves cortas, valores escalares, cadenas recortadas. */
export function sanitizeEventDetail(detail: InvestigationEventDetail): InvestigationEventDetail {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(detail).slice(0, EVENT_DETAIL_LIMITS.maxKeys)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(key) || key.length > EVENT_DETAIL_LIMITS.maxKeyChars) {
      continue;
    }
    if (typeof value === 'string') out[key] = value.slice(0, EVENT_DETAIL_LIMITS.maxChars);
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

export function isTerminalStatus(
  status: InvestigationStatus,
): status is InvestigationTerminalStatus {
  return (INVESTIGATION_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export class InvestigationInputError extends Error {
  public constructor(public readonly code: 'INVALID_JOB') {
    super(code);
    this.name = 'InvestigationInputError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const isInvestigationId = (value: string): boolean => UUID_PATTERN.test(value);

export const INVESTIGATION_JOB_LIMITS = Object.freeze({
  maxAlertIds: 200,
  maxTitleChars: 300,
  maxIdChars: 128,
  maxIdempotencyKeyChars: 200,
});

/**
 * Validación común de los adaptadores antes de encolar: formas, topes y coherencia entre
 * disparador, origen e iniciador. Devuelve el borrador con sus valores por defecto resueltos.
 */
export function normalizeNewJob(
  draft: NewInvestigationJob,
): NewInvestigationJob & { readonly source: InvestigationSource; readonly availableAt: Date } {
  const limits = INVESTIGATION_JOB_LIMITS;
  const source = draft.source ?? (draft.trigger === 'user' ? 'manual' : 'new_alert');
  const alertIds = [...new Set(draft.alertIds)];
  const title = draft.subject.title
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limits.maxTitleChars);
  const bounded = (value: string, max: number): boolean => value.length >= 1 && value.length <= max;
  const valid =
    bounded(draft.id, limits.maxIdChars) &&
    bounded(draft.tenantId, limits.maxIdChars) &&
    (draft.subject.kind === 'alert' || draft.subject.kind === 'candidate') &&
    bounded(draft.subject.id, limits.maxIdChars) &&
    (draft.subject.ruleId === undefined ||
      draft.subject.ruleId === null ||
      bounded(draft.subject.ruleId, limits.maxIdChars)) &&
    alertIds.length >= 1 &&
    alertIds.length <= limits.maxAlertIds &&
    alertIds.every((id) => typeof id === 'string' && bounded(id, limits.maxIdChars)) &&
    INVESTIGATION_PRIORITIES.includes(draft.priority) &&
    bounded(draft.idempotencyKey, limits.maxIdempotencyKeyChars) &&
    bounded(draft.fingerprint, limits.maxIdChars) &&
    bounded(draft.policyVersion, 64) &&
    !Number.isNaN(draft.createdAt.getTime()) &&
    (draft.trigger === 'user'
      ? source === 'manual' &&
        typeof draft.initiatedBy === 'string' &&
        bounded(draft.initiatedBy, 256)
      : draft.trigger === 'system' && source !== 'manual' && draft.initiatedBy === null);
  if (!valid) throw new InvestigationInputError('INVALID_JOB');
  return {
    ...draft,
    subject: {
      kind: draft.subject.kind,
      id: draft.subject.id,
      title: title.length > 0 ? title : 'Sin título',
      ruleId: draft.subject.ruleId ?? null,
    },
    alertIds,
    source,
    availableAt: draft.availableAt ?? draft.createdAt,
  };
}
