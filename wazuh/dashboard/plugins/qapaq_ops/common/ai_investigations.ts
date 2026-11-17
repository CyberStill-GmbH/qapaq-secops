/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import type { AlertStatus, AlertVerdict, Priority, SourceState } from './api_contract';
import { ALERT_STATUSES, ALERT_VERDICTS, PRIORITIES, SOURCE_STATES } from './api_contract';
import type { HealthTone } from './catalog';
import { SOURCE_STATE_LABEL } from './catalog';

/**
 * Analista IA (`/api/ai-investigations`): investigaciones durables de alertas. Según el modo que
 * fije la administración, el analista solo recomienda (sombra), además pide revisión humana
 * (asistido) o ejecuta las acciones permitidas (autónomo). La mayoría de las corridas se resuelve
 * con reglas deterministas, sin llamada al modelo.
 *
 * Todo lo que llega del backend pasa por los normalizadores de este archivo: un enum desconocido
 * queda como `unknown` (rótulo neutro), un número ausente queda `null` («Sin dato», nunca 0) y el
 * costo es siempre una estimación, no facturación.
 */

export const AI_RUN_STATUSES = [
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
export type AiRunStatus = (typeof AI_RUN_STATUSES)[number];
/** `unknown`: el backend envió un estado que esta versión de la consola no conoce. */
export type AiRunStatusView = AiRunStatus | 'unknown';

export const AI_RUN_STAGES = [
  'fetching_evidence',
  'triage',
  'model',
  'validating',
  'acting',
  'writing',
] as const;
export type AiRunStage = (typeof AI_RUN_STAGES)[number];

export const AI_INFERENCE_TIERS = ['none', 'economy', 'advanced'] as const;
export type AiInference = (typeof AI_INFERENCE_TIERS)[number];

export const AI_VERDICTS = ['likely_true_positive', 'likely_false_positive', 'inconclusive'] as const;
export type AiVerdict = (typeof AI_VERDICTS)[number];

export const AI_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type AiConfidence = (typeof AI_CONFIDENCES)[number];

export const AI_CITATION_KINDS = ['alert', 'incident', 'event', 'source', 'audit'] as const;
export type AiCitationKind = (typeof AI_CITATION_KINDS)[number];

export const AI_INVOCATION_STATES = [
  'reserved',
  'dispatching',
  'settled',
  'released',
  'usage_unknown',
] as const;
export type AiInvocationState = (typeof AI_INVOCATION_STATES)[number];

export const AI_EVENT_KINDS = ['started', 'completed', 'skipped', 'failed'] as const;
export type AiEventKind = (typeof AI_EVENT_KINDS)[number];

export const NO_DATA = 'Sin dato';

export interface AiRunSubject {
  readonly kind: 'alert' | 'candidate' | 'unknown';
  readonly id: string;
  readonly title: string;
}

/**
 * Estado ACTUAL de la alerta revisada, tal como lo lee el API del modelo de lectura del SOC (no lo
 * que vio el analista). `null` en la investigación: sin `alerts.read`, sin una alerta única o la
 * alerta ya no existe; la consola lo trata como «sin dato», nunca como atendida.
 */
export interface AiRunAlert {
  readonly status: AlertStatus | 'unknown';
  /** Enmascarado por la API. */
  readonly assigneeId: string | null;
  /** Solo `true` explícito: la alerta está asignada a quien mira la consola. */
  readonly assignedToYou: boolean;
  readonly verdict: AlertVerdict | 'unknown' | null;
  readonly incidentId: string | null;
  /** Solo `true` explícito: el incidente lo abrió o adjuntó el propio analista. */
  readonly incidentByAnalyst: boolean;
}

export interface AiRunSummary {
  readonly id: string;
  readonly status: AiRunStatusView;
  /** Etapa actual; texto crudo si la consola no la conoce. */
  readonly stage: string | null;
  readonly priority: Priority | null;
  readonly trigger: 'system' | 'user' | 'unknown';
  /** Ya enmascarado por la API. */
  readonly initiatedBy: string | null;
  readonly subject: AiRunSubject;
  readonly alertCount: number | null;
  /** `null`: todavía no se decidió (o no llegó) el nivel de inferencia. */
  readonly inference: AiInference | 'unknown' | null;
  readonly verdict: AiVerdict | 'unknown' | null;
  readonly confidence: AiConfidence | 'unknown' | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly finishedAt: string | null;
  /** `null` impide enviar comandos: sin revisión no hay concurrencia optimista. */
  readonly revision: number | null;
  readonly estimatedCostMicroUsd: number | null;
  /** Tipos de acción que el analista EJECUTÓ (no las planificadas ni omitidas). */
  readonly actionKinds: readonly string[];
  /** Estado actual de la alerta revisada; `null` = sin dato (ver `AiRunAlert`). */
  readonly alert: AiRunAlert | null;
}

export type AiEventDetail = Readonly<Record<string, string | number | boolean>>;

export interface AiRunEvent {
  readonly sequence: number;
  readonly at: string | null;
  readonly stage: string;
  readonly kind: AiEventKind | 'unknown';
  readonly detail: AiEventDetail;
}

export interface AiEvidenceSource {
  readonly id: string;
  readonly label: string;
  readonly state: string;
  readonly fresh: boolean | null;
}

export interface AiEvidence {
  /** `null`: el backend no informó si la evidencia está completa (no se asume que sí). */
  readonly complete: boolean | null;
  readonly truncated: boolean | null;
  readonly alertsScanned: number | null;
  readonly eventsScanned: number | null;
  readonly sources: readonly AiEvidenceSource[];
  readonly gaps: readonly string[];
}

export interface AiStatement {
  readonly text: string;
  readonly citations: readonly string[];
}

export interface AiCitation {
  readonly kind: AiCitationKind | 'unknown';
  readonly id: string;
  readonly label: string;
}

export interface AiResult {
  readonly summary: string;
  readonly verdict: AiVerdict | 'unknown' | null;
  readonly confidence: AiConfidence | 'unknown' | null;
  readonly recommendedPriority: Priority | null;
  readonly facts: readonly AiStatement[];
  readonly inferences: readonly AiStatement[];
  readonly gaps: readonly string[];
  readonly nextSteps: readonly string[];
  readonly citations: readonly AiCitation[];
  /** Solo `true` explícito cuenta como verificado. */
  readonly verified: boolean;
  readonly deterministicReasons: readonly string[];
}

export interface AiUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
}

export interface AiInvocation {
  readonly phase: string;
  readonly tier: 'economy' | 'advanced' | 'unknown';
  readonly model: string;
  readonly state: AiInvocationState | 'unknown';
  readonly estimatedMicroUsd: number | null;
}

export interface AiRunDetail extends AiRunSummary {
  readonly policyVersion: string | null;
  readonly attempt: number | null;
  readonly lastErrorCode: string | null;
  readonly cancelRequested: boolean;
  readonly alertIds: readonly string[];
  readonly events: readonly AiRunEvent[];
  readonly evidence: AiEvidence | null;
  readonly result: AiResult | null;
  readonly usage: AiUsage | null;
  readonly invocations: readonly AiInvocation[];
  readonly actions: readonly AiRunAction[];
}

export interface AiRunPage {
  readonly items: readonly AiRunSummary[];
  readonly nextCursor: string | null;
}

export interface AiBudget {
  /** `null`: el backend no lo informó; no se asume ni habilitado ni deshabilitado. */
  readonly enabled: boolean | null;
  readonly mode: string | null;
  readonly inferenceEnabled: boolean | null;
  readonly day: {
    readonly date: string | null;
    readonly limitMicroUsd: number | null;
    readonly reservedMicroUsd: number | null;
    readonly settledMicroUsd: number | null;
    readonly unknownInvocations: number | null;
  };
  readonly tokens: {
    readonly input: number | null;
    readonly output: number | null;
    readonly cacheRead: number | null;
    readonly cacheWrite: number | null;
  };
  readonly runs: {
    readonly today: number | null;
    readonly withoutInference: number | null;
    readonly economy: number | null;
    readonly advanced: number | null;
  };
  readonly rateCardVersion: string | null;
  /** Solo `connected` explícito permitiría hablar de facturación; hoy siempre es `not_connected`. */
  readonly billing: string;
}

// ------------------------------------------------------------------ Normalizadores

type Bag = Record<string, unknown>;

function bag(value: unknown): Bag | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Bag)
    : null;
}

function text(value: unknown, max = 4000): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

/** Número finito y no negativo; cualquier otra cosa es «sin dato», nunca 0. */
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** `null` se conserva; un valor presente pero desconocido queda como `unknown`. */
function enumOrUnknown<T extends string>(allowed: readonly T[], value: unknown): T | 'unknown' | null {
  if (value === null || value === undefined) return null;
  return oneOf(allowed, value) ?? 'unknown';
}

function isoOrNull(value: unknown): string | null {
  const raw = text(value, 64);
  if (!raw) return null;
  return Number.isNaN(new Date(raw).getTime()) ? null : raw;
}

function list(value: unknown, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function strings(value: unknown, max: number, maxLength = 2000): string[] {
  const out: string[] = [];
  for (const item of list(value, max)) {
    const parsed = text(item, maxLength);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function normalizeRunAlert(raw: unknown): AiRunAlert | null {
  const value = bag(raw);
  if (!value || value.status === undefined || value.status === null) return null;
  return {
    status: oneOf(ALERT_STATUSES, value.status) ?? 'unknown',
    assigneeId: text(value.assigneeId, 200),
    assignedToYou: value.assignedToYou === true,
    verdict: enumOrUnknown(ALERT_VERDICTS, value.verdict),
    incidentId: text(value.incidentId, 128),
    incidentByAnalyst: value.incidentByAnalyst === true,
  };
}

export function normalizeRunSummary(raw: unknown): AiRunSummary | null {
  const value = bag(raw);
  const id = value ? text(value.id, 128) : null;
  if (!value || !id) return null;
  const subject = bag(value.subject);
  const subjectKind = subject ? oneOf(['alert', 'candidate'] as const, subject.kind) : null;
  return {
    id,
    status: oneOf(AI_RUN_STATUSES, value.status) ?? 'unknown',
    stage: text(value.stage, 64),
    priority: oneOf(PRIORITIES, value.priority),
    trigger: oneOf(['system', 'user'] as const, value.trigger) ?? 'unknown',
    initiatedBy: text(value.initiatedBy, 200),
    subject: {
      kind: subjectKind ?? 'unknown',
      id: (subject ? text(subject.id, 128) : null) ?? '',
      title: (subject ? text(subject.title, 500) : null) ?? '',
    },
    alertCount: count(value.alertCount),
    inference: enumOrUnknown(AI_INFERENCE_TIERS, value.inference),
    verdict: enumOrUnknown(AI_VERDICTS, value.verdict),
    confidence: enumOrUnknown(AI_CONFIDENCES, value.confidence),
    createdAt: isoOrNull(value.createdAt),
    updatedAt: isoOrNull(value.updatedAt),
    finishedAt: isoOrNull(value.finishedAt),
    revision: count(value.revision),
    estimatedCostMicroUsd: count(value.estimatedCostMicroUsd),
    actionKinds: Array.from(new Set(strings(value.actionKinds, 10, 64))),
    alert: normalizeRunAlert(value.alert),
  };
}

function normalizeDetailBag(raw: unknown): AiEventDetail {
  const value = bag(raw);
  if (!value) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(value).slice(0, 12)) {
    const item = value[key];
    if (typeof item === 'string') out[key.slice(0, 64)] = item.slice(0, 200);
    else if (typeof item === 'boolean') out[key.slice(0, 64)] = item;
    else if (typeof item === 'number' && Number.isFinite(item)) out[key.slice(0, 64)] = item;
  }
  return out;
}

function normalizeEvents(raw: unknown): AiRunEvent[] {
  const events: AiRunEvent[] = [];
  list(raw, 200).forEach((item, index) => {
    const value = bag(item);
    const stage = value ? text(value.stage, 64) : null;
    if (!value || !stage) return;
    const sequence = count(value.sequence);
    events.push({
      sequence: sequence === null ? index : sequence,
      at: isoOrNull(value.at),
      stage,
      kind: oneOf(AI_EVENT_KINDS, value.kind) ?? 'unknown',
      detail: normalizeDetailBag(value.detail),
    });
  });
  // Orden estable por secuencia: el servidor es la fuente del orden, no el reloj del navegador.
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.sequence - b.event.sequence || a.index - b.index)
    .map((entry) => entry.event);
}

function normalizeEvidence(raw: unknown): AiEvidence | null {
  const value = bag(raw);
  if (!value) return null;
  const sources: AiEvidenceSource[] = [];
  for (const item of list(value.sources, 50)) {
    const source = bag(item);
    const id = source ? text(source.id, 128) : null;
    if (!source || !id) continue;
    sources.push({
      id,
      label: text(source.label, 200) ?? id,
      state: text(source.state, 64) ?? 'unknown',
      fresh: flag(source.fresh),
    });
  }
  return {
    complete: flag(value.complete),
    truncated: flag(value.truncated),
    alertsScanned: count(value.alertsScanned),
    eventsScanned: count(value.eventsScanned),
    sources,
    gaps: strings(value.gaps, 50),
  };
}

function normalizeStatements(raw: unknown): AiStatement[] {
  const out: AiStatement[] = [];
  for (const item of list(raw, 50)) {
    const value = bag(item);
    const body = value ? text(value.text) : null;
    if (!value || !body) continue;
    out.push({ text: body, citations: strings(value.citations, 20, 200) });
  }
  return out;
}

function normalizeResult(raw: unknown): AiResult | null {
  const value = bag(raw);
  if (!value) return null;
  const citations: AiCitation[] = [];
  for (const item of list(value.citations, 100)) {
    const citation = bag(item);
    const id = citation ? text(citation.id, 200) : null;
    if (!citation || !id) continue;
    citations.push({
      kind: oneOf(AI_CITATION_KINDS, citation.kind) ?? 'unknown',
      id,
      label: text(citation.label, 300) ?? id,
    });
  }
  const deterministic = bag(value.deterministic);
  return {
    summary: text(value.summary, 8000) ?? '',
    verdict: enumOrUnknown(AI_VERDICTS, value.verdict),
    confidence: enumOrUnknown(AI_CONFIDENCES, value.confidence),
    recommendedPriority: oneOf(PRIORITIES, value.recommendedPriority),
    facts: normalizeStatements(value.facts),
    inferences: normalizeStatements(value.inferences),
    gaps: strings(value.gaps, 50),
    nextSteps: strings(value.nextSteps, 50),
    citations,
    verified: value.verified === true,
    deterministicReasons: deterministic ? strings(deterministic.reasons, 20, 64) : [],
  };
}

function normalizeUsage(raw: unknown): AiUsage | null {
  const value = bag(raw);
  if (!value) return null;
  return {
    inputTokens: count(value.inputTokens),
    outputTokens: count(value.outputTokens),
    cacheReadTokens: count(value.cacheReadTokens),
    cacheWriteTokens: count(value.cacheWriteTokens),
  };
}

function normalizeInvocations(raw: unknown): AiInvocation[] {
  const out: AiInvocation[] = [];
  for (const item of list(raw, 50)) {
    const value = bag(item);
    if (!value) continue;
    out.push({
      phase: text(value.phase, 64) ?? NO_DATA,
      tier: oneOf(['economy', 'advanced'] as const, value.tier) ?? 'unknown',
      model: text(value.model, 120) ?? NO_DATA,
      state: oneOf(AI_INVOCATION_STATES, value.state) ?? 'unknown',
      estimatedMicroUsd: count(value.estimatedMicroUsd),
    });
  }
  return out;
}

export function normalizeRunDetail(raw: unknown): AiRunDetail | null {
  const summary = normalizeRunSummary(raw);
  const value = bag(raw);
  if (!summary || !value) return null;
  return {
    ...summary,
    policyVersion: text(value.policyVersion, 64),
    attempt: count(value.attempt),
    lastErrorCode: text(value.lastErrorCode, 128),
    cancelRequested: value.cancelRequested === true,
    alertIds: strings(value.alertIds, 200, 128),
    events: normalizeEvents(value.events),
    evidence: normalizeEvidence(value.evidence),
    result: normalizeResult(value.result),
    usage: normalizeUsage(value.usage),
    invocations: normalizeInvocations(value.invocations),
    actions: normalizeActions(value.actions),
  };
}

export function normalizeRunPage(raw: unknown): AiRunPage {
  const value = bag(raw);
  const items: AiRunSummary[] = [];
  const seen = new Set<string>();
  for (const item of list(value ? value.items : null, 200)) {
    const run = normalizeRunSummary(item);
    if (!run || seen.has(run.id)) continue;
    seen.add(run.id);
    items.push(run);
  }
  return { items, nextCursor: value ? text(value.nextCursor, 2000) : null };
}

export function normalizeBudget(raw: unknown): AiBudget {
  const value = bag(raw) ?? {};
  const day = bag(value.day) ?? {};
  const tokens = bag(value.tokens) ?? {};
  const runs = bag(value.runs) ?? {};
  return {
    enabled: flag(value.enabled),
    mode: text(value.mode, 32),
    inferenceEnabled: flag(value.inferenceEnabled),
    day: {
      date: text(day.date, 32),
      limitMicroUsd: count(day.limitMicroUsd),
      reservedMicroUsd: count(day.reservedMicroUsd),
      settledMicroUsd: count(day.settledMicroUsd),
      unknownInvocations: count(day.unknownInvocations),
    },
    tokens: {
      input: count(tokens.input),
      output: count(tokens.output),
      cacheRead: count(tokens.cacheRead),
      cacheWrite: count(tokens.cacheWrite),
    },
    runs: {
      today: count(runs.today),
      withoutInference: count(runs.withoutInference),
      economy: count(runs.economy),
      advanced: count(runs.advanced),
    },
    rateCardVersion: text(value.rateCardVersion, 64),
    billing: text(value.billing, 32) ?? 'not_connected',
  };
}

// ------------------------------------------------------------------ Rótulos

export const AI_RUN_STATUS_LABEL: Record<AiRunStatusView, string> = {
  queued: 'En cola',
  running: 'En curso',
  completed: 'Completada',
  requires_review: 'Requiere revisión',
  partial: 'Parcial',
  budget_exhausted: 'Presupuesto agotado',
  usage_unreconciled: 'Uso por conciliar',
  cancelled: 'Detenida',
  failed: 'Fallida',
  unknown: 'Estado desconocido',
};

export const AI_RUN_STATUS_TONE: Record<AiRunStatusView, HealthTone> = {
  queued: 'neutral',
  running: 'info',
  completed: 'ok',
  requires_review: 'warn',
  partial: 'warn',
  budget_exhausted: 'warn',
  usage_unreconciled: 'warn',
  cancelled: 'neutral',
  failed: 'fail',
  unknown: 'neutral',
};

export const AI_STAGE_LABEL: Record<AiRunStage, string> = {
  fetching_evidence: 'Recolección de evidencia',
  triage: 'Triaje determinista',
  model: 'Consulta al modelo',
  validating: 'Validación de citas',
  acting: 'Acciones del analista',
  writing: 'Registro del resultado',
};

/** Etapa conocida → rótulo; desconocida → `null` (la UI muestra el código crudo en mono). */
export function stageLabel(stage: string | null): string | null {
  if (!stage) return null;
  const known = oneOf(AI_RUN_STAGES, stage);
  return known ? AI_STAGE_LABEL[known] : null;
}

export const AI_INFERENCE_LABEL: Record<AiInference | 'unknown', string> = {
  none: 'Sin IA',
  economy: 'Económico',
  advanced: 'Avanzado',
  unknown: 'Nivel desconocido',
};

export function inferenceLabel(inference: AiRunSummary['inference']): string {
  return inference === null ? NO_DATA : AI_INFERENCE_LABEL[inference];
}

export const AI_VERDICT_LABEL: Record<AiVerdict | 'unknown', string> = {
  likely_true_positive: 'Probable verdadero positivo',
  likely_false_positive: 'Probable falso positivo',
  inconclusive: 'No concluyente',
  unknown: 'Veredicto desconocido',
};

export function verdictLabel(verdict: AiRunSummary['verdict']): string {
  return verdict === null ? 'Sin veredicto' : AI_VERDICT_LABEL[verdict];
}

export const AI_CONFIDENCE_LABEL: Record<AiConfidence | 'unknown', string> = {
  low: 'Confianza baja',
  medium: 'Confianza media',
  high: 'Confianza alta',
  unknown: 'Confianza desconocida',
};

export function confidenceLabel(confidence: AiRunSummary['confidence']): string {
  return confidence === null ? 'Confianza sin dato' : AI_CONFIDENCE_LABEL[confidence];
}

export const AI_TRIGGER_LABEL: Record<AiRunSummary['trigger'], string> = {
  system: 'Automática',
  user: 'Manual',
  unknown: 'Origen desconocido',
};

export const AI_INVOCATION_STATE_LABEL: Record<AiInvocationState | 'unknown', string> = {
  reserved: 'Presupuesto reservado',
  dispatching: 'Llamada en envío',
  settled: 'Uso confirmado',
  released: 'Reserva liberada',
  usage_unknown: 'Uso por conciliar',
  unknown: 'Estado desconocido',
};

export const AI_INVOCATION_STATE_TONE: Record<AiInvocationState | 'unknown', HealthTone> = {
  reserved: 'info',
  dispatching: 'info',
  settled: 'ok',
  released: 'neutral',
  usage_unknown: 'warn',
  unknown: 'neutral',
};

export const AI_CITATION_KIND_LABEL: Record<AiCitationKind | 'unknown', string> = {
  alert: 'Alerta',
  incident: 'Incidente',
  event: 'Evento',
  source: 'Fuente',
  audit: 'Auditoría',
  unknown: 'Referencia',
};

export const AI_EVENT_KIND_LABEL: Record<AiStepStatus, string> = {
  running: 'En curso',
  completed: 'Completa',
  skipped: 'Omitida',
  failed: 'Falló',
  interrupted: 'Sin cierre registrado',
  unknown: 'Estado desconocido',
};

export const AI_DETERMINISTIC_REASON_LABEL: Record<string, string> = {
  KNOWN_BENIGN_PATTERN: 'Coincide con un patrón benigno conocido',
  DUPLICATE_OF_OPEN_INCIDENT: 'Duplica un incidente que ya está abierto',
  ISOLATED_LOW_SIGNAL: 'Señal aislada de baja relevancia',
  EVIDENCE_INCOMPLETE: 'La evidencia disponible está incompleta',
  NOT_ELIGIBLE: 'No es elegible para análisis con modelo',
};

/** Rótulo de un motivo determinista; `null` ⇒ la UI muestra el código crudo en mono. */
export function deterministicReasonLabel(code: string): string | null {
  return Object.prototype.hasOwnProperty.call(AI_DETERMINISTIC_REASON_LABEL, code)
    ? AI_DETERMINISTIC_REASON_LABEL[code]
    : null;
}

/** Estado de una fuente de evidencia; desconocido ⇒ `null` (se muestra el código crudo). */
export function evidenceSourceStateLabel(state: string): string | null {
  const known = oneOf(SOURCE_STATES, state);
  return known ? SOURCE_STATE_LABEL[known as SourceState] : null;
}

// ------------------------------------------------------------------ Reglas puras

const ACTIVE: readonly AiRunStatusView[] = ['queued', 'running'];
const RETRIABLE: readonly AiRunStatusView[] = ['failed', 'partial', 'budget_exhausted', 'cancelled'];

/** En cola o en curso: lo único que justifica refrescar en vivo. */
export function isActive(status: AiRunStatusView): boolean {
  return ACTIVE.includes(status);
}

/** Un estado desconocido no es terminal ni activo: ni se sondea ni se ofrece una acción. */
export function isTerminal(status: AiRunStatusView): boolean {
  return status !== 'unknown' && !isActive(status);
}

type Actionable = Pick<AiRunSummary, 'status' | 'revision'> & { readonly cancelRequested?: boolean };

export function canCancel(run: Actionable): boolean {
  return isActive(run.status) && run.revision !== null && run.cancelRequested !== true;
}

/**
 * `usage_unreconciled` no se reintenta desde la consola: hay una llamada cuyo consumo no se
 * confirmó y repetirla podría duplicar el gasto. `requires_review` y `completed` ya terminaron.
 */
export function canRetry(run: Actionable): boolean {
  return RETRIABLE.includes(run.status) && run.revision !== null;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
/** Segmentos de ruta reservados bajo `/ai-investigations/`: nunca son un id. */
const RESERVED_IDS: readonly string[] = ['budget', 'settings', 'digest', 'activity'];

export function isValidAiRunId(id: unknown): id is string {
  return typeof id === 'string' && RUN_ID.test(id) && !RESERVED_IDS.includes(id.toLowerCase());
}

export function isValidAlertId(id: unknown): id is string {
  return typeof id === 'string' && RUN_ID.test(id);
}

/** Código de error apto para mostrar: solo un identificador corto; el resto no se pinta. */
export function sanitizeErrorCode(code: string | null): string | null {
  if (!code) return null;
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u.test(code) ? code : null;
}

// ------------------------------------------------------------------ Formato

function decimalComma(value: number, digits: number): string {
  const [whole, fraction] = value.toFixed(digits).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ' ');
  return fraction ? `${grouped},${fraction}` : grouped;
}

/** Monto en micro-USD sin la coletilla: «US$ 0,0123». `null` si no hay dato. */
export function microUsdAmount(microUsd: number | null): string | null {
  if (microUsd === null || !Number.isFinite(microUsd) || microUsd < 0) return null;
  const usd = microUsd / 1000000;
  if (microUsd === 0) return 'US$ 0,00';
  if (usd < 0.0001) return 'menos de US$ 0,0001';
  return `US$ ${decimalComma(usd, usd < 1 ? 4 : 2)}`;
}

/** Costo SIEMPRE rotulado como estimación: «US$ 0,0123 (estimado)»; sin dato ⇒ «Sin dato». */
export function formatMicroUsd(microUsd: number | null): string {
  const amount = microUsdAmount(microUsd);
  return amount === null ? NO_DATA : `${amount} (estimado)`;
}

export function formatCount(value: number | null): string {
  return value === null ? NO_DATA : value.toLocaleString('es-PE');
}

/** Duración legible («45 s», «2 min 05 s», «1 h 03 min»); `null` si no se puede medir. */
export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

export function elapsedMs(from: string | null, to: string | number | null): number | null {
  if (!from || to === null) return null;
  const start = new Date(from).getTime();
  const end = typeof to === 'number' ? to : new Date(to).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return end - start;
}

/** Porción de corridas del día resueltas sin llamar al modelo; `null` si no se puede calcular. */
export function shareWithoutInference(budget: AiBudget): number | null {
  const { today, withoutInference } = budget.runs;
  if (today === null || withoutInference === null || today <= 0 || withoutInference > today) {
    return null;
  }
  return withoutInference / today;
}

export function formatShare(share: number | null): string {
  if (share === null) return NO_DATA;
  return `${decimalComma(share * 100, share === 1 || share === 0 ? 0 : 1)} %`;
}

/** La inferencia está apagada si el backend lo dice o si no hay techo diario configurado. */
export function inferenceOff(budget: AiBudget): boolean {
  return budget.inferenceEnabled === false || budget.day.limitMicroUsd === null;
}

// ------------------------------------------------------------------ Línea de progreso

export type AiStepStatus = 'running' | 'completed' | 'skipped' | 'failed' | 'interrupted' | 'unknown';

export interface AiProgressStep {
  readonly key: string;
  readonly stage: string;
  readonly status: AiStepStatus;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly detail: AiEventDetail;
}

/**
 * Proyecta los eventos del servidor en pasos. No inventa etapas pendientes ni porcentajes: solo
 * aparece lo que el backend registró. Un paso `started` sin cierre queda «en curso» mientras la
 * corrida sigue activa y «sin cierre registrado» cuando ya terminó.
 */
export function buildProgressTimeline(
  events: readonly AiRunEvent[],
  runActive: boolean,
): AiProgressStep[] {
  const steps: AiProgressStep[] = [];
  for (const event of events) {
    if (event.kind === 'started') {
      steps.push({
        key: `${event.stage}:${event.sequence}`,
        stage: event.stage,
        status: 'running',
        startedAt: event.at,
        endedAt: null,
        durationMs: null,
        detail: event.detail,
      });
      continue;
    }
    let open = -1;
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      if (steps[index].stage === event.stage && steps[index].status === 'running') {
        open = index;
        break;
      }
    }
    if (open >= 0) {
      const step = steps[open];
      steps[open] = {
        ...step,
        status: event.kind,
        endedAt: event.at,
        durationMs: elapsedMs(step.startedAt, event.at),
        detail: { ...step.detail, ...event.detail },
      };
    } else {
      steps.push({
        key: `${event.stage}:${event.sequence}`,
        stage: event.stage,
        status: event.kind,
        startedAt: null,
        endedAt: event.at,
        durationMs: null,
        detail: event.detail,
      });
    }
  }
  if (runActive) return steps;
  return steps.map((step) =>
    step.status === 'running' ? { ...step, status: 'interrupted' as const } : step,
  );
}

/** Une una página nueva con la lista visible: actualiza las que ya estaban y antepone las nuevas. */
export function mergeRuns(
  current: readonly AiRunSummary[],
  incoming: readonly AiRunSummary[],
): AiRunSummary[] {
  const fresh = new Map<string, AiRunSummary>();
  for (const run of incoming) fresh.set(run.id, run);
  const known = new Set(current.map((run) => run.id));
  const added = incoming.filter((run) => !known.has(run.id));
  return [...added, ...current.map((run) => fresh.get(run.id) ?? run)];
}

// ------------------------------------------------------------------ Modo de operación

export const AI_MODES = ['shadow', 'assisted', 'autonomous'] as const;
export type AiMode = (typeof AI_MODES)[number];

export const AI_MODE_LABEL: Record<AiMode, string> = {
  shadow: 'Modo sombra',
  assisted: 'Modo asistido',
  autonomous: 'Modo autónomo',
};

export const AI_MODE_NAME: Record<AiMode, string> = {
  shadow: 'Sombra',
  assisted: 'Asistido',
  autonomous: 'Autónomo',
};

/** Qué hace y qué no hace el analista en cada modo (una línea, sin adornos). */
export const AI_MODE_SUMMARY: Record<AiMode, string> = {
  shadow: 'solo recomienda; no cambia alertas ni notifica',
  assisted: 'recomienda y pide revisión humana por notificación; no cambia alertas',
  autonomous: 'ejecuta las acciones permitidas, cierra lo benigno con una nota y solo avisa a una persona ante peligro',
};

export function parseMode(value: unknown): AiMode | null {
  return oneOf(AI_MODES, value);
}

// ------------------------------------------------------------------ Acciones del analista

export const AI_ACTION_KINDS = [
  'escalate',
  'request_review',
  'acknowledge',
  'close_benign',
  'report',
] as const;
export type AiActionKind = (typeof AI_ACTION_KINDS)[number];

export const AI_ACTION_STATES = ['planned', 'executed', 'skipped', 'failed'] as const;
export type AiActionState = (typeof AI_ACTION_STATES)[number];

export const AI_ACTION_REF_KINDS = ['alert', 'incident', 'notification', 'report'] as const;
export type AiActionRefKind = (typeof AI_ACTION_REF_KINDS)[number];

export interface AiRunAction {
  readonly id: string;
  readonly kind: AiActionKind | 'unknown';
  /** Código crudo cuando `kind` es desconocido. */
  readonly rawKind: string;
  readonly state: AiActionState | 'unknown';
  readonly reason: string | null;
  readonly at: string | null;
  readonly executedAt: string | null;
  readonly ref: { readonly kind: AiActionRefKind | 'unknown'; readonly id: string } | null;
  readonly errorCode: string | null;
}

function normalizeActions(raw: unknown): AiRunAction[] {
  const out: AiRunAction[] = [];
  list(raw, 50).forEach((item, index) => {
    const value = bag(item);
    if (!value) return;
    const ref = bag(value.ref);
    const refId = ref ? text(ref.id, 200) : null;
    out.push({
      id: text(value.id, 128) ?? `action-${index}`,
      kind: oneOf(AI_ACTION_KINDS, value.kind) ?? 'unknown',
      rawKind: text(value.kind, 64) ?? '',
      state: oneOf(AI_ACTION_STATES, value.state) ?? 'unknown',
      reason: text(value.reason, 64),
      at: isoOrNull(value.at),
      executedAt: isoOrNull(value.executedAt),
      ref:
        ref && refId ? { kind: oneOf(AI_ACTION_REF_KINDS, ref.kind) ?? 'unknown', id: refId } : null,
      errorCode: text(value.errorCode, 128),
    });
  });
  return out;
}

export const AI_ACTION_KIND_LABEL: Record<AiActionKind | 'unknown', string> = {
  escalate: 'Escalar a incidente',
  request_review: 'Pedir revisión humana',
  acknowledge: 'Reconocer la alerta',
  close_benign: 'Cerrar como benigna conocida',
  report: 'Generar informe',
  unknown: 'Acción desconocida',
};

/** Rótulo corto para la columna compacta de la lista (acciones ya ejecutadas). */
export const AI_ACTION_KIND_SHORT: Record<AiActionKind, string> = {
  escalate: 'Escaló',
  request_review: 'Pidió revisión',
  acknowledge: 'Reconoció',
  close_benign: 'Cerró benigna',
  report: 'Informe',
};

export function actionKindShort(kind: string): string | null {
  const known = oneOf(AI_ACTION_KINDS, kind);
  return known ? AI_ACTION_KIND_SHORT[known] : null;
}

/** Solo `executed` significa que algo cambió; `planned` es una propuesta que no se aplicó. */
export const AI_ACTION_STATE_LABEL: Record<AiActionState | 'unknown', string> = {
  planned: 'Propuesta, no ejecutada',
  executed: 'Ejecutada',
  skipped: 'Omitida',
  failed: 'Falló, no se aplicó',
  unknown: 'Estado desconocido',
};

export const AI_ACTION_STATE_TONE: Record<AiActionState | 'unknown', HealthTone> = {
  planned: 'info',
  executed: 'ok',
  skipped: 'neutral',
  failed: 'fail',
  unknown: 'neutral',
};

/**
 * Motivos de una acción. El backend es la fuente de los códigos; uno que esta consola no
 * conoce se muestra crudo en mono.
 */
export const AI_ACTION_REASON_LABEL: Record<string, string> = {
  MODE_SHADOW: 'El modo sombra no ejecuta acciones',
  MODE_ASSISTED: 'El modo asistido no cambia alertas',
  ACTION_DISABLED: 'La acción está desactivada en la configuración',
  ANALYST_DISABLED: 'El analista está desactivado',
  OUT_OF_SCOPE: 'La prioridad de la alerta está fuera del alcance configurado',
  PRIORITY_NOT_ALLOWED: 'La prioridad de la alerta no permite esta acción',
  CONFIDENCE_BELOW_MINIMUM: 'La confianza no alcanza el mínimo configurado',
  GUARD_NOT_MET: 'No se cumplieron las condiciones de seguridad de la acción',
  INSUFFICIENT_HISTORY: 'No hay suficiente historial benigno del patrón',
  PRIOR_TRUE_POSITIVE: 'El patrón tuvo verdaderos positivos antes',
  ALREADY_HANDLED: 'Una persona ya había atendido la alerta',
  ALERT_CHANGED: 'La alerta cambió mientras se investigaba',
  VERDICT_TRUE_POSITIVE: 'El veredicto apunta a un verdadero positivo',
  REQUIRES_REVIEW: 'El resultado requiere revisión humana',
  POLICY: 'Lo indica la política de investigación',
  // Catálogo del backend (`ACTION_REASON_CODES`, modules/assistant/src/investigations/actions.ts).
  ESCALATE_VERIFIED_TRUE_POSITIVE: 'Verdadero positivo verificado con la confianza exigida',
  ESCALATE_CORRELATED_P1: 'P1 correlacionada con otras alertas',
  CLOSE_KNOWN_BENIGN: 'Patrón benigno conocido que cumple todas las condiciones de cierre',
  ACKNOWLEDGE_INVESTIGATED: 'El analista ya investigó la alerta',
  REPORT_PER_RUN: 'Informe de cada investigación',
  REVIEW_ESCALATION_RECOMMENDED: 'Se recomienda escalar; decide una persona',
  REVIEW_ESCALATION_NOT_VERIFIED: 'Posible verdadero positivo sin verificación suficiente',
  REVIEW_REQUIRES_REVIEW: 'El resultado requiere revisión humana',
  REVIEW_PARTIAL: 'La evidencia quedó incompleta',
  REVIEW_BUDGET_EXHAUSTED: 'Se agotó el presupuesto diario de IA',
  REVIEW_USAGE_UNRECONCILED: 'Hay una llamada al modelo cuyo uso no se confirmó',
  REVIEW_FAILED: 'La investigación falló',
  REVIEW_STATE_CHANGE_NOTICE: 'Aviso de un cambio hecho por el analista',
};

export function actionReasonLabel(code: string): string | null {
  if (Object.prototype.hasOwnProperty.call(AI_ACTION_REASON_LABEL, code)) {
    return AI_ACTION_REASON_LABEL[code];
  }
  return deterministicReasonLabel(code);
}

/** Acciones que modifican la alerta (frente a avisar o generar un informe). */
const ALERT_CHANGING: readonly string[] = ['escalate', 'acknowledge', 'close_benign'];

export function executedActions(actions: readonly AiRunAction[]): AiRunAction[] {
  return actions.filter((action) => action.state === 'executed');
}

export function changedAlert(actions: readonly AiRunAction[]): boolean {
  return executedActions(actions).some((action) => ALERT_CHANGING.includes(action.kind));
}

// ------------------------------------------------------------------ Configuración

export const AI_SETTINGS_ACTIONS = [
  'escalate',
  'requestReview',
  'acknowledge',
  'closeBenign',
  'attachReport',
] as const;
export type AiSettingsAction = (typeof AI_SETTINGS_ACTIONS)[number];

export const AI_REVIEW_STATUSES = [
  'requires_review',
  'budget_exhausted',
  'usage_unreconciled',
  'partial',
  'failed',
] as const;
export type AiReviewStatus = (typeof AI_REVIEW_STATUSES)[number];

export const AI_INFERENCE_MIN_PRIORITIES = ['P1', 'P2', 'P3'] as const;
export type AiInferenceMinPriority = (typeof AI_INFERENCE_MIN_PRIORITIES)[number];
export const AI_CLOSE_MAX_PRIORITIES = ['P3', 'P4'] as const;
export type AiCloseMaxPriority = (typeof AI_CLOSE_MAX_PRIORITIES)[number];
export const AI_MIN_CONFIDENCES = ['medium', 'high'] as const;
export type AiMinConfidence = (typeof AI_MIN_CONFIDENCES)[number];
export const AI_DIGEST_MODES = ['off', 'daily'] as const;
export type AiDigestMode = (typeof AI_DIGEST_MODES)[number];

export const AI_SETTINGS_LIMITS = {
  minHistoryMin: 3,
  minHistoryMax: 50,
  hourMin: 0,
  hourMax: 23,
  instructionsMax: 1000,
  /** Mismo rango que `ANALYST_SETTINGS_LIMITS.maxOutputTokens` del backend. */
  maxOutputTokensMin: 200,
  maxOutputTokensMax: 4000,
} as const;

export interface AnalystSettingsInput {
  readonly enabled: boolean;
  readonly mode: AiMode;
  readonly scope: {
    readonly priorities: readonly Priority[];
    readonly inferenceMinPriority: AiInferenceMinPriority;
  };
  readonly actions: Readonly<Record<AiSettingsAction, boolean>>;
  readonly escalation: {
    readonly minConfidence: AiMinConfidence;
    readonly priorities: readonly Priority[];
  };
  readonly closeBenign: {
    readonly maxPriority: AiCloseMaxPriority;
    readonly minHistory: number;
  };
  readonly review: {
    readonly notifyPriorities: readonly Priority[];
    readonly notifyOnStatuses: readonly AiReviewStatus[];
  };
  readonly budget: {
    /** `null`: IA desactivada (solo reglas deterministas). */
    readonly dailyCeilingMicroUsd: number | null;
    readonly maxOutputTokens: number;
    readonly advancedTierEnabled: boolean;
  };
  readonly reports: {
    readonly perRun: boolean;
    readonly digest: AiDigestMode;
    readonly digestHourLima: number;
  };
  readonly instructions: string;
}

export interface AnalystSettings extends AnalystSettingsInput {
  readonly revision: number;
  readonly updatedAt: string | null;
  /** Ya enmascarado por la API. */
  readonly updatedBy: string | null;
}

export interface AnalystSettingsView {
  readonly settings: AnalystSettings;
  readonly canConfigure: boolean;
  /**
   * Interruptor del despliegue (`QAPAQ_ANALYST_ENABLED`). `false`: el proceso del analista no corre
   * en este entorno y lo guardado aquí no tiene efecto hasta encenderlo. `null`: la API no lo dijo.
   */
  readonly deploymentEnabled: boolean | null;
}

/** Lista de enums estricta: un elemento desconocido invalida la lectura completa. */
function strictList<T extends string>(allowed: readonly T[], value: unknown): T[] | null {
  if (!Array.isArray(value)) return null;
  const seen: T[] = [];
  for (const item of value) {
    const parsed = oneOf(allowed, item);
    if (!parsed) return null;
    if (!seen.includes(parsed)) seen.push(parsed);
  }
  return allowed.filter((item) => seen.includes(item));
}

/**
 * Lectura ESTRICTA de la configuración: como el formulario la devuelve entera con un PUT, un
 * campo ausente o desconocido no se rellena con un valor por defecto (podría guardarse sin que
 * nadie lo eligiera). Si algo no cuadra, devuelve `null` y la vista no permite editar.
 */
export function normalizeSettings(raw: unknown): AnalystSettings | null {
  const value = bag(raw);
  if (!value) return null;
  const scope = bag(value.scope);
  const actions = bag(value.actions);
  const escalation = bag(value.escalation);
  const closeBenign = bag(value.closeBenign);
  const review = bag(value.review);
  const budget = bag(value.budget);
  const reports = bag(value.reports);
  if (!scope || !actions || !escalation || !closeBenign || !review || !budget || !reports) {
    return null;
  }
  const revision = count(value.revision);
  const enabled = flag(value.enabled);
  const mode = parseMode(value.mode);
  const priorities = strictList(PRIORITIES, scope.priorities);
  const inferenceMinPriority = oneOf(AI_INFERENCE_MIN_PRIORITIES, scope.inferenceMinPriority);
  const escalate = flag(actions.escalate);
  const requestReview = flag(actions.requestReview);
  const acknowledge = flag(actions.acknowledge);
  const closeBenignOn = flag(actions.closeBenign);
  const attachReport = flag(actions.attachReport);
  const minConfidence = oneOf(AI_MIN_CONFIDENCES, escalation.minConfidence);
  const escalationPriorities = strictList(PRIORITIES, escalation.priorities);
  const maxPriority = oneOf(AI_CLOSE_MAX_PRIORITIES, closeBenign.maxPriority);
  const minHistory = count(closeBenign.minHistory);
  const notifyPriorities = strictList(PRIORITIES, review.notifyPriorities);
  const notifyOnStatuses = strictList(AI_REVIEW_STATUSES, review.notifyOnStatuses);
  const ceilingRaw = budget.dailyCeilingMicroUsd;
  const ceiling = ceilingRaw === null ? null : count(ceilingRaw);
  const maxOutputTokens = count(budget.maxOutputTokens);
  const advancedTierEnabled = flag(budget.advancedTierEnabled);
  const perRun = flag(reports.perRun);
  const digest = oneOf(AI_DIGEST_MODES, reports.digest);
  const digestHourLima = count(reports.digestHourLima);
  if (
    revision === null ||
    enabled === null ||
    mode === null ||
    priorities === null ||
    inferenceMinPriority === null ||
    escalate === null ||
    requestReview === null ||
    acknowledge === null ||
    closeBenignOn === null ||
    attachReport === null ||
    minConfidence === null ||
    escalationPriorities === null ||
    maxPriority === null ||
    minHistory === null ||
    notifyPriorities === null ||
    notifyOnStatuses === null ||
    (ceilingRaw !== null && ceiling === null) ||
    maxOutputTokens === null ||
    advancedTierEnabled === null ||
    perRun === null ||
    digest === null ||
    digestHourLima === null ||
    typeof value.instructions !== 'string'
  ) {
    return null;
  }
  return {
    revision,
    updatedAt: isoOrNull(value.updatedAt),
    updatedBy: text(value.updatedBy, 200),
    enabled,
    mode,
    scope: { priorities, inferenceMinPriority },
    actions: {
      escalate,
      requestReview,
      acknowledge,
      closeBenign: closeBenignOn,
      attachReport,
    },
    escalation: { minConfidence, priorities: escalationPriorities },
    closeBenign: { maxPriority, minHistory },
    review: { notifyPriorities, notifyOnStatuses },
    budget: { dailyCeilingMicroUsd: ceiling, maxOutputTokens, advancedTierEnabled },
    reports: { perRun, digest, digestHourLima },
    instructions: value.instructions,
  };
}

export function normalizeSettingsView(raw: unknown): AnalystSettingsView | null {
  const value = bag(raw);
  const settings = value ? normalizeSettings(value.settings) : null;
  if (!value || !settings) return null;
  // Sin `canConfigure: true` explícito el formulario queda en solo lectura.
  const deploymentEnabled =
    typeof value.deploymentEnabled === 'boolean' ? value.deploymentEnabled : null;
  return { settings, canConfigure: value.canConfigure === true, deploymentEnabled };
}

/** Texto en US$ («1,50» o «1.50») → micro-USD; `null` si no es un monto válido y positivo. */
export function usdTextToMicroUsd(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d{1,7}([.,]\d{1,6})?$/u.test(trimmed)) return null;
  const micro = Math.round(Number(trimmed.replace(',', '.')) * 1000000);
  return Number.isSafeInteger(micro) && micro > 0 ? micro : null;
}

/** Micro-USD → texto editable en US$ con coma decimal («1,50», «0,0125»). */
export function microUsdToUsdText(microUsd: number): string {
  const fixed = (microUsd / 1000000).toFixed(6);
  const [whole, fraction] = fixed.split('.');
  let decimals = fraction;
  while (decimals.length > 2 && decimals.charAt(decimals.length - 1) === '0') {
    decimals = decimals.slice(0, -1);
  }
  return `${whole},${decimals}`;
}

/** Estado editable del formulario: los números se editan como texto y se validan al guardar. */
export interface AiSettingsDraft {
  readonly enabled: boolean;
  readonly mode: AiMode;
  readonly scopePriorities: readonly Priority[];
  readonly inferenceMinPriority: AiInferenceMinPriority;
  readonly actions: Readonly<Record<AiSettingsAction, boolean>>;
  readonly escalationMinConfidence: AiMinConfidence;
  readonly escalationPriorities: readonly Priority[];
  readonly closeMaxPriority: AiCloseMaxPriority;
  readonly closeMinHistory: string;
  readonly notifyPriorities: readonly Priority[];
  readonly notifyOnStatuses: readonly AiReviewStatus[];
  /** `false` ⇒ `dailyCeilingMicroUsd: null` (IA desactivada). */
  readonly inferenceOn: boolean;
  readonly dailyCeilingUsd: string;
  readonly maxOutputTokens: string;
  readonly advancedTierEnabled: boolean;
  readonly reportsPerRun: boolean;
  readonly digest: AiDigestMode;
  readonly digestHourLima: string;
  readonly instructions: string;
}

export function draftFromSettings(settings: AnalystSettingsInput): AiSettingsDraft {
  const ceiling = settings.budget.dailyCeilingMicroUsd;
  return {
    enabled: settings.enabled,
    mode: settings.mode,
    scopePriorities: settings.scope.priorities,
    inferenceMinPriority: settings.scope.inferenceMinPriority,
    actions: { ...settings.actions },
    escalationMinConfidence: settings.escalation.minConfidence,
    escalationPriorities: settings.escalation.priorities,
    closeMaxPriority: settings.closeBenign.maxPriority,
    closeMinHistory: String(settings.closeBenign.minHistory),
    notifyPriorities: settings.review.notifyPriorities,
    notifyOnStatuses: settings.review.notifyOnStatuses,
    inferenceOn: ceiling !== null,
    dailyCeilingUsd: ceiling === null ? '' : microUsdToUsdText(ceiling),
    maxOutputTokens: String(settings.budget.maxOutputTokens),
    advancedTierEnabled: settings.budget.advancedTierEnabled,
    reportsPerRun: settings.reports.perRun,
    digest: settings.reports.digest,
    digestHourLima: String(settings.reports.digestHourLima),
    instructions: settings.instructions,
  };
}

function wholeNumber(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d{1,9}$/u.test(trimmed)) return null;
  return Number(trimmed);
}

/** Errores por ruta de campo (las mismas rutas que devuelve `VALIDATION_FAILED`). */
export type AiSettingsErrors = Readonly<Record<string, string>>;

export interface AiSettingsParse {
  readonly input: AnalystSettingsInput | null;
  readonly errors: AiSettingsErrors;
}

/** Valida el borrador con los mismos límites que el backend y arma el cuerpo del PUT. */
export function settingsFromDraft(draft: AiSettingsDraft): AiSettingsParse {
  const errors: Record<string, string> = {};
  const limits = AI_SETTINGS_LIMITS;

  if (draft.enabled && draft.scopePriorities.length === 0) {
    errors['scope.priorities'] = 'Elige al menos una prioridad para investigar.';
  }
  if (
    draft.mode === 'autonomous' &&
    draft.actions.escalate &&
    draft.escalationPriorities.length === 0
  ) {
    errors['escalation.priorities'] = 'Elige al menos una prioridad que se pueda escalar.';
  }
  const minHistory = wholeNumber(draft.closeMinHistory);
  if (
    minHistory === null ||
    minHistory < limits.minHistoryMin ||
    minHistory > limits.minHistoryMax
  ) {
    errors['closeBenign.minHistory'] =
      `Escribe un número entero entre ${limits.minHistoryMin} y ${limits.minHistoryMax}.`;
  }
  const ceiling = draft.inferenceOn ? usdTextToMicroUsd(draft.dailyCeilingUsd) : null;
  if (draft.inferenceOn && ceiling === null) {
    errors['budget.dailyCeilingMicroUsd'] =
      'Escribe un monto en US$ mayor que cero, por ejemplo 2,50. Para no usar IA, desactívala.';
  }
  const maxOutputTokens = wholeNumber(draft.maxOutputTokens);
  if (
    maxOutputTokens === null ||
    maxOutputTokens < limits.maxOutputTokensMin ||
    maxOutputTokens > limits.maxOutputTokensMax
  ) {
    errors['budget.maxOutputTokens'] =
      `Escribe un número entero entre ${limits.maxOutputTokensMin} y ${limits.maxOutputTokensMax}.`;
  }
  const hour = wholeNumber(draft.digestHourLima);
  if (hour === null || hour < limits.hourMin || hour > limits.hourMax) {
    errors['reports.digestHourLima'] = 'Escribe una hora entre 0 y 23 (hora de Lima).';
  }
  if (draft.instructions.length > limits.instructionsMax) {
    errors.instructions = `Máximo ${limits.instructionsMax} caracteres.`;
  }

  if (
    Object.keys(errors).length > 0 ||
    minHistory === null ||
    maxOutputTokens === null ||
    hour === null
  ) {
    return { input: null, errors };
  }
  return {
    errors,
    input: {
      enabled: draft.enabled,
      mode: draft.mode,
      scope: {
        priorities: PRIORITIES.filter((item) => draft.scopePriorities.includes(item)),
        inferenceMinPriority: draft.inferenceMinPriority,
      },
      actions: { ...draft.actions },
      escalation: {
        minConfidence: draft.escalationMinConfidence,
        priorities: PRIORITIES.filter((item) => draft.escalationPriorities.includes(item)),
      },
      closeBenign: { maxPriority: draft.closeMaxPriority, minHistory },
      review: {
        notifyPriorities: PRIORITIES.filter((item) => draft.notifyPriorities.includes(item)),
        notifyOnStatuses: AI_REVIEW_STATUSES.filter((item) =>
          draft.notifyOnStatuses.includes(item),
        ),
      },
      budget: {
        dailyCeilingMicroUsd: ceiling,
        maxOutputTokens,
        advancedTierEnabled: draft.advancedTierEnabled,
      },
      reports: { perRun: draft.reportsPerRun, digest: draft.digest, digestHourLima: hour },
      instructions: draft.instructions,
    },
  };
}

export function draftsEqual(a: AiSettingsDraft, b: AiSettingsDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Qué acciones tienen efecto en cada modo. Sombra no ejecuta ninguna; asistido solo pide revisión
 * humana; autónomo puede ejecutar todas las permitidas. Las demás se muestran deshabilitadas y
 * conservan su valor.
 */
export function actionApplies(mode: AiMode, action: AiSettingsAction): boolean {
  if (mode === 'autonomous') return true;
  if (mode === 'assisted') return action === 'requestReview';
  return false;
}

export interface AiSettingsRisk {
  readonly autonomous: boolean;
  readonly closeBenign: boolean;
}

/** Cambios que exigen confirmación explícita antes de guardar. */
export function settingsRisk(saved: AnalystSettingsInput, draft: AiSettingsDraft): AiSettingsRisk {
  return {
    autonomous: draft.mode === 'autonomous' && saved.mode !== 'autonomous',
    closeBenign: draft.actions.closeBenign && !saved.actions.closeBenign,
  };
}

/** Condiciones del cierre benigno que ninguna configuración puede relajar. */
export const AI_CLOSE_BENIGN_GUARDS: readonly string[] = [
  'Solo cierra alertas que coinciden con un patrón determinista ya conocido como benigno.',
  'Nunca cierra alertas P1 ni P2.',
  'Exige evidencia completa: si falta o está truncada, no cierra.',
  'No cierra si el patrón tuvo verdaderos positivos antes.',
  'Nunca cierra por el veredicto del modelo.',
];

export const AI_SETTINGS_ACTION_LABEL: Record<AiSettingsAction, string> = {
  escalate: 'Escalar a incidente',
  requestReview: 'Pedir revisión humana',
  acknowledge: 'Reconocer alertas',
  closeBenign: 'Cerrar benignas conocidas',
  attachReport: 'Adjuntar el informe',
};

export const AI_SETTINGS_ACTION_HELP: Record<AiSettingsAction, string> = {
  escalate: 'Abre o vincula un incidente cuando la investigación apunta a un verdadero positivo.',
  requestReview: 'Envía una notificación para que una persona revise la investigación.',
  acknowledge: 'Marca la alerta como reconocida al empezar a investigarla.',
  closeBenign: 'Cierra la alerta sin intervención humana cuando se cumplen todas las condiciones.',
  attachReport: 'Adjunta el informe de la investigación al incidente o a la notificación.',
};

export const AI_REVIEW_STATUS_LABEL: Record<AiReviewStatus, string> = {
  requires_review: AI_RUN_STATUS_LABEL.requires_review,
  budget_exhausted: AI_RUN_STATUS_LABEL.budget_exhausted,
  usage_unreconciled: AI_RUN_STATUS_LABEL.usage_unreconciled,
  partial: AI_RUN_STATUS_LABEL.partial,
  failed: AI_RUN_STATUS_LABEL.failed,
};

// ------------------------------------------------------------------ Informes

export interface AiRunReport {
  readonly filename: string;
  readonly markdown: string;
  readonly generatedAt: string | null;
}

export interface AiDigest {
  readonly from: string | null;
  readonly to: string | null;
  readonly totals: {
    readonly runs: number | null;
    readonly escalated: number | null;
    readonly closedBenign: number | null;
    readonly requiresReview: number | null;
    readonly withoutInference: number | null;
    readonly failed: number | null;
  };
  readonly byPriority: Readonly<Record<Priority, number | null>>;
  readonly topRules: ReadonlyArray<{ readonly ruleId: string; readonly count: number | null }>;
  readonly estimatedMicroUsd: number | null;
  readonly markdown: string;
}

/** Nombre de archivo local seguro: sin rutas ni caracteres de control, siempre `.md`. */
export function safeMarkdownFilename(name: unknown, fallback: string): string {
  const clean = (value: string) =>
    value
      .replace(/\.md$/iu, '')
      .replace(/[^A-Za-z0-9._-]+/gu, '-')
      .replace(/\.{2,}/gu, '.')
      .replace(/^[-.]+|[-.]+$/gu, '')
      .slice(0, 100);
  const base = typeof name === 'string' ? clean(name) : '';
  return `${base || clean(fallback) || 'informe'}.md`;
}

export function normalizeRunReport(raw: unknown, runId: string): AiRunReport | null {
  const value = bag(raw);
  if (!value || typeof value.markdown !== 'string' || value.markdown.length === 0) return null;
  return {
    filename: safeMarkdownFilename(value.filename, `analista-ia-${runId}`),
    markdown: value.markdown,
    generatedAt: isoOrNull(value.generatedAt),
  };
}

export function normalizeDigest(raw: unknown): AiDigest | null {
  const value = bag(raw);
  if (!value) return null;
  const totals = bag(value.totals) ?? {};
  const byPriority = bag(value.byPriority) ?? {};
  const topRules: Array<{ ruleId: string; count: number | null }> = [];
  for (const item of list(value.topRules, 50)) {
    const rule = bag(item);
    const ruleId = rule ? text(rule.ruleId, 120) : null;
    if (rule && ruleId) topRules.push({ ruleId, count: count(rule.count) });
  }
  return {
    from: text(value.from, 64),
    to: text(value.to, 64),
    totals: {
      runs: count(totals.runs),
      escalated: count(totals.escalated),
      closedBenign: count(totals.closedBenign),
      requiresReview: count(totals.requiresReview),
      withoutInference: count(totals.withoutInference),
      failed: count(totals.failed),
    },
    byPriority: {
      P1: count(byPriority.P1),
      P2: count(byPriority.P2),
      P3: count(byPriority.P3),
      P4: count(byPriority.P4),
    },
    topRules,
    estimatedMicroUsd: count(value.estimatedMicroUsd),
    markdown: typeof value.markdown === 'string' ? value.markdown : '',
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

export function isValidDay(value: string): boolean {
  return DAY.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

/** Rango de fechas del resumen (`AAAA-MM-DD`); devuelve el motivo si no es válido. */
export function digestRangeError(from: string, to: string): string | null {
  if (!isValidDay(from) || !isValidDay(to)) return 'Elige las dos fechas del periodo.';
  if (from > to) return 'La fecha inicial no puede ser posterior a la final.';
  return null;
}

/** Día local `AAAA-MM-DD`, desplazado `offsetDays` (negativo = pasado). */
export function localDay(now: Date, offsetDays = 0): string {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
