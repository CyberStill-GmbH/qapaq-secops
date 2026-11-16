/**
 * Analista IA — plan de acciones sobre el SOC (puro) y su libro.
 *
 * La autonomía la conceden los ajustes del administrador, nunca el modelo. `planActions` decide
 * solo con campos estructurados y aplica guardas duras que ningún ajuste puede relajar. El host
 * ejecuta cada acción por el puerto `SocActions`; no existe ninguna acción de contención o
 * respuesta: esas siguen en Ankay con aprobación humana.
 */

import { isCorrelatedEvidence, unhealthySources } from './policy.js';
import type { AnalystSettings } from './settings.js';
import type {
  EvidenceBundle,
  InvestigationConfidence,
  InvestigationInference,
  InvestigationJob,
  InvestigationPriority,
  InvestigationResult,
  InvestigationTerminalStatus,
} from './types.js';

export const ACTION_KINDS = [
  'escalate',
  'close_benign',
  'acknowledge',
  'report',
  'request_review',
] as const;
/** También es el orden de ejecución: el pedido de revisión va al final. */
export type ActionKind = (typeof ACTION_KINDS)[number];
export const STATE_CHANGING_ACTIONS: readonly ActionKind[] = [
  'escalate',
  'close_benign',
  'acknowledge',
];

export const ACTION_REASON_CODES = [
  'ESCALATE_VERIFIED_TRUE_POSITIVE',
  'ESCALATE_CORRELATED_P1',
  'CLOSE_KNOWN_BENIGN',
  'ACKNOWLEDGE_INVESTIGATED',
  'REPORT_PER_RUN',
  'REVIEW_ESCALATION_RECOMMENDED',
  'REVIEW_ESCALATION_NOT_VERIFIED',
  'REVIEW_REQUIRES_REVIEW',
  'REVIEW_PARTIAL',
  'REVIEW_BUDGET_EXHAUSTED',
  'REVIEW_USAGE_UNRECONCILED',
  'REVIEW_FAILED',
  'REVIEW_STATE_CHANGE_NOTICE',
] as const;
export type ActionReasonCode = (typeof ACTION_REASON_CODES)[number];

export type ReviewUrgency = 'immediate' | 'digest';

export interface PlannedAction {
  readonly kind: ActionKind;
  readonly reason: ActionReasonCode;
  /** Solo `request_review`: `immediate` avisa ya; `digest` se agrupa en el pedido periódico. */
  readonly urgency?: ReviewUrgency;
  /** Solo `request_review`: clave estable para agrupar pedidos del mismo caso. */
  readonly groupKey?: string;
}

export const ACTION_STATES = ['planned', 'executed', 'skipped', 'failed'] as const;
export type ActionState = (typeof ACTION_STATES)[number];

export interface ActionRef {
  readonly kind: 'alert' | 'incident' | 'notification' | 'report';
  readonly id: string;
}

/** Libro de acciones: una fila por (trabajo, tipo). Una acción `executed` no se repite. */
export interface InvestigationAction {
  readonly id: string;
  readonly jobId: string;
  readonly tenantId: string;
  readonly kind: ActionKind;
  readonly state: ActionState;
  readonly reason: ActionReasonCode;
  readonly urgency: ReviewUrgency | null;
  readonly groupKey: string | null;
  readonly at: Date;
  readonly executedAt: Date | null;
  readonly ref: ActionRef | null;
  readonly errorCode: string | null;
}

/**
 * Guardas duras. Los ajustes pueden ser más estrictos, nunca más laxos; cada una tiene prueba.
 */
export const ACTION_HARD_GUARDS = Object.freeze({
  /** Solo se cierra por la vía determinista; un veredicto del modelo jamás cierra. */
  closeRequiresReason: 'KNOWN_BENIGN_PATTERN',
  /**
   * Segunda vía determinista de cierre: la valoración por reglas concluye actividad habitual
   * (confianza media, CERO señales de riesgo). No exige historial de cierres manuales (nadie
   * cierra a mano el ruido de alto volumen), pero sí todas las demás guardas.
   */
  closeRuleAssessmentReason: 'RULE_ASSESSMENT_BENIGN',
  /** Prioridades que pueden cerrarse; P1 y P2 nunca. */
  closeablePriorities: Object.freeze(['P3', 'P4']) as readonly InvestigationPriority[],
  /** Mínimo absoluto de cierres previos como falso positivo (vía del patrón benigno conocido). */
  closeMinHistory: 3,
  /** Verdaderos positivos previos tolerados para cerrar. */
  closeMaxTruePositives: 0,
  /** Confianza mínima absoluta para escalar a partir de un veredicto del modelo. */
  escalateMinConfidence: 'medium' as InvestigationConfidence,
  /**
   * Solo la escalación avisa a una persona. Acusar y cerrar lo benigno quedan en la nota de la
   * alerta, la auditoría y el resumen diario (decisión del dueño, 2026-11-15: la revisión humana
   * es para peligro o rarezas, no para cada acuse).
   */
  stateChangeRequiresReviewNotice: false,
  /** Tipos de acción existentes: no hay contención ni respuesta. */
  kinds: ACTION_KINDS,
});

const CONFIDENCE_RANK: Readonly<Record<InvestigationConfidence, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

export interface ActionPlanContext {
  /** Estado final decidido para el trabajo. */
  readonly status: InvestigationTerminalStatus;
  /** `none`: el resultado es determinista (no vino de un modelo). */
  readonly inference: InvestigationInference;
  /** Pedidos `immediate` del tenant en la última hora (lo cuenta quien llama). */
  readonly immediateReviewsLastHour?: number;
}

/** Clave estable de agrupación: candidato, o regla + entidad principal. */
export function reviewGroupKey(job: InvestigationJob, evidence: EvidenceBundle | null): string {
  if (job.subject.kind === 'candidate') return `candidate:${job.subject.id}`;
  const alert = evidence?.alerts[0];
  const ruleId = alert?.ruleId ?? job.subject.ruleId ?? null;
  const entity = alert?.entityRefs[0] ?? null;
  if (ruleId === null && entity === null) return `job:${job.id}`;
  return `rule:${ruleId ?? 'none'}|entity:${entity ?? 'none'}`;
}

/**
 * Urgencia de un pedido de revisión. `immediate` solo para P1, o para una escalación P2
 * verificada con la confianza exigida; el exceso sobre `maxImmediatePerHour` pasa a `digest`.
 */
export function reviewUrgency(input: {
  readonly priority: InvestigationPriority;
  readonly verifiedEscalation: boolean;
  readonly immediateReviewsLastHour: number;
  readonly maxImmediatePerHour: number;
}): ReviewUrgency {
  const wanted =
    input.priority === 'P1' || (input.priority === 'P2' && input.verifiedEscalation)
      ? 'immediate'
      : 'digest';
  return wanted === 'immediate' && input.immediateReviewsLastHour >= input.maxImmediatePerHour
    ? 'digest'
    : wanted;
}

const STATUS_REVIEW_REASON: Readonly<
  Partial<Record<InvestigationTerminalStatus, ActionReasonCode>>
> = {
  requires_review: 'REVIEW_REQUIRES_REVIEW',
  partial: 'REVIEW_PARTIAL',
  budget_exhausted: 'REVIEW_BUDGET_EXHAUSTED',
  usage_unreconciled: 'REVIEW_USAGE_UNRECONCILED',
  failed: 'REVIEW_FAILED',
};

/** ¿Cumple el expediente TODAS las guardas duras de cierre benigno? */
export function closeBenignAllowed(
  job: InvestigationJob,
  result: InvestigationResult | null,
  evidence: EvidenceBundle | null,
  settings: AnalystSettings,
  context: ActionPlanContext,
): boolean {
  const guards = ACTION_HARD_GUARDS;
  if (!result || !evidence) return false;
  const maxPriority = settings.closeBenign.maxPriority;
  const knownPattern = result.deterministic.reasons.includes(guards.closeRequiresReason);
  const ruleAssessment =
    result.deterministic.reasons.includes(guards.closeRuleAssessmentReason) &&
    result.confidence === 'medium';
  // El patrón benigno conocido exige cierres manuales previos; la valoración por reglas ya
  // exige cero señales de riesgo y no tiene historial que exigir (ver closeRuleAssessmentReason).
  const historyOk = knownPattern
    ? evidence.history.falsePositive >= Math.max(guards.closeMinHistory, settings.closeBenign.minHistory)
    : ruleAssessment;
  return (
    context.inference === 'none' &&
    context.status === 'completed' &&
    result.verified &&
    result.verdict === 'likely_false_positive' &&
    (knownPattern || ruleAssessment) &&
    // Cualquier señal de riesgo o urgencia (incluidas las del dominio) impide cerrar.
    !result.deterministic.reasons.includes('RULE_ASSESSMENT_RISK') &&
    historyOk &&
    guards.closeablePriorities.includes(job.priority) &&
    job.priority >= maxPriority &&
    evidence.alerts.length > 0 &&
    evidence.alerts.every((alert) => guards.closeablePriorities.includes(alert.priority)) &&
    evidence.completeness.complete &&
    !evidence.completeness.truncated &&
    unhealthySources(evidence).length === 0 &&
    evidence.history.truePositive <= guards.closeMaxTruePositives &&
    evidence.alerts.every((alert) => !alert.incidentId)
  );
}

/**
 * Plan de acciones. Puro: solo lee campos estructurados del trabajo, el resultado validado, la
 * evidencia y los ajustes. `evidence: null` (p. ej. trabajo `failed`) solo permite pedir revisión.
 *
 * - `shadow` (o analista deshabilitado): nada más que el informe.
 * - `assisted`: nunca cambia estado; una escalación se vuelve pedido de revisión.
 * - `autonomous`: ejecuta las acciones habilitadas que pasen las guardas duras, y cada cambio de
 *   estado lleva su pedido de revisión para que una persona siempre lo vea.
 */
export function planActions(
  job: InvestigationJob,
  result: InvestigationResult | null,
  evidence: EvidenceBundle | null,
  settings: AnalystSettings,
  context: ActionPlanContext,
): PlannedAction[] {
  if (!settings.enabled || context.status === 'cancelled') return [];
  const plan: PlannedAction[] = [];
  const report: PlannedAction[] =
    result !== null &&
    settings.reports.perRun &&
    (settings.mode === 'shadow' || settings.actions.attachReport)
      ? [{ kind: 'report', reason: 'REPORT_PER_RUN' }]
      : [];
  if (settings.mode === 'shadow') return report;

  const autonomous = settings.mode === 'autonomous';
  // Sin canal de aviso no hay cambios de estado: nadie se enteraría.
  const mayChangeState = autonomous && settings.actions.requestReview;
  const deterministic = context.inference === 'none';
  const attached =
    evidence !== null && evidence.alerts.length > 0 && evidence.alerts.every((a) => !!a.incidentId);

  // ── Escalación ─────────────────────────────────────────────────────────────────────────────
  const minConfidence = Math.max(
    CONFIDENCE_RANK[ACTION_HARD_GUARDS.escalateMinConfidence],
    CONFIDENCE_RANK[settings.escalation.minConfidence],
  );
  const modelTruePositive = !deterministic && result?.verdict === 'likely_true_positive';
  const verifiedEscalation =
    modelTruePositive &&
    result.verified &&
    context.status === 'completed' &&
    CONFIDENCE_RANK[result.confidence] >= minConfidence;
  const correlatedP1 =
    deterministic && job.priority === 'P1' && evidence !== null && isCorrelatedEvidence(evidence);
  const inEscalationScope = settings.escalation.priorities.includes(job.priority) && !attached;
  let reviewReason: ActionReasonCode | null = null;
  if (inEscalationScope && (modelTruePositive || correlatedP1)) {
    if (mayChangeState && settings.actions.escalate && (verifiedEscalation || correlatedP1)) {
      plan.push({
        kind: 'escalate',
        reason: verifiedEscalation ? 'ESCALATE_VERIFIED_TRUE_POSITIVE' : 'ESCALATE_CORRELATED_P1',
      });
      reviewReason = 'REVIEW_STATE_CHANGE_NOTICE';
    } else {
      reviewReason =
        verifiedEscalation || correlatedP1
          ? 'REVIEW_ESCALATION_RECOMMENDED'
          : 'REVIEW_ESCALATION_NOT_VERIFIED';
    }
  }

  // ── Cierre benigno (solo determinista) ─────────────────────────────────────────────────────
  const escalating = plan.some((action) => action.kind === 'escalate');
  if (
    !escalating &&
    mayChangeState &&
    settings.actions.closeBenign &&
    closeBenignAllowed(job, result, evidence, settings, context)
  ) {
    plan.push({ kind: 'close_benign', reason: 'CLOSE_KNOWN_BENIGN' });
    if (ACTION_HARD_GUARDS.stateChangeRequiresReviewNotice) {
      reviewReason ??= 'REVIEW_STATE_CHANGE_NOTICE';
    }
  }

  // ── Acuse: «el analista ya la investigó» ───────────────────────────────────────────────────
  if (
    plan.length === 0 &&
    reviewReason === null &&
    mayChangeState &&
    settings.actions.acknowledge &&
    job.subject.kind === 'alert' &&
    context.status === 'completed' &&
    result?.verified === true &&
    !attached
  ) {
    plan.push({ kind: 'acknowledge', reason: 'ACKNOWLEDGE_INVESTIGATED' });
    if (ACTION_HARD_GUARDS.stateChangeRequiresReviewNotice) {
      reviewReason = 'REVIEW_STATE_CHANGE_NOTICE';
    }
  }

  // ── Pedido de revisión humana ──────────────────────────────────────────────────────────────
  const statusReason = STATUS_REVIEW_REASON[context.status];
  const notifiable =
    settings.review.notifyPriorities.includes(job.priority) &&
    (settings.review.notifyOnStatuses as readonly string[]).includes(context.status);
  if (statusReason && notifiable) reviewReason ??= statusReason;
  plan.push(...report);
  const stateChange = plan.some((action) => STATE_CHANGING_ACTIONS.includes(action.kind));
  if (reviewReason !== null && (settings.actions.requestReview || stateChange)) {
    plan.push({
      kind: 'request_review',
      reason: reviewReason,
      urgency: reviewUrgency({
        priority: job.priority,
        verifiedEscalation:
          verifiedEscalation && (reviewReason === 'REVIEW_ESCALATION_RECOMMENDED' || escalating),
        immediateReviewsLastHour: context.immediateReviewsLastHour ?? 0,
        maxImmediatePerHour: settings.review.maxImmediatePerHour,
      }),
      groupKey: reviewGroupKey(job, evidence),
    });
  }
  return plan.sort(
    (left, right) => ACTION_KINDS.indexOf(left.kind) - ACTION_KINDS.indexOf(right.kind),
  );
}

export interface ReviewRequest {
  readonly reason: ActionReasonCode;
  readonly urgency: ReviewUrgency;
  readonly groupKey: string;
}

/**
 * Puerto de acciones sobre el SOC; lo implementa el host con la identidad de servicio del
 * analista, autorización, auditoría y compare-and-set propios. Cada método DEBE ser idempotente
 * por (`job.id`, tipo de acción): tras una caída el runner puede repetir una acción que quedó
 * `planned`. Un error lanzado se registra en el libro y no hace fallar la investigación.
 */
export interface SocActions {
  /**
   * Abre un incidente o asocia la alerta a uno abierto del mismo grupo (`disposition`). Nunca
   * debe crear duplicados para el mismo grupo dentro de la ventana del host.
   */
  escalate(
    job: InvestigationJob,
    result: InvestigationResult,
  ): Promise<{ readonly incidentId?: string; readonly disposition?: 'created' | 'attached' }>;
  acknowledge(job: InvestigationJob): Promise<void>;
  closeBenign(job: InvestigationJob, note: string): Promise<void>;
  requestReview(
    job: InvestigationJob,
    result: InvestigationResult | null,
    review: ReviewRequest,
  ): Promise<{ readonly notificationId?: string }>;
  /** Opcional: adjunta el informe determinista del run al caso. */
  attachReport?(
    job: InvestigationJob,
    report: { readonly filename: string; readonly markdown: string },
  ): Promise<{ readonly reportId?: string }>;
}

/**
 * Nota del cierre benigno. Solo texto generado por QAPAQ (nunca del modelo ni de la alerta): la
 * conclusión por reglas y sus señales, que se arman con conteos y referencias.
 */
export function closeBenignNote(job: InvestigationJob): string {
  const head = `Cierre automático del Analista IA (${job.policyVersion}).`;
  const tail = ` Expediente ${job.id}.`;
  const result = job.result;
  const ruleBased =
    result !== null &&
    result.deterministic.reasons.includes(ACTION_HARD_GUARDS.closeRuleAssessmentReason);
  if (!ruleBased) {
    return `${head} Patrón benigno conocido: el historial de 30 días de la misma regla y entidad solo registra cierres como falso positivo.${tail}`;
  }
  const signals = result.inferences
    .map((entry) => entry.text)
    .filter((text) => text.startsWith('Señal de actividad habitual: '))
    .map((text) => `- ${text.slice('Señal de actividad habitual: '.length)}`);
  const body = [` ${result.summary}`, signals.length > 0 ? `\nMotivos:\n${signals.join('\n')}` : '']
    .join('')
    .slice(0, TRIAGE_NOTE_MAX - head.length - tail.length);
  return `${head}${body}${tail}`;
}

/** Tope de la nota de triage del SOC (TRIAGE_NOTE_LIMITS.maximumLength). */
const TRIAGE_NOTE_MAX = 2000;
