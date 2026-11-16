/**
 * Proyección HTTP del Analista IA. La forma es EXACTAMENTE la que normaliza la consola en
 * `wazuh/dashboard/plugins/qapaq_ops/common/ai_investigations.ts` (fuente de verdad del contrato):
 * cambiar un campo aquí exige revisar ese archivo.
 *
 * Nunca salen: prompts, paquete de evidencia, respuesta cruda del modelo, claves de entidad,
 * identificadores de persona sin enmascarar ni texto de instrucciones del administrador fuera de
 * `GET /settings` (que solo lee quien puede verlas en la consola).
 */

import {
  ACTION_KINDS,
  ANALYST_MODES,
  type AnalystMode,
  type AnalystSettings,
  type BudgetSnapshot,
  type EscalationOutcome,
  type InvestigationAction,
  type InvestigationActivityCounts,
  type InvestigationCursor,
  type InvestigationEvent,
  type InvestigationInvocation,
  type InvestigationJob,
  type OperationsDigest,
  type RunReport,
  type StoredAnalystSettings,
} from '@qapaq/assistant';
import { maskText } from '@qapaq/soar';
import type { Alert } from '@qapaq/soc';

import type { AnalystBacklog, AnalystHostStatus } from '../runtime/analyst-host.js';

const UUID_LIKE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/iu;

/** Identificador de persona enmascarado para la consola; servicios y sistema se muestran tal cual. */
export function maskActorRef(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^(svc|system):/u.test(value)) return value.slice(0, 80);
  if (value.includes('@')) return maskText(value).slice(0, 120);
  if (UUID_LIKE.test(value) || value.length > 12) return `${value.slice(0, 8)}…`;
  return `${value.slice(0, 2)}***`;
}

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

/** Cursor opaco `createdAt|id` en base64url. */
export function encodeCursor(cursor: InvestigationCursor | null): string | null {
  return cursor
    ? Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, 'utf8').toString('base64url')
    : null;
}

export function decodeCursor(raw: string): InvestigationCursor | undefined {
  if (!/^[A-Za-z0-9_-]{1,400}$/u.test(raw)) return undefined;
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const [at, id, extra] = text.split('|');
  const createdAt = new Date(at ?? '');
  if (extra !== undefined || !id || id.length > 128 || Number.isNaN(createdAt.getTime())) {
    return undefined;
  }
  return { createdAt, id };
}

export interface RunExtras {
  readonly invocations: readonly InvestigationInvocation[];
  readonly actions: readonly InvestigationAction[];
  /**
   * Estado ACTUAL de la alerta principal, leído del modelo de lectura del SOC por el controlador.
   * `null`: sin `alerts.read`, sin una alerta única o la alerta no existe. Ausente: no se consultó.
   */
  readonly alert?: RunAlertView | null;
}

/** Estado actual de la alerta vinculada (para saber si la revisión sigue pendiente). */
export interface RunAlertView {
  readonly status: Alert['status'];
  /** Enmascarado como el resto de identificadores de persona. */
  readonly assigneeId: string | null;
  /** La alerta está asignada a quien consulta (la consola no recibe el id sin máscara). */
  readonly assignedToYou: boolean;
  readonly verdict: Alert['verdict'];
  readonly incidentId: string | null;
  /** El incidente vinculado lo abrió o adjuntó el propio analista en ESTA investigación. */
  readonly incidentByAnalyst: boolean;
}

/** Alerta única de la investigación (la que se revisa); `null` si no hay una sola. */
export function primaryAlertIdOf(job: Pick<InvestigationJob, 'subject' | 'alertIds'>): string | null {
  if (job.subject.kind === 'alert' && job.subject.id) return job.subject.id;
  return job.alertIds.length === 1 ? job.alertIds[0]! : null;
}

export function runAlertView(
  alert: Pick<Alert, 'status' | 'assigneeId' | 'verdict' | 'incidentId'>,
  actions: readonly InvestigationAction[],
  viewerId: string,
): RunAlertView {
  const byAnalyst = new Set(
    actions
      .filter((action) => action.kind === 'escalate' && action.state === 'executed')
      .map((action) => (action.ref && action.ref.kind === 'incident' ? action.ref.id : null))
      .filter((id): id is string => id !== null),
  );
  return {
    status: alert.status,
    assigneeId: maskActorRef(alert.assigneeId),
    assignedToYou: alert.assigneeId !== null && alert.assigneeId === viewerId,
    verdict: alert.verdict,
    incidentId: alert.incidentId,
    incidentByAnalyst: alert.incidentId !== null && byAnalyst.has(alert.incidentId),
  };
}

function estimatedCost(invocations: readonly InvestigationInvocation[]): number {
  return invocations.reduce(
    (sum, row) => sum + (row.state === 'settled' && row.estimatedMicroUsd !== null ? row.estimatedMicroUsd : 0),
    0,
  );
}

export function runSummaryView(job: InvestigationJob, extras: RunExtras) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    priority: job.priority,
    trigger: job.trigger,
    source: job.source,
    initiatedBy: maskActorRef(job.initiatedBy),
    subject: { kind: job.subject.kind, id: job.subject.id, title: maskText(job.subject.title) },
    alertCount: job.alertIds.length,
    inference: job.inference,
    verdict: job.result?.verdict ?? null,
    confidence: job.result?.confidence ?? null,
    createdAt: iso(job.createdAt),
    updatedAt: iso(job.updatedAt),
    finishedAt: iso(job.finishedAt),
    revision: job.revision,
    estimatedCostMicroUsd: estimatedCost(extras.invocations),
    actionKinds: [
      ...new Set(
        extras.actions.filter((action) => action.state === 'executed').map((action) => action.kind),
      ),
    ],
    ...(extras.alert === undefined ? {} : { alert: extras.alert }),
  };
}

/** Modo con que corrió: lo deja el runner en el evento final de la bitácora. */
export function runModeOf(events: readonly InvestigationEvent[]): AnalystMode | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const mode = events[index]!.detail['mode'];
    if (typeof mode === 'string' && (ANALYST_MODES as readonly string[]).includes(mode)) {
      return mode as AnalystMode;
    }
  }
  return null;
}

export function runDetailView(
  job: InvestigationJob,
  events: readonly InvestigationEvent[],
  extras: RunExtras,
) {
  const settled = extras.invocations.filter((row) => row.usage !== null);
  const usage =
    settled.length === 0
      ? null
      : settled.reduce(
          (sum, row) => ({
            inputTokens: sum.inputTokens + row.usage!.inputTokens,
            outputTokens: sum.outputTokens + row.usage!.outputTokens,
            cacheReadTokens: sum.cacheReadTokens + row.usage!.cacheReadTokens,
            cacheWriteTokens: sum.cacheWriteTokens + row.usage!.cacheWriteTokens,
          }),
          { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        );
  const evidence = job.evidence;
  const result = job.result;
  return {
    ...runSummaryView(job, extras),
    mode: runModeOf(events),
    policyVersion: job.policyVersion,
    attempt: job.attempt,
    lastErrorCode: job.lastErrorCode,
    cancelRequested: job.cancelRequested,
    alertIds: job.alertIds,
    events: events.map((event) => ({
      sequence: event.sequence,
      at: iso(event.at),
      stage: event.stage,
      kind: event.kind,
      detail: event.detail,
    })),
    evidence: evidence
      ? {
          complete: evidence.complete,
          truncated: evidence.truncated || evidence.packTruncated,
          alertsScanned: evidence.alertCount + evidence.relatedAlertCount,
          eventsScanned: evidence.eventCount,
          // La lista de fuentes no se persiste; el conteo de las no sanas va en los vacíos.
          sources: [],
          gaps: [
            ...(evidence.unhealthySourceCount > 0
              ? [`${evidence.unhealthySourceCount} fuente(s) sin datos frescos o con falla al leer`]
              : []),
            ...evidence.gaps,
          ],
        }
      : null,
    result: result
      ? {
          summary: result.summary,
          verdict: result.verdict,
          confidence: result.confidence,
          recommendedPriority: result.recommendedPriority,
          // Citas como ids planos que coinciden con `citations[].id`.
          facts: result.facts.map((fact) => ({ text: fact.text, citations: [...fact.citations] })),
          inferences: result.inferences.map((entry) => ({
            text: entry.text,
            citations: [...entry.citations],
          })),
          gaps: result.gaps,
          nextSteps: result.nextSteps,
          citations: result.citations.map((citation) => ({
            kind: citation.kind,
            id: citation.id,
            label: maskText(citation.label),
          })),
          verified: result.verified,
          deterministic: { reasons: result.deterministic.reasons },
        }
      : null,
    usage,
    invocations: extras.invocations.map((row) => ({
      phase: row.phase,
      tier: row.tier,
      model: row.model,
      state: row.state,
      estimatedMicroUsd: row.state === 'settled' ? row.estimatedMicroUsd : null,
    })),
    actions: extras.actions.map((action) => ({
      id: action.id,
      kind: action.kind,
      state: action.state,
      reason: action.reason,
      urgency: action.urgency,
      at: iso(action.at),
      executedAt: iso(action.executedAt),
      ref: action.ref,
      errorCode: action.errorCode,
    })),
  };
}

export function settingsView(stored: StoredAnalystSettings | undefined, settings: AnalystSettings) {
  return {
    ...settings,
    revision: stored?.revision ?? 0,
    updatedAt: iso(stored?.updatedAt),
    updatedBy: maskActorRef(stored?.updatedBy),
  };
}

export function budgetView(input: {
  readonly snapshot: BudgetSnapshot;
  readonly settings: AnalystSettings;
  readonly deploymentEnabled: boolean;
  readonly limitMicroUsd: number | null;
  readonly rateCardVersion: string;
}) {
  const { snapshot, settings } = input;
  const runs = snapshot.runsToday;
  return {
    enabled: input.deploymentEnabled && settings.enabled,
    mode: settings.mode,
    inferenceEnabled: input.deploymentEnabled && input.limitMicroUsd !== null,
    day: {
      date: snapshot.day,
      limitMicroUsd: input.limitMicroUsd,
      reservedMicroUsd: snapshot.reservedMicroUsd + snapshot.unknownMicroUsd,
      settledMicroUsd: snapshot.settledMicroUsd,
      unknownInvocations: snapshot.unknownCount,
    },
    tokens: snapshot.tokens,
    runs: {
      today: runs.none + runs.economy + runs.advanced,
      withoutInference: runs.none,
      economy: runs.economy,
      advanced: runs.advanced,
    },
    rateCardVersion: input.rateCardVersion,
    billing: 'not_connected',
  };
}

export function digestView(digest: OperationsDigest) {
  return {
    from: digest.from.toISOString(),
    to: digest.to.toISOString(),
    totals: digest.totals,
    byPriority: digest.byPriority,
    topRules: digest.topRules.map((rule) => ({ ruleId: rule.ruleId, count: rule.runs })),
    estimatedMicroUsd: digest.estimatedMicroUsd,
    coverage: digest.coverage,
    markdown: digest.markdown,
  };
}

export function reportView(report: RunReport, generatedAt: Date) {
  return { filename: report.filename, markdown: report.markdown, generatedAt: generatedAt.toISOString() };
}

// ── Panel de actividad (`GET /activity`) ───────────────────────────────────────────────────

/** Tope de entradas del feed y su ventana. */
export const ACTIVITY_FEED_LIMIT = 50;
export const ACTIVITY_FEED_WINDOW_MS = 86_400_000;

/** Motivos deterministas que explican mejor una corrida sin modelo, en orden de preferencia. */
const HEADLINE_REASONS = [
  'KNOWN_BENIGN_PATTERN',
  'DUPLICATE_OF_OPEN_INCIDENT',
  'EVIDENCE_INCOMPLETE',
  'ISOLATED_LOW_SIGNAL',
  'NOT_ELIGIBLE',
] as const;

function headlineReason(job: InvestigationJob): string | null {
  if (job.status === 'failed' || job.status === 'usage_unreconciled') return job.lastErrorCode;
  const reasons = job.result?.deterministic.reasons ?? [];
  return HEADLINE_REASONS.find((code) => reasons.includes(code)) ?? reasons[0] ?? null;
}

export interface ActivityInput {
  readonly status: AnalystHostStatus;
  readonly settings: AnalystSettings;
  readonly counts: InvestigationActivityCounts;
  /** Acciones de la ventana del feed (que contiene la de hoy). */
  readonly actions: readonly InvestigationAction[];
  readonly escalations: readonly EscalationOutcome[];
  /** Trabajos conocidos (recientes + los de las acciones del feed). */
  readonly jobs: ReadonlyMap<string, InvestigationJob>;
  readonly backlog: AnalystBacklog;
  /** Día de Lima de «hoy» y su ventana `[from, to)`. */
  readonly today: { readonly day: string; readonly from: Date; readonly to: Date };
  readonly since: Date;
  /** El despliegue no tiene techo de inferencia: sin uso, el costo es «sin dato», no 0. */
  readonly inferenceConfigured: boolean;
}

type FeedKind = 'run_started' | 'run_finished' | 'action';

export interface ActivityFeedItem {
  readonly at: string;
  readonly jobId: string;
  readonly priority: string;
  readonly subjectTitle: string;
  readonly kind: FeedKind;
  readonly status?: string;
  readonly inference?: string | null;
  readonly actionKind?: string;
  readonly actionState?: string;
  readonly reason?: string | null;
  readonly urgency?: string | null;
  readonly disposition?: 'created' | 'attached';
  readonly ref?: { readonly kind: string; readonly id: string } | null;
}

const FEED_RANK: Readonly<Record<FeedKind, number>> = { run_finished: 0, action: 1, run_started: 2 };
const actionOrder = (item: ActivityFeedItem): number =>
  item.actionKind ? (ACTION_KINDS as readonly string[]).indexOf(item.actionKind) : -1;

/** Feed: inicios, cierres y acciones (no `planned`) desde `since`, más reciente primero. */
export function activityFeed(input: Pick<ActivityInput, 'actions' | 'escalations' | 'jobs' | 'since'>) {
  const since = input.since.getTime();
  const entries: { readonly time: number; readonly item: ActivityFeedItem }[] = [];
  const base = (job: InvestigationJob) => ({
    jobId: job.id,
    priority: job.priority,
    subjectTitle: maskText(job.subject.title).slice(0, 300),
  });
  for (const job of input.jobs.values()) {
    if (job.startedAt && job.startedAt.getTime() >= since) {
      entries.push({
        time: job.startedAt.getTime(),
        item: { at: job.startedAt.toISOString(), ...base(job), kind: 'run_started' },
      });
    }
    if (job.finishedAt && job.finishedAt.getTime() >= since && job.status !== 'queued' && job.status !== 'running') {
      entries.push({
        time: job.finishedAt.getTime(),
        item: {
          at: job.finishedAt.toISOString(),
          ...base(job),
          kind: 'run_finished',
          status: job.status,
          inference: job.inference,
          reason: headlineReason(job),
        },
      });
    }
  }
  const disposition = new Map(input.escalations.map((row) => [row.jobId, row.disposition]));
  for (const action of input.actions) {
    const job = input.jobs.get(action.jobId);
    const at = action.executedAt ?? action.at;
    if (!job || action.state === 'planned' || at.getTime() < since) continue;
    const escalated = action.kind === 'escalate' ? disposition.get(action.jobId) : undefined;
    entries.push({
      time: at.getTime(),
      item: {
        at: at.toISOString(),
        ...base(job),
        kind: 'action',
        actionKind: action.kind,
        actionState: action.state,
        reason: action.reason,
        urgency: action.urgency,
        ...(escalated && action.state === 'executed' ? { disposition: escalated } : {}),
        ref: action.ref,
      },
    });
  }
  return entries
    .sort(
      (left, right) =>
        right.time - left.time ||
        FEED_RANK[left.item.kind] - FEED_RANK[right.item.kind] ||
        // Mismo instante: la acción ejecutada después (orden de `ACTION_KINDS`) va primero.
        actionOrder(right.item) - actionOrder(left.item) ||
        (left.item.jobId < right.item.jobId ? 1 : -1),
    )
    .slice(0, ACTIVITY_FEED_LIMIT)
    .map((entry) => entry.item);
}

export function activityView(input: ActivityInput) {
  const { counts, status, today } = input;
  const inToday = (at: Date) => at >= today.from && at < today.to;
  const executed = input.actions.filter((action) => action.state === 'executed' && inToday(action.at));
  const ofKind = (kind: InvestigationAction['kind']) => executed.filter((action) => action.kind === kind);
  const reviews = ofKind('request_review');
  const escalations = input.escalations.filter((row) => inToday(row.at));
  const settled = counts.settledMicroUsd;
  return {
    host: {
      enabled: status.enabled,
      running: status.running,
      settingsEnabled: input.settings.enabled,
      mode: input.settings.mode,
      lastTickAt: iso(status.lastTickAt),
      lastProcessedAt: iso(status.lastProcessedAt),
      inFlight: status.inFlight,
      concurrency: status.concurrency,
      lastErrorCode: status.lastErrorCode,
      scope: 'process',
    },
    queue: {
      queued: counts.queue.queued,
      running: counts.queue.running,
      oldestQueuedAt: iso(counts.queue.oldestQueuedAt),
      byPriority: { ...counts.queue.byPriority },
    },
    today: {
      day: today.day,
      from: today.from.toISOString(),
      to: today.to.toISOString(),
      boundary: 'America/Lima',
      runs: counts.finished.total,
      withoutInference: counts.finished.byInference.none,
      economy: counts.finished.byInference.economy,
      advanced: counts.finished.byInference.advanced,
      escalated: ofKind('escalate').length,
      incidentsCreated: escalations.filter((row) => row.disposition === 'created').length,
      incidentsAttached: escalations.filter((row) => row.disposition === 'attached').length,
      closedBenign: ofKind('close_benign').length,
      acknowledged: ofKind('acknowledge').length,
      reviewRequested: reviews.length,
      reviewImmediate: reviews.filter((action) => action.urgency === 'immediate').length,
      reviewDigest: reviews.filter((action) => action.urgency !== 'immediate').length,
      failed: counts.finished.byStatus.failed ?? 0,
      estimatedMicroUsd: !input.inferenceConfigured && settled === 0 ? null : settled,
    },
    backlog: {
      openAlertsWithoutCaseFile: input.backlog.openAlertsWithoutCaseFile,
      openIncidentsWithoutCaseFile: input.backlog.openIncidentsWithoutCaseFile,
    },
    feed: activityFeed(input),
  };
}
