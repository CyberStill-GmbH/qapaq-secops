/**
 * Adaptador PostgreSQL del Analista IA. Se publica como subpath
 * (`@qapaq/assistant/postgres-investigations`) para que el runtime en memoria no cargue Prisma.
 *
 * Traduce entre el dominio y las filas planas de `@qapaq/database/ai-investigation-store`. Al leer,
 * los catálogos cerrados (estado, etapa, nivel, tipo de acción…) se validan: un valor fuera de
 * catálogo es un error de integridad, no se adivina.
 */

import {
  closeDatabaseClient,
  createDatabaseClient,
  type DatabaseConnectionOptions,
} from '@qapaq/database';
import {
  PrismaAiInvestigationStore,
  type AiInvestigationActionRow,
  type AiInvestigationEventRow,
  type AiInvestigationInvocationRow,
  type AiInvestigationJobRow,
} from '@qapaq/database/ai-investigation-store';

import {
  ACTION_KINDS,
  ACTION_REASON_CODES,
  ACTION_STATES,
  type InvestigationAction,
} from '../investigations/actions.js';
import { clampPageSize } from '../investigations/memory-store.js';
import {
  utcDayStart,
  type ActionMark,
  type BudgetSnapshot,
  type DispatchOutcome,
  type EscalationOutcome,
  type HeartbeatOutcome,
  type InvestigationActivityCounts,
  type InvestigationActionPlan,
  type InvestigationCheckpoint,
  type InvestigationCommandOutcome,
  type InvestigationEventDraft,
  type InvestigationFinish,
  type InvestigationListOptions,
  type InvestigationPage,
  type InvestigationRetryRelease,
  type InvestigationStore,
  type InvocationReservation,
  type InvocationReservationRequest,
  type InvocationSettlement,
  type RetryReleaseOutcome,
  type WorkerLease,
} from '../investigations/ports.js';
import {
  parseAnalystSettings,
  type AnalystSettings,
  type AnalystSettingsStore,
  type StoredAnalystSettings,
} from '../investigations/settings.js';
import {
  INFERENCE_TIERS,
  INVESTIGATION_EVENT_KINDS,
  INVESTIGATION_PRIORITIES,
  INVESTIGATION_SOURCES,
  INVESTIGATION_STAGES,
  INVESTIGATION_STATUSES,
  INVESTIGATION_TERMINAL_STATUSES,
  INVESTIGATION_TRIGGERS,
  INVOCATION_STATES,
  InvestigationInputError,
  isInvestigationId,
  normalizeNewJob,
  sanitizeErrorCode,
  sanitizeEventDetail,
  type InvestigationEvent,
  type InvestigationEventDetail,
  type InvestigationEvidenceSummary,
  type InvestigationInvocation,
  type InvestigationJob,
  type InvestigationPriority,
  type InvestigationResult,
  type InvestigationStatus,
  type InvestigationTerminalStatus,
  type NewInvestigationJob,
} from '../investigations/types.js';

export class InvestigationIntegrityError extends Error {
  public constructor(field: string) {
    super(`Valor fuera de catálogo en las tablas del Analista IA: ${field}.`);
    this.name = 'InvestigationIntegrityError';
  }
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new InvestigationIntegrityError(field);
  }
  return value as T;
}
const orNull = <T extends string>(
  allowed: readonly T[],
  value: unknown,
  field: string,
): T | null => (value === null || value === undefined ? null : oneOf(allowed, value, field));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function resultOf(value: unknown): InvestigationResult | null {
  if (value === null || value === undefined) return null;
  if (
    !isRecord(value) ||
    typeof value['summary'] !== 'string' ||
    typeof value['verified'] !== 'boolean' ||
    !Array.isArray(value['facts']) ||
    !Array.isArray(value['inferences']) ||
    !Array.isArray(value['gaps']) ||
    !Array.isArray(value['nextSteps']) ||
    !Array.isArray(value['citations']) ||
    !isRecord(value['deterministic'])
  ) {
    throw new InvestigationIntegrityError('result');
  }
  return value as unknown as InvestigationResult;
}

function evidenceOf(value: unknown): InvestigationEvidenceSummary | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || typeof value['watermark'] !== 'string') {
    throw new InvestigationIntegrityError('evidence');
  }
  return value as unknown as InvestigationEvidenceSummary;
}

function toJob(row: AiInvestigationJobRow): InvestigationJob {
  if (!Array.isArray(row.alertIds) || row.alertIds.some((id) => typeof id !== 'string')) {
    throw new InvestigationIntegrityError('alert_ids');
  }
  return {
    id: row.id,
    tenantId: row.tenantId,
    subject: {
      kind: oneOf(['alert', 'candidate'] as const, row.subjectKind, 'subject_kind'),
      id: row.subjectId,
      title: row.subjectTitle,
      ruleId: row.subjectRuleId,
    },
    alertIds: row.alertIds as string[],
    priority: oneOf(INVESTIGATION_PRIORITIES, row.priority, 'priority'),
    trigger: oneOf(INVESTIGATION_TRIGGERS, row.trigger, 'trigger'),
    source: oneOf(INVESTIGATION_SOURCES, row.source, 'source'),
    initiatedBy: row.initiatedBy,
    idempotencyKey: row.idempotencyKey,
    fingerprint: row.fingerprint,
    policyVersion: row.policyVersion,
    status: oneOf(INVESTIGATION_STATUSES, row.status, 'status'),
    stage: orNull(INVESTIGATION_STAGES, row.stage, 'stage'),
    inference: orNull(['none', ...INFERENCE_TIERS] as const, row.inference, 'inference'),
    attempt: row.attempt,
    availableAt: row.availableAt,
    leaseUntil: row.leaseUntil,
    fencingToken: row.fencingToken,
    cancelRequested: row.cancelRequested,
    lastErrorCode: row.lastErrorCode,
    result: resultOf(row.result),
    plannedStatus: orNull(INVESTIGATION_TERMINAL_STATUSES, row.plannedStatus, 'planned_status'),
    evidence: evidenceOf(row.evidence),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    revision: row.revision,
  };
}

function toEvent(row: AiInvestigationEventRow): InvestigationEvent {
  return {
    jobId: row.jobId,
    sequence: row.sequence,
    at: row.at,
    stage: oneOf(INVESTIGATION_STAGES, row.stage, 'event.stage'),
    kind: oneOf(INVESTIGATION_EVENT_KINDS, row.kind, 'event.kind'),
    detail: isRecord(row.detail) ? sanitizeEventDetail(row.detail as InvestigationEventDetail) : {},
  };
}

function toInvocation(row: AiInvestigationInvocationRow): InvestigationInvocation {
  const state = oneOf(INVOCATION_STATES, row.state, 'invocation.state');
  return {
    id: row.id,
    jobId: row.jobId,
    tenantId: row.tenantId,
    phase: oneOf(['analysis'] as const, row.phase, 'invocation.phase'),
    fingerprint: row.fingerprint,
    tier: oneOf(INFERENCE_TIERS, row.tier, 'invocation.tier'),
    model: row.model,
    state,
    reservedInputTokens: row.reservedInputTokens,
    reservedOutputTokens: row.reservedOutputTokens,
    reservedMicroUsd: row.reservedMicroUsd,
    usage:
      state === 'settled'
        ? {
            inputTokens: row.inputTokens ?? 0,
            outputTokens: row.outputTokens ?? 0,
            cacheReadTokens: row.cacheReadTokens ?? 0,
            cacheWriteTokens: row.cacheWriteTokens ?? 0,
          }
        : null,
    estimatedMicroUsd: state === 'settled' ? row.estimatedMicroUsd : null,
    rateCardVersion: row.rateCardVersion,
    createdAt: row.createdAt,
    settledAt: row.settledAt,
  };
}

function toAction(row: AiInvestigationActionRow): InvestigationAction {
  const refKind = orNull(
    ['alert', 'incident', 'notification', 'report'] as const,
    row.refKind,
    'action.ref_kind',
  );
  return {
    id: row.id,
    jobId: row.jobId,
    tenantId: row.tenantId,
    kind: oneOf(ACTION_KINDS, row.kind, 'action.kind'),
    state: oneOf(ACTION_STATES, row.state, 'action.state'),
    reason: oneOf(ACTION_REASON_CODES, row.reason, 'action.reason'),
    urgency: orNull(['immediate', 'digest'] as const, row.urgency, 'action.urgency'),
    groupKey: row.groupKey,
    at: row.at,
    executedAt: row.executedAt,
    ref: refKind !== null && row.refId !== null ? { kind: refKind, id: row.refId } : null,
    errorCode: row.errorCode,
  };
}

const errorCodeOf = (value: string | null | undefined): string | null =>
  value === null || value === undefined ? null : sanitizeErrorCode(value);

class PostgresAnalystSettingsStore implements AnalystSettingsStore {
  public constructor(private readonly store: PrismaAiInvestigationStore) {}

  public async get(tenantId: string): Promise<StoredAnalystSettings | undefined> {
    const row = await this.store.getSettings(tenantId);
    if (!row) return undefined;
    const parsed = parseAnalystSettings(row.document);
    if (!parsed.ok) throw new InvestigationIntegrityError(`settings.${parsed.field}`);
    return {
      tenantId: row.tenantId,
      settings: parsed.settings,
      revision: row.revision,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  public async put(
    tenantId: string,
    settings: AnalystSettings,
    expectedRevision: number,
    by: string,
    at: Date,
  ): Promise<'ok' | 'conflict'> {
    // Nunca se persiste un documento que el validador no acepte.
    const parsed = parseAnalystSettings(settings);
    if (!parsed.ok) throw new InvestigationIntegrityError(`settings.${parsed.field}`);
    return (await this.store.putSettings(tenantId, parsed.settings, expectedRevision, by, at))
      ? 'ok'
      : 'conflict';
  }
}

export class PostgresInvestigationStore implements InvestigationStore {
  /** Ajustes del analista sobre la misma conexión. */
  public readonly settings: AnalystSettingsStore;

  private constructor(
    private readonly store: PrismaAiInvestigationStore,
    private readonly closeClient: () => Promise<void>,
  ) {
    this.settings = new PostgresAnalystSettingsStore(store);
  }

  public static connect(options: DatabaseConnectionOptions): PostgresInvestigationStore {
    const client = createDatabaseClient(options);
    return new PostgresInvestigationStore(new PrismaAiInvestigationStore(client), () =>
      closeDatabaseClient(client),
    );
  }

  /** Falla si la migración no está aplicada. */
  public ready(): Promise<void> {
    return this.store.ready();
  }

  public close(): Promise<void> {
    return this.closeClient();
  }

  public async enqueue(
    input: NewInvestigationJob,
  ): Promise<{ readonly job: InvestigationJob; readonly created: boolean }> {
    const draft = normalizeNewJob(input);
    // La tabla exige UUID y huella sha256 (`fingerprintOf`).
    if (!isInvestigationId(draft.id) || !/^[0-9a-f]{64}$/u.test(draft.fingerprint)) {
      throw new InvestigationInputError('INVALID_JOB');
    }
    const { row, created } = await this.store.enqueue({
      id: draft.id,
      tenantId: draft.tenantId,
      subjectKind: draft.subject.kind,
      subjectId: draft.subject.id,
      subjectTitle: draft.subject.title,
      subjectRuleId: draft.subject.ruleId ?? null,
      alertIds: draft.alertIds,
      priority: draft.priority,
      trigger: draft.trigger,
      source: draft.source,
      initiatedBy: draft.initiatedBy,
      idempotencyKey: draft.idempotencyKey,
      fingerprint: draft.fingerprint,
      policyVersion: draft.policyVersion,
      createdAt: draft.createdAt,
      availableAt: draft.availableAt,
    });
    return { job: toJob(row), created };
  }

  public async claim(
    at: Date,
    leaseMs: number,
    maxAttempts: number,
  ): Promise<InvestigationJob | null> {
    const row = await this.store.claim(at, leaseMs, maxAttempts);
    return row ? toJob(row) : null;
  }

  public async heartbeat(lease: WorkerLease, at: Date, leaseMs: number): Promise<HeartbeatOutcome> {
    const cancelRequested = await this.store.heartbeat(
      lease.jobId,
      lease.fencingToken,
      at,
      leaseMs,
    );
    return cancelRequested === undefined ? 'lost' : cancelRequested ? 'cancel_requested' : 'ok';
  }

  public appendEvent(lease: WorkerLease, event: InvestigationEventDraft): Promise<boolean> {
    return this.store.progress(lease.jobId, lease.fencingToken, {
      at: event.at,
      event: { ...event, detail: sanitizeEventDetail(event.detail ?? {}) },
    });
  }

  public checkpoint(lease: WorkerLease, checkpoint: InvestigationCheckpoint): Promise<boolean> {
    return this.store.progress(lease.jobId, lease.fencingToken, {
      at: checkpoint.at,
      stage: checkpoint.stage,
      ...(checkpoint.inference === undefined ? {} : { inference: checkpoint.inference }),
      ...(checkpoint.evidence === undefined ? {} : { evidence: checkpoint.evidence }),
      ...(checkpoint.event
        ? {
            event: {
              at: checkpoint.at,
              stage: checkpoint.stage,
              kind: checkpoint.event.kind,
              detail: sanitizeEventDetail(checkpoint.event.detail ?? {}),
            },
          }
        : {}),
    });
  }

  public async finish(
    lease: WorkerLease,
    finish: InvestigationFinish,
  ): Promise<InvestigationTerminalStatus | null> {
    const status = await this.store.finish(lease.jobId, lease.fencingToken, {
      at: finish.at,
      status: finish.status,
      result: finish.result,
      inference: finish.inference,
      ...(finish.evidence ? { evidence: finish.evidence } : {}),
      errorCode: errorCodeOf(finish.errorCode),
      ...(finish.event
        ? { event: { ...finish.event, detail: sanitizeEventDetail(finish.event.detail ?? {}) } }
        : {}),
    });
    return status === undefined ? null : oneOf(INVESTIGATION_TERMINAL_STATUSES, status, 'status');
  }

  public async releaseForRetry(
    lease: WorkerLease,
    release: InvestigationRetryRelease,
  ): Promise<RetryReleaseOutcome> {
    const status = await this.store.releaseForRetry(lease.jobId, lease.fencingToken, {
      at: release.at,
      availableAt: release.availableAt,
      errorCode: sanitizeErrorCode(release.errorCode),
      maxAttempts: release.maxAttempts,
      refundAttempt: release.refundAttempt === true,
    });
    if (status === undefined) return 'stale';
    return status === 'queued' ? 'requeued' : status === 'failed' ? 'quarantined' : 'cancelled';
  }

  public async planActions(
    lease: WorkerLease,
    plan: InvestigationActionPlan,
  ): Promise<readonly InvestigationAction[] | null> {
    const rows = await this.store.planActions(lease.jobId, lease.fencingToken, {
      at: plan.at,
      status: plan.status,
      result: plan.result,
      inference: plan.inference,
      ...(plan.evidence ? { evidence: plan.evidence } : {}),
      errorCode: errorCodeOf(plan.errorCode),
      actions: plan.actions.map((action) => ({
        kind: action.kind,
        reason: action.reason,
        urgency: action.kind === 'request_review' ? (action.urgency ?? 'digest') : null,
        groupKey: action.groupKey?.slice(0, 300) ?? null,
      })),
    });
    return rows === undefined ? null : rows.map(toAction);
  }

  public markAction(
    lease: WorkerLease,
    kind: InvestigationAction['kind'],
    mark: ActionMark,
  ): Promise<boolean> {
    return this.store.markAction(lease.jobId, lease.fencingToken, kind, {
      at: mark.at,
      state: mark.state,
      refKind: mark.ref?.kind ?? null,
      refId: mark.ref?.id.slice(0, 200) ?? null,
      errorCode: errorCodeOf(mark.errorCode),
    });
  }

  public async actions(tenantId: string, jobId: string): Promise<readonly InvestigationAction[]> {
    if (!isInvestigationId(jobId)) return [];
    return (await this.store.actions(tenantId, jobId)).map(toAction);
  }

  public async actionsBetween(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<readonly InvestigationAction[]> {
    return (await this.store.actionsBetween(tenantId, from, to)).map(toAction);
  }

  public countImmediateReviews(tenantId: string, since: Date): Promise<number> {
    return this.store.countImmediateReviews(tenantId, since);
  }

  public async requestCancel(
    tenantId: string,
    jobId: string,
    expectedRevision: number,
    at: Date,
  ): Promise<InvestigationCommandOutcome> {
    if (!isInvestigationId(jobId)) return 'not_found';
    return this.store.requestCancel(tenantId, jobId, expectedRevision, at);
  }

  public async retry(
    tenantId: string,
    jobId: string,
    expectedRevision: number,
    at: Date,
  ): Promise<InvestigationCommandOutcome> {
    if (!isInvestigationId(jobId)) return 'not_found';
    return this.store.retry(tenantId, jobId, expectedRevision, at);
  }

  public async byId(tenantId: string, jobId: string): Promise<InvestigationJob | undefined> {
    if (!isInvestigationId(jobId)) return undefined;
    const row = await this.store.byId(tenantId, jobId);
    return row ? toJob(row) : undefined;
  }

  public async list(
    tenantId: string,
    options: InvestigationListOptions = {},
  ): Promise<InvestigationPage> {
    const pageSize = clampPageSize(options.pageSize);
    const rows = await this.store.list(tenantId, pageSize + 1, options.status, options.cursor);
    const items = rows.slice(0, pageSize).map(toJob);
    const last = items.at(-1);
    return {
      items,
      next: rows.length > pageSize && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }

  public async events(tenantId: string, jobId: string): Promise<readonly InvestigationEvent[]> {
    if (!isInvestigationId(jobId)) return [];
    return (await this.store.events(tenantId, jobId)).map(toEvent);
  }

  public async invocations(
    tenantId: string,
    jobId: string,
  ): Promise<readonly InvestigationInvocation[]> {
    if (!isInvestigationId(jobId)) return [];
    return (await this.store.invocations(tenantId, jobId)).map(toInvocation);
  }

  public async findPriorInference(
    tenantId: string,
    fingerprint: string,
    excludeJobId: string,
  ): Promise<InvestigationJob | undefined> {
    const row = await this.store.findPriorInference(tenantId, fingerprint, excludeJobId);
    return row ? toJob(row) : undefined;
  }

  public async reserveInvocation(
    lease: WorkerLease,
    request: InvocationReservationRequest,
  ): Promise<InvocationReservation> {
    const outcome = await this.store.reserveInvocation(lease.jobId, lease.fencingToken, request);
    return outcome.ok
      ? { ok: true, invocation: toInvocation(outcome.invocation), reused: outcome.reused }
      : outcome;
  }

  public markDispatching(
    lease: WorkerLease,
    invocationId: string,
    at: Date,
  ): Promise<DispatchOutcome> {
    return this.store.markDispatching(lease.jobId, lease.fencingToken, invocationId, at);
  }

  public settleInvocation(
    lease: WorkerLease,
    invocationId: string,
    settlement: InvocationSettlement,
  ): Promise<boolean> {
    return this.store.settleInvocation(lease.jobId, lease.fencingToken, invocationId, {
      at: settlement.at,
      ...settlement.usage,
      estimatedMicroUsd: settlement.estimatedMicroUsd,
    });
  }

  public releaseInvocation(lease: WorkerLease, invocationId: string, at: Date): Promise<boolean> {
    return this.store.releaseInvocation(lease.jobId, lease.fencingToken, invocationId, at);
  }

  public markUsageUnknown(lease: WorkerLease, invocationId: string, at: Date): Promise<boolean> {
    return this.store.markUsageUnknown(lease.jobId, lease.fencingToken, invocationId, at);
  }

  public async budgetSnapshot(
    tenantId: string,
    at: Date,
    limitMicroUsd: number | null = null,
  ): Promise<BudgetSnapshot> {
    const totals = await this.store.budgetTotals(tenantId, at);
    return {
      tenantId,
      day: utcDayStart(at).toISOString().slice(0, 10),
      limitMicroUsd,
      reservedMicroUsd: totals.reservedMicroUsd,
      settledMicroUsd: totals.settledMicroUsd,
      unknownCount: totals.unknownCount,
      unknownMicroUsd: totals.unknownMicroUsd,
      tokens: {
        input: totals.inputTokens,
        output: totals.outputTokens,
        cacheRead: totals.cacheReadTokens,
        cacheWrite: totals.cacheWriteTokens,
      },
      runsToday: {
        none: totals.runsNone,
        economy: totals.runsEconomy,
        advanced: totals.runsAdvanced,
      },
    };
  }

  public async activityCounts(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<InvestigationActivityCounts> {
    const rows = await this.store.activityCounts(tenantId, from, to);
    const byPriority: Record<InvestigationPriority, number> = { P1: 0, P2: 0, P3: 0, P4: 0 };
    let queued = 0;
    let running = 0;
    let oldestQueuedAt: Date | null = null;
    for (const row of rows.queue) {
      if (row.status === 'running') {
        running += row.total;
        continue;
      }
      queued += row.total;
      byPriority[oneOf(INVESTIGATION_PRIORITIES, row.priority, 'priority')] += row.total;
      if (row.oldest && (!oldestQueuedAt || row.oldest < oldestQueuedAt)) oldestQueuedAt = row.oldest;
    }
    const byInference = { none: 0, economy: 0, advanced: 0 };
    const byStatus: Partial<Record<InvestigationStatus, number>> = {};
    let total = 0;
    for (const row of rows.finished) {
      const status = oneOf(INVESTIGATION_STATUSES, row.status, 'status');
      total += row.total;
      byStatus[status] = (byStatus[status] ?? 0) + row.total;
      const inference = orNull(['none', ...INFERENCE_TIERS] as const, row.inference, 'inference');
      if (inference) byInference[inference] += row.total;
    }
    return {
      queue: { queued, running, oldestQueuedAt, byPriority },
      finished: { total, byInference, byStatus },
      settledMicroUsd: rows.settledMicroUsd,
    };
  }

  public async recentJobs(
    tenantId: string,
    since: Date,
    limit: number,
  ): Promise<readonly InvestigationJob[]> {
    return (await this.store.recentJobs(tenantId, since, limit)).map(toJob);
  }

  public async escalationOutcomes(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<readonly EscalationOutcome[]> {
    return (await this.store.escalationOutcomes(tenantId, from, to)).map((row) => ({
      jobId: row.jobId,
      at: row.at,
      disposition: oneOf(['created', 'attached'] as const, row.disposition, 'detail.incident'),
    }));
  }

  public async existingKeys(tenantId: string, keys: readonly string[]): Promise<ReadonlySet<string>> {
    return new Set(await this.store.existingKeys(tenantId, keys));
  }
}
