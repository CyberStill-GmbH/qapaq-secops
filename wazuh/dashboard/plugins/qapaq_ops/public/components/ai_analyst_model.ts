/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 *
 * Lógica pura de la pantalla «Analista IA»: textos de códigos, lo que necesita atención,
 * filtros de la lista y uso del presupuesto. Sin React, para probarla sin montar nada.
 */

import {
  actionReasonLabel,
  AI_INFERENCE_LABEL,
  AI_RUN_STATUSES,
  AI_VERDICTS,
  AiActivityFeedItem,
  AiBudget,
  AiRunAlert,
  AiRunDetail,
  AiRunStatus,
  AiRunSummary,
  AiVerdict,
  Alert,
  ALERT_STATUS_LABEL,
  AlertCommandName,
  CAPABILITIES,
  HealthTone,
  PRIORITIES,
  Priority,
  VERDICT_LABEL,
  verdictLabel,
} from '../../common';

// ------------------------------------------------------------------ Códigos → texto

/**
 * Códigos que el backend escribe en motivos, etapas y errores y que el catálogo común no rotula
 * (enrutamiento del triaje, decisiones del runner, validación de la salida y errores).
 * Fuente: `modules/assistant/src/investigations/{policy,runner,analyst-output}.ts`.
 */
const EXTRA_REASON_TEXT: Readonly<Record<string, string>> = {
  // Enrutamiento del triaje
  P1_ALWAYS_ANALYZED: 'Las alertas P1 siempre se analizan con el modelo avanzado',
  P2_ROUTINE: 'P2 sin señales de ambigüedad: análisis con el modelo económico',
  P2_MULTI_SOURCE: 'P2 con señales de varias fuentes',
  P2_MULTI_TACTIC: 'P2 con varias tácticas de ataque',
  P2_CONTRADICTORY_HISTORY: 'El patrón tiene historial contradictorio (positivos y falsos positivos)',
  P3_CORRELATED: 'P3 correlacionada con otras alertas',
  BELOW_INFERENCE_PRIORITY: 'La prioridad está por debajo del umbral para usar IA',
  RULE_ASSESSMENT_BENIGN:
    'La valoración por reglas concluyó actividad habitual sin señales de riesgo',
  RULE_ASSESSMENT_RISK: 'La valoración por reglas encontró señales de riesgo o urgencia',
  // Decisiones del runner
  INFERENCE_DISABLED: 'La IA está desactivada (sin techo diario)',
  MODEL_UNAVAILABLE: 'El modelo no estaba disponible',
  TIER_DOWNGRADED: 'Se usó el modelo económico porque el avanzado no está permitido',
  EVIDENCE_PACK_OVER_BUDGET: 'La evidencia excede el tamaño permitido para el modelo',
  EVIDENCE_SAMPLED_FOR_MODEL:
    'El modelo vio una muestra de los eventos; los conteos totales sí se consideraron',
  REUSED_PRIOR_RESULT: 'Se reutilizó un resultado verificado anterior, sin costo adicional',
  PRIOR_INFERENCE_SETTLED: 'Ya hubo una llamada al modelo para esta investigación',
  DAILY_CAP: 'Se alcanzó el techo diario de gasto en IA',
  RUN_CAP: 'Se alcanzó el máximo de llamadas al modelo por investigación',
  USAGE_UNRECONCILED: 'Hay una llamada al modelo cuyo consumo no se confirmó',
  MODEL_REFUSED: 'El modelo se negó a responder',
  INVALID_MODEL_OUTPUT: 'La respuesta del modelo no tenía el formato esperado',
  UNVERIFIED_OUTPUT: 'Las afirmaciones no se pudieron verificar contra la evidencia',
  // Validación de la salida
  UNKNOWN_CITATION: 'Cita a evidencia que no existe',
  UNCITED_FACT: 'Hay hechos sin cita a la evidencia',
  FORBIDDEN_RECOMMENDATION: 'Recomendó algo que la política no permite',
  TRUNCATED_FIELD: 'Parte de la respuesta se recortó por exceder el tamaño',
  MALFORMED_JSON: 'La respuesta del modelo no se pudo leer',
  SCHEMA_VIOLATION: 'La respuesta del modelo no cumple el formato esperado',
  EMPTY_OUTPUT: 'El modelo devolvió una respuesta vacía',
  // Errores de la corrida o de una acción
  MODEL_NOT_SENT: 'La llamada al modelo no llegó a enviarse',
  MODEL_TIMEOUT: 'El modelo tardó demasiado en responder',
  MODEL_OUTCOME_UNKNOWN: 'No se sabe si el modelo respondió',
  EVIDENCE_UNAVAILABLE: 'No se pudo obtener la evidencia',
  LEASE_LOST: 'Otro proceso tomó la investigación',
  LEASE_EXPIRED_MAX_ATTEMPTS: 'Se agotaron los reintentos automáticos',
  STALE_LEASE: 'La investigación quedó sin dueño y se retomó',
  HOST_SHUTDOWN: 'El servicio se reinició durante la investigación',
  INTERNAL_ERROR: 'Error interno del servicio',
  UNKNOWN_ERROR: 'Error no identificado',
  INVALID_SETTINGS: 'La configuración guardada no es válida',
  INVALID_JOB: 'La investigación tenía datos no válidos',
  CANCELLED: 'Detenida a pedido de una persona',
  ACTION_FAILED: 'La acción no se pudo aplicar',
  NO_ACTION_PORT: 'Este entorno no permite ejecutar la acción',
  NO_REPORT_PORT: 'Este entorno no permite adjuntar informes',
  NO_RESULT: 'No había resultado sobre el que actuar',
  ESCALATED: 'Escalada a incidente',
};

/** Texto en español de un código del backend; `null` si esta consola no lo conoce. */
export function reasonText(code: string | null | undefined): string | null {
  if (!code) return null;
  const known = actionReasonLabel(code);
  if (known) return known;
  return Object.prototype.hasOwnProperty.call(EXTRA_REASON_TEXT, code)
    ? EXTRA_REASON_TEXT[code]
    : null;
}

/** Claves de detalle de una etapa que se pueden contar en lenguaje llano. */
const DETAIL_KEY_TEXT: Readonly<Record<string, string>> = {
  reason: 'Motivo',
  verified: 'Verificado',
  issues: 'Observaciones',
  facts: 'Hechos',
  citations: 'Citas',
  tier: 'Nivel',
  alerts: 'Alertas',
  events: 'Eventos',
  sources: 'Fuentes',
  truncated: 'Evidencia recortada',
  complete: 'Evidencia completa',
  estimatedInputTokens: 'Tokens estimados de entrada',
};

export interface DetailEntry {
  readonly key: string;
  /** Rótulo legible; `null` si la clave no se conoce (va solo en «Detalles técnicos»). */
  readonly label: string | null;
  readonly text: string;
  /** Códigos sin rótulo propio, para mostrarlos como etiqueta pequeña. */
  readonly codes: readonly string[];
}

/** Detalle de una etapa en lenguaje llano: booleanos en sí/no y códigos con su texto. */
export function describeDetail(
  detail: Readonly<Record<string, string | number | boolean>>,
): DetailEntry[] {
  return Object.keys(detail).map((key) => {
    const value = detail[key];
    const label = Object.prototype.hasOwnProperty.call(DETAIL_KEY_TEXT, key)
      ? DETAIL_KEY_TEXT[key]
      : null;
    if (typeof value === 'boolean') return { key, label, text: value ? 'Sí' : 'No', codes: [] };
    if (typeof value === 'number') return { key, label, text: value.toLocaleString('es-PE'), codes: [] };
    if (key === 'tier' && (value === 'none' || value === 'economy' || value === 'advanced')) {
      return { key, label, text: AI_INFERENCE_LABEL[value], codes: [] };
    }
    const parts = value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const looksLikeCodes = parts.length > 0 && parts.every((part) => /^[A-Z][A-Z0-9_]+$/u.test(part));
    if (!looksLikeCodes) return { key, label, text: value, codes: [] };
    const texts: string[] = [];
    const codes: string[] = [];
    for (const part of parts) {
      const human = reasonText(part);
      if (human) texts.push(human);
      else codes.push(part);
    }
    return { key, label, text: texts.join('; '), codes };
  });
}

// ------------------------------------------------------------------ Atención

/** Estados terminados que piden que una persona mire el expediente. */
export const ATTENTION_STATUSES: readonly AiRunStatus[] = [
  'requires_review',
  'failed',
  'partial',
  'budget_exhausted',
  'usage_unreconciled',
];

/** Terminó sin una recomendación fiable: reintentar o revisar a mano. */
export const FAILURE_STATUSES: readonly AiRunStatus[] = [
  'failed',
  'partial',
  'budget_exhausted',
  'usage_unreconciled',
];

/**
 * Una persona ya atendió la alerta: la cerró o la vinculó a un incidente que no abrió el propio
 * analista. Sin dato de la alerta (`null`) no se da por atendida.
 */
export function isAlertHandled(alert: AiRunAlert | null): boolean {
  if (!alert) return false;
  if (alert.status === 'closed') return true;
  return alert.incidentId !== null && !alert.incidentByAnalyst;
}

/**
 * Revisión pendiente: el expediente pide revisión humana Y la alerta todavía necesita a una
 * persona. Una revisión cuya alerta ya se cerró o pasó a un incidente deja de contar.
 */
export function isPendingReview(run: Pick<AiRunSummary, 'status' | 'alert'>): boolean {
  return run.status === 'requires_review' && !isAlertHandled(run.alert);
}

export function isFailedRun(run: Pick<AiRunSummary, 'status'>): boolean {
  return (FAILURE_STATUSES as readonly string[]).includes(run.status);
}

/** Necesita a una persona: revisión pendiente o corrida fallida/incompleta. */
export function needsAttention(run: Pick<AiRunSummary, 'status' | 'alert'>): boolean {
  return isPendingReview(run) || isFailedRun(run);
}

const PRIORITY_RANK: Readonly<Record<Priority, number>> = { P1: 0, P2: 1, P3: 2, P4: 3 };

function rank(priority: Priority | null): number {
  return priority ? PRIORITY_RANK[priority] : 4;
}

function timeOf(iso: string | null): number {
  if (!iso) return 0;
  const value = new Date(iso).getTime();
  return Number.isNaN(value) ? 0 : value;
}

export interface AttentionItem {
  readonly key: string;
  readonly jobId: string;
  readonly title: string;
  readonly priority: Priority | null;
  readonly kind: 'review' | 'failed' | 'escalated';
  readonly at: string | null;
}

export interface AttentionSummary {
  /** Revisiones pendientes (sin ventana: siguen hasta que una persona atiende la alerta). */
  readonly review: number;
  /** Fallidas, parciales, sin presupuesto o con uso por conciliar en la ventana. */
  readonly failed: number;
  /** Escaladas a incidente en la ventana (acciones ejecutadas del feed). */
  readonly escalated: number;
  /** Alguna lista llegó llena: el conteo puede ser mayor. */
  readonly capped: boolean;
  /** Lo más urgente primero: prioridad y luego lo más reciente. */
  readonly items: readonly AttentionItem[];
}

export const ATTENTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Qué necesita a una persona. Revisiones: todas las pendientes (`isPendingReview`), sin importar
 * su antigüedad, porque una revisión sin atender no caduca. Fallos y escalaciones: últimas 24 h.
 * Las corridas vienen de la lista y las escalaciones del feed; una corrida cuenta una sola vez
 * y manda su primera lectura (la más reciente va primero).
 */
export function attentionSummary(input: {
  readonly runs: readonly AiRunSummary[];
  readonly feed?: readonly AiActivityFeedItem[];
  readonly now: number;
  readonly capped?: boolean;
  readonly limit?: number;
}): AttentionSummary {
  const since = input.now - ATTENTION_WINDOW_MS;
  const items: AttentionItem[] = [];
  const seen = new Set<string>();
  let review = 0;
  let failed = 0;
  for (const run of input.runs) {
    if (seen.has(run.id)) continue;
    seen.add(run.id);
    if (!needsAttention(run)) continue;
    const at = run.finishedAt ?? run.updatedAt ?? run.createdAt;
    const kind = isPendingReview(run) ? 'review' : 'failed';
    if (kind === 'failed' && timeOf(at) < since) continue;
    if (kind === 'review') review += 1;
    else failed += 1;
    items.push({
      key: `${kind}:${run.id}`,
      jobId: run.id,
      title: run.subject.title,
      priority: run.priority,
      kind,
      at,
    });
  }
  const escalatedJobs = new Set<string>();
  for (const item of input.feed ?? []) {
    if (item.kind !== 'action' || item.actionKind !== 'escalate' || item.actionState !== 'executed') {
      continue;
    }
    if (timeOf(item.at) < since || escalatedJobs.has(item.jobId)) continue;
    escalatedJobs.add(item.jobId);
    items.push({
      key: `escalated:${item.jobId}`,
      jobId: item.jobId,
      title: item.subjectTitle,
      priority: item.priority,
      kind: 'escalated',
      at: item.at,
    });
  }
  items.sort((a, b) => rank(a.priority) - rank(b.priority) || timeOf(b.at) - timeOf(a.at));
  return {
    review,
    failed,
    escalated: escalatedJobs.size,
    capped: input.capped === true,
    items: items.slice(0, input.limit ?? 6),
  };
}

// ------------------------------------------------------------------ Filtros de la lista

/** `attention` es la bandeja de revisión: solo revisiones pendientes. */
export type RunView = 'all' | 'attention' | 'failed' | 'escalated' | 'active';

export interface RunFilters {
  /** Filtro del servidor (`?status=`); vacío = todos. */
  readonly status: AiRunStatus | '';
  readonly view: RunView;
  readonly verdict: AiVerdict | 'none' | '';
  readonly priorities: readonly Priority[];
  readonly query: string;
}

export const EMPTY_FILTERS: RunFilters = {
  status: '',
  view: 'all',
  verdict: '',
  priorities: [],
  query: '',
};

export const RUN_VIEW_LABEL: Readonly<Record<RunView, string>> = {
  all: 'Todas',
  attention: 'Bandeja de revisión',
  failed: 'Fallidas',
  escalated: 'Escaladas',
  active: 'En curso',
};

export function parseRunStatus(value: string): AiRunStatus | '' {
  return (AI_RUN_STATUSES as readonly string[]).includes(value) ? (value as AiRunStatus) : '';
}

export function parseVerdictFilter(value: string): RunFilters['verdict'] {
  if (value === 'none') return 'none';
  return (AI_VERDICTS as readonly string[]).includes(value) ? (value as AiVerdict) : '';
}

/** Filtros que se aplican en el navegador sobre lo ya cargado (el estado lo filtra el servicio). */
export function filterRuns(items: readonly AiRunSummary[], filters: RunFilters): AiRunSummary[] {
  const term = filters.query.trim().toLocaleLowerCase('es');
  return items.filter((run) => {
    if (filters.view === 'attention' && !isPendingReview(run)) return false;
    if (filters.view === 'failed' && !isFailedRun(run)) return false;
    if (filters.view === 'escalated' && !run.actionKinds.includes('escalate')) return false;
    if (filters.view === 'active' && run.status !== 'queued' && run.status !== 'running') return false;
    if (filters.verdict === 'none' && run.verdict !== null) return false;
    if (filters.verdict && filters.verdict !== 'none' && run.verdict !== filters.verdict) return false;
    if (filters.priorities.length > 0 && (!run.priority || !filters.priorities.includes(run.priority))) {
      return false;
    }
    if (term) {
      const haystack = `${run.subject.title} ${run.subject.id} ${run.id}`.toLocaleLowerCase('es');
      if (!haystack.includes(term)) return false;
    }
    return true;
  });
}

/** Hay algún filtro aplicado (para ofrecer «Quitar filtros» y explicar una lista vacía). */
export function hasFilters(filters: RunFilters): boolean {
  return (
    filters.status !== '' ||
    filters.view !== 'all' ||
    filters.verdict !== '' ||
    filters.priorities.length > 0 ||
    filters.query.trim() !== ''
  );
}

export function togglePriority(list: readonly Priority[], priority: Priority): Priority[] {
  return list.includes(priority)
    ? list.filter((value) => value !== priority)
    : PRIORITIES.filter((value) => value === priority || list.includes(value));
}

// ------------------------------------------------------------------ Bandeja de revisión

/**
 * Bandeja de revisión: solo las pendientes, sin duplicados (manda la primera lectura), de mayor
 * a menor prioridad y, dentro de cada prioridad, la que más lleva esperando primero.
 */
export function reviewInbox(runs: readonly AiRunSummary[]): AiRunSummary[] {
  const seen = new Set<string>();
  const out: AiRunSummary[] = [];
  for (const run of runs) {
    if (seen.has(run.id)) continue;
    seen.add(run.id);
    if (isPendingReview(run)) out.push(run);
  }
  const waitingSince = (run: AiRunSummary) =>
    timeOf(run.finishedAt ?? run.updatedAt ?? run.createdAt);
  return out.sort(
    (a, b) => rank(a.priority) - rank(b.priority) || waitingSince(a) - waitingSince(b),
  );
}

/** Estado de la alerta en una frase corta para la bandeja. */
export function alertStateText(alert: AiRunAlert | null): string {
  if (!alert) return 'Estado de la alerta sin dato';
  const parts: string[] = [
    alert.status === 'unknown' ? 'Estado no reconocido' : ALERT_STATUS_LABEL[alert.status],
  ];
  if (alert.assignedToYou) parts.push('asignada a ti');
  else if (alert.assigneeId) parts.push(`asignada a ${alert.assigneeId}`);
  else parts.push('sin asignar');
  if (alert.verdict && alert.verdict !== 'unknown') {
    parts.push(VERDICT_LABEL[alert.verdict].toLowerCase());
  }
  if (alert.incidentId) {
    parts.push(alert.incidentByAnalyst ? 'incidente abierto por el analista' : 'en un incidente');
  }
  return parts.join(' · ');
}

// ------------------------------------------------------------------ Acciones de revisión

/** Mismos límites que el backend para notas de triaje y cierre (`TRIAGE_NOTE_LIMITS`). */
export const REVIEW_NOTE_MIN = 10;
export const REVIEW_NOTE_MAX = 2000;

export function reviewNoteValid(note: string): boolean {
  const length = note.trim().length;
  return length >= REVIEW_NOTE_MIN && length <= REVIEW_NOTE_MAX;
}

export type ReviewActionId = 'assign' | 'close_false_positive' | 'open_incident' | 'acknowledge';

export interface ReviewViewer {
  readonly subjectId: string;
  readonly can: (capability: string) => boolean;
}

export interface ReviewActionState {
  /** Sin la capacidad que exige el API, la acción no se muestra. */
  readonly visible: boolean;
  readonly enabled: boolean;
  /** Por qué no está disponible, en llano; `null` si lo está. */
  readonly reason: string | null;
}

export interface ReviewCommandStep {
  readonly name: AlertCommandName;
}

export interface FalsePositivePlan {
  readonly steps: readonly ReviewCommandStep[];
  /** Motivo por el que no se puede; `null` si se puede. */
  readonly blocked: string | null;
}

const CLOSABLE_VERDICTS: ReadonlyArray<Alert['verdict']> = ['false_positive', 'benign', 'duplicate'];

/**
 * Pasos por los endpoints de alertas existentes para «Confirmar: falso positivo y cerrar», con las
 * reglas del dominio (`modules/soc/src/alert.ts`): solo tria quien tiene la alerta asignada y solo
 * desde «Reconocida»; tras el triaje el cierre ya no exige nota, pero se envía igual.
 */
export function falsePositivePlan(alert: Alert, viewer: ReviewViewer): FalsePositivePlan {
  const none = (blocked: string): FalsePositivePlan => ({ steps: [], blocked });
  if (alert.incidentId) {
    return none('La alerta está vinculada a un incidente: se cierra desde el incidente.');
  }
  if (alert.status === 'closed') return none('La alerta ya está cerrada.');
  if (alert.status === 'escalated') return none('La alerta ya se escaló como amenaza.');
  if (alert.status === 'triaged') {
    return CLOSABLE_VERDICTS.includes(alert.verdict)
      ? { steps: [{ name: 'close' }], blocked: null }
      : none('La alerta ya se trió como verdadero positivo.');
  }
  const steps: ReviewCommandStep[] = [];
  // `acknowledge` conserva la asignación existente o asigna a quien reconoce.
  if (alert.status === 'new') steps.push({ name: 'acknowledge' });
  const owner = alert.status === 'new' ? alert.assigneeId ?? viewer.subjectId : alert.assigneeId;
  if (owner !== viewer.subjectId) {
    if (!viewer.can(CAPABILITIES.alertsAssign)) {
      return none('La alerta está asignada a otra persona y tu cuenta no puede reasignarla.');
    }
    steps.push({ name: 'assign' });
  }
  steps.push({ name: 'triage' }, { name: 'close' });
  return { steps, blocked: null };
}

/**
 * Qué acciones de revisión ofrecer sobre la alerta, con las mismas condiciones con que el API las
 * rechazaría: sin la capacidad no se muestran; con ella pero en un estado que no lo permite, se
 * muestran deshabilitadas con el motivo.
 */
export function reviewActions(
  alert: Alert,
  viewer: ReviewViewer,
): Record<ReviewActionId, ReviewActionState> {
  const state = (visible: boolean, reason: string | null): ReviewActionState => ({
    visible,
    enabled: visible && reason === null,
    reason: visible ? reason : null,
  });
  const status = (ALERT_STATUS_LABEL[alert.status] ?? alert.status).toLowerCase();
  const mine = alert.assigneeId === viewer.subjectId;
  const assignable =
    alert.status === 'new' || alert.status === 'acknowledged' || alert.status === 'triaged';
  return {
    assign: state(
      viewer.can(CAPABILITIES.alertsAssign),
      mine ? 'Ya la tienes asignada.' : assignable ? null : `La alerta está ${status}: ya no se reasigna.`,
    ),
    close_false_positive: state(
      viewer.can(CAPABILITIES.alertsTriage),
      falsePositivePlan(alert, viewer).blocked,
    ),
    open_incident: state(
      viewer.can(CAPABILITIES.incidentsWrite),
      alert.incidentId
        ? 'La alerta ya está vinculada a un incidente.'
        : alert.status === 'closed'
          ? 'La alerta está cerrada.'
          : null,
    ),
    acknowledge: state(
      viewer.can(CAPABILITIES.alertsTriage),
      alert.status === 'new' ? null : `La alerta ya está ${status}.`,
    ),
  };
}

/** Lo mínimo del expediente para precargar textos: la conclusión puede no haber llegado. */
export interface ReviewSource {
  readonly id: string;
  readonly result?: AiRunDetail['result'];
}

function conclusionOf(run: ReviewSource): string {
  if (!run.result) return '';
  const summary = run.result.summary.trim();
  return ` Conclusión del analista: ${verdictLabel(run.result.verdict).toLowerCase()}${
    summary ? `. ${summary}` : '.'
  }`;
}

function clip(text: string): string {
  return text.length <= REVIEW_NOTE_MAX ? text : `${text.slice(0, REVIEW_NOTE_MAX - 1)}…`;
}

/** Nota precargada (editable) para cerrar como falso positivo. */
export function falsePositiveNote(run: ReviewSource): string {
  return clip(
    `Falso positivo confirmado tras revisar el expediente ${run.id} del Analista IA.${conclusionOf(run)}`,
  );
}

/** Resumen precargado (editable) del incidente al confirmar la amenaza. */
export function threatSummary(run: ReviewSource): string {
  return clip(
    `Amenaza confirmada tras revisar el expediente ${run.id} del Analista IA.${conclusionOf(run)}`,
  );
}

/** Confirmación tras cada acción, en llano. */
export const REVIEW_DONE_TEXT: Readonly<Record<ReviewActionId, string>> = {
  assign: 'Alerta asignada a ti',
  close_false_positive: 'Alerta cerrada como falso positivo · nota guardada',
  open_incident: 'Incidente abierto · alerta vinculada',
  acknowledge: 'Alerta marcada como revisada sin cambios',
};

// ------------------------------------------------------------------ Veredicto

export const VERDICT_TONE: Readonly<Record<AiVerdict | 'unknown', HealthTone>> = {
  likely_true_positive: 'fail',
  likely_false_positive: 'ok',
  inconclusive: 'warn',
  unknown: 'neutral',
};

export function verdictTone(verdict: AiRunSummary['verdict']): HealthTone {
  return verdict === null ? 'neutral' : VERDICT_TONE[verdict];
}

/** Escalón de confianza 0–3 para el medidor (0 = sin dato). */
export function confidenceStep(confidence: AiRunSummary['confidence']): 0 | 1 | 2 | 3 {
  switch (confidence) {
    case 'low':
      return 1;
    case 'medium':
      return 2;
    case 'high':
      return 3;
    default:
      return 0;
  }
}

// ------------------------------------------------------------------ Presupuesto

export interface BudgetUsage {
  /** Uso confirmado + reservado, en micro-USD; `null` si no llegó ninguno. */
  readonly usedMicroUsd: number | null;
  readonly limitMicroUsd: number | null;
  /** Porción del techo (0–1, puede pasar de 1); `null` sin techo o sin uso. */
  readonly share: number | null;
  /** Escalón para el medidor: 0–20 (5 % cada uno), sin estilos en línea. */
  readonly step: number;
  readonly tone: HealthTone;
}

export function budgetUsage(budget: AiBudget): BudgetUsage {
  const { settledMicroUsd, reservedMicroUsd, limitMicroUsd } = budget.day;
  const used =
    settledMicroUsd === null && reservedMicroUsd === null
      ? null
      : (settledMicroUsd ?? 0) + (reservedMicroUsd ?? 0);
  const share =
    used === null || limitMicroUsd === null || limitMicroUsd <= 0 ? null : used / limitMicroUsd;
  const step = share === null ? 0 : Math.max(used! > 0 ? 1 : 0, Math.min(20, Math.round(share * 20)));
  const tone: HealthTone =
    share === null ? 'neutral' : share >= 1 ? 'fail' : share >= 0.8 ? 'warn' : 'ok';
  return { usedMicroUsd: used, limitMicroUsd, share, step, tone };
}

/** «32 %» sin decimales para el medidor; `null` sin dato. */
export function percentText(share: number | null): string | null {
  if (share === null) return null;
  return `${Math.round(share * 100)} %`;
}
