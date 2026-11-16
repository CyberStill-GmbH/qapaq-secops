/**
 * Analista IA — gemelo en memoria de `InvestigationStore` (desarrollo y pruebas).
 *
 * Misma semántica que el adaptador PostgreSQL: fencing, idempotencia, topes y transiciones. Cada
 * método hace su trabajo sin `await` intermedio, así que es atómico en un solo hilo.
 */

import { randomUUID } from 'node:crypto';

import type { InvestigationAction } from './actions.js';
import {
  ACTIVITY_LIMITS,
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
} from './ports.js';
import {
  INVESTIGATION_RETRYABLE_STATUSES,
  isTerminalStatus,
  normalizeNewJob,
  sanitizeErrorCode,
  sanitizeEventDetail,
  type InvestigationEvent,
  type InvestigationInvocation,
  type InvestigationJob,
  type InvestigationPriority,
  type InvestigationStatus,
  type InvestigationTerminalStatus,
  type NewInvestigationJob,
} from './types.js';

const DAY_MS = 86_400_000;

export function clampPageSize(pageSize: number | undefined): number {
  return Math.max(1, Math.min(Math.trunc(pageSize ?? 25) || 25, 100));
}

export class InMemoryInvestigationStore implements InvestigationStore {
  private readonly jobs = new Map<string, InvestigationJob>();
  private readonly eventLog = new Map<string, InvestigationEvent[]>();
  private readonly ledger = new Map<string, InvestigationInvocation>();
  private readonly actionLog = new Map<string, InvestigationAction[]>();

  private owned(lease: WorkerLease, at: Date): InvestigationJob | undefined {
    const job = this.jobs.get(lease.jobId);
    return job &&
      job.status === 'running' &&
      job.fencingToken === lease.fencingToken &&
      job.leaseUntil !== null &&
      Number.isFinite(at.getTime()) &&
      job.leaseUntil.getTime() > at.getTime()
      ? job
      : undefined;
  }

  private put(job: InvestigationJob): InvestigationJob {
    this.jobs.set(job.id, job);
    return job;
  }

  private invocationsOf(jobId: string): InvestigationInvocation[] {
    return [...this.ledger.values()]
      .filter((row) => row.jobId === jobId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  }

  /** Al cerrar un trabajo: lo reservado no se envió; lo que estaba en vuelo queda sin conciliar. */
  private closeInvocations(jobId: string): void {
    for (const row of this.invocationsOf(jobId)) {
      if (row.state === 'reserved') this.ledger.set(row.id, { ...row, state: 'released' });
      if (row.state === 'dispatching') this.ledger.set(row.id, { ...row, state: 'usage_unknown' });
    }
  }

  private pushEvent(job: InvestigationJob, draft: InvestigationEventDraft): void {
    const log = this.eventLog.get(job.id) ?? [];
    log.push({
      jobId: job.id,
      sequence: log.length + 1,
      at: draft.at,
      stage: draft.stage,
      kind: draft.kind,
      detail: sanitizeEventDetail(draft.detail ?? {}),
    });
    this.eventLog.set(job.id, log);
  }

  public async enqueue(
    input: NewInvestigationJob,
  ): Promise<{ readonly job: InvestigationJob; readonly created: boolean }> {
    const draft = normalizeNewJob(input);
    const existing = [...this.jobs.values()].find(
      (job) => job.tenantId === draft.tenantId && job.idempotencyKey === draft.idempotencyKey,
    );
    if (existing) return { job: existing, created: false };
    const job: InvestigationJob = {
      id: draft.id,
      tenantId: draft.tenantId,
      subject: { ...draft.subject },
      alertIds: [...draft.alertIds],
      priority: draft.priority,
      trigger: draft.trigger,
      source: draft.source,
      initiatedBy: draft.initiatedBy,
      idempotencyKey: draft.idempotencyKey,
      fingerprint: draft.fingerprint,
      policyVersion: draft.policyVersion,
      status: 'queued',
      stage: null,
      inference: null,
      attempt: 0,
      availableAt: draft.availableAt,
      leaseUntil: null,
      fencingToken: 0,
      cancelRequested: false,
      lastErrorCode: null,
      result: null,
      plannedStatus: null,
      evidence: null,
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
      startedAt: null,
      finishedAt: null,
      revision: 1,
    };
    return { job: this.put(job), created: true };
  }

  public async claim(
    at: Date,
    leaseMs: number,
    maxAttempts: number,
  ): Promise<InvestigationJob | null> {
    // Barrido: leases vencidos que ya no se reclaman (cancelados o en cuarentena).
    for (const job of this.jobs.values()) {
      if (job.status !== 'running' || !job.leaseUntil || job.leaseUntil > at) continue;
      if (!job.cancelRequested && job.attempt < maxAttempts) continue;
      const inFlight = this.invocationsOf(job.id).some(
        (row) => row.state === 'dispatching' || row.state === 'usage_unknown',
      );
      this.closeInvocations(job.id);
      this.put({
        ...job,
        status: job.cancelRequested ? 'cancelled' : inFlight ? 'usage_unreconciled' : 'failed',
        plannedStatus: null,
        stage: null,
        leaseUntil: null,
        lastErrorCode: job.cancelRequested ? job.lastErrorCode : 'LEASE_EXPIRED_MAX_ATTEMPTS',
        finishedAt: at,
        updatedAt: at,
        revision: job.revision + 1,
      });
    }
    const candidate = [...this.jobs.values()]
      .filter(
        (job) =>
          !job.cancelRequested &&
          ((job.status === 'queued' && job.availableAt <= at) ||
            (job.status === 'running' && job.leaseUntil !== null && job.leaseUntil <= at)),
      )
      .sort(
        (left, right) =>
          left.priority.localeCompare(right.priority) ||
          left.availableAt.getTime() - right.availableAt.getTime() ||
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.id.localeCompare(right.id),
      )[0];
    if (!candidate) return null;
    return this.put({
      ...candidate,
      status: 'running',
      stage: null,
      attempt: candidate.attempt + 1,
      fencingToken: candidate.fencingToken + 1,
      leaseUntil: new Date(at.getTime() + Math.max(leaseMs, 1_000)),
      startedAt: candidate.startedAt ?? at,
      updatedAt: at,
      revision: candidate.revision + 1,
    });
  }

  public async heartbeat(lease: WorkerLease, at: Date, leaseMs: number): Promise<HeartbeatOutcome> {
    const job = this.owned(lease, at);
    if (!job) return 'lost';
    this.put({ ...job, leaseUntil: new Date(at.getTime() + Math.max(leaseMs, 1_000)) });
    return job.cancelRequested ? 'cancel_requested' : 'ok';
  }

  public async appendEvent(lease: WorkerLease, event: InvestigationEventDraft): Promise<boolean> {
    const job = this.owned(lease, event.at);
    if (!job) return false;
    this.pushEvent(job, event);
    return true;
  }

  public async checkpoint(
    lease: WorkerLease,
    checkpoint: InvestigationCheckpoint,
  ): Promise<boolean> {
    const job = this.owned(lease, checkpoint.at);
    if (!job) return false;
    this.put({
      ...job,
      stage: checkpoint.stage,
      inference: checkpoint.inference ?? job.inference,
      evidence: checkpoint.evidence ?? job.evidence,
      updatedAt: checkpoint.at,
    });
    if (checkpoint.event) {
      this.pushEvent(job, { at: checkpoint.at, stage: checkpoint.stage, ...checkpoint.event });
    }
    return true;
  }

  public async finish(
    lease: WorkerLease,
    finish: InvestigationFinish,
  ): Promise<InvestigationTerminalStatus | null> {
    const job = this.owned(lease, finish.at);
    if (!job) return null;
    const status: InvestigationTerminalStatus = job.cancelRequested ? 'cancelled' : finish.status;
    this.closeInvocations(job.id);
    if (finish.event) this.pushEvent(job, finish.event);
    this.put({
      ...job,
      status,
      stage: null,
      leaseUntil: null,
      inference: finish.inference,
      result: status === 'cancelled' ? null : finish.result,
      plannedStatus: null,
      evidence: finish.evidence ?? job.evidence,
      lastErrorCode:
        finish.errorCode === undefined || finish.errorCode === null
          ? null
          : sanitizeErrorCode(finish.errorCode),
      finishedAt: finish.at,
      updatedAt: finish.at,
      revision: job.revision + 1,
    });
    return status;
  }

  public async releaseForRetry(
    lease: WorkerLease,
    release: InvestigationRetryRelease,
  ): Promise<RetryReleaseOutcome> {
    const job = this.owned(lease, release.at);
    if (!job) return 'stale';
    const refund = release.refundAttempt === true;
    const status = job.cancelRequested
      ? 'cancelled'
      : !refund && job.attempt >= release.maxAttempts
        ? 'failed'
        : 'queued';
    this.closeInvocations(job.id);
    this.put({
      ...job,
      status,
      stage: null,
      leaseUntil: null,
      plannedStatus: status === 'queued' ? job.plannedStatus : null,
      attempt: refund ? Math.max(0, job.attempt - 1) : job.attempt,
      availableAt: status === 'queued' ? release.availableAt : job.availableAt,
      lastErrorCode: sanitizeErrorCode(release.errorCode),
      finishedAt: status === 'queued' ? null : release.at,
      updatedAt: release.at,
      revision: job.revision + 1,
    });
    return status === 'queued' ? 'requeued' : status === 'failed' ? 'quarantined' : 'cancelled';
  }

  public async planActions(
    lease: WorkerLease,
    plan: InvestigationActionPlan,
  ): Promise<readonly InvestigationAction[] | null> {
    const job = this.owned(lease, plan.at);
    if (!job) return null;
    this.put({
      ...job,
      plannedStatus: plan.status,
      result: plan.result,
      inference: plan.inference,
      evidence: plan.evidence ?? job.evidence,
      lastErrorCode:
        plan.errorCode === undefined || plan.errorCode === null
          ? null
          : sanitizeErrorCode(plan.errorCode),
      updatedAt: plan.at,
    });
    const rows = this.actionLog.get(job.id) ?? [];
    for (const action of plan.actions) {
      const index = rows.findIndex((row) => row.kind === action.kind);
      const existing = rows[index];
      if (existing && (existing.state === 'executed' || existing.state === 'planned')) continue;
      const row: InvestigationAction = {
        id: existing?.id ?? randomUUID(),
        jobId: job.id,
        tenantId: job.tenantId,
        kind: action.kind,
        state: 'planned',
        reason: action.reason,
        urgency: action.urgency ?? null,
        groupKey: action.groupKey ?? null,
        at: plan.at,
        executedAt: null,
        ref: null,
        errorCode: null,
      };
      if (existing) rows[index] = row;
      else rows.push(row);
    }
    this.actionLog.set(job.id, rows);
    return [...rows];
  }

  public async markAction(
    lease: WorkerLease,
    kind: InvestigationAction['kind'],
    mark: ActionMark,
  ): Promise<boolean> {
    if (!this.owned(lease, mark.at)) return false;
    const rows = this.actionLog.get(lease.jobId) ?? [];
    const index = rows.findIndex((row) => row.kind === kind);
    const row = rows[index];
    if (!row || row.state !== 'planned') return false;
    rows[index] = {
      ...row,
      state: mark.state,
      executedAt: mark.state === 'executed' ? mark.at : null,
      ref: mark.ref ?? null,
      errorCode:
        mark.errorCode === undefined || mark.errorCode === null
          ? null
          : sanitizeErrorCode(mark.errorCode),
    };
    return true;
  }

  public async actions(tenantId: string, jobId: string): Promise<readonly InvestigationAction[]> {
    return this.jobs.get(jobId)?.tenantId === tenantId
      ? [...(this.actionLog.get(jobId) ?? [])]
      : [];
  }

  public async actionsBetween(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<readonly InvestigationAction[]> {
    return [...this.actionLog.values()]
      .flat()
      .filter((row) => row.tenantId === tenantId && row.at >= from && row.at < to)
      .sort((left, right) => left.at.getTime() - right.at.getTime());
  }

  public async countImmediateReviews(tenantId: string, since: Date): Promise<number> {
    return [...this.actionLog.values()]
      .flat()
      .filter(
        (row) =>
          row.tenantId === tenantId &&
          row.kind === 'request_review' &&
          row.urgency === 'immediate' &&
          row.state !== 'skipped' &&
          row.at >= since,
      ).length;
  }

  public async requestCancel(
    tenantId: string,
    jobId: string,
    expectedRevision: number,
    at: Date,
  ): Promise<InvestigationCommandOutcome> {
    const job = this.jobs.get(jobId);
    if (!job || job.tenantId !== tenantId) return 'not_found';
    if (isTerminalStatus(job.status)) return 'terminal';
    if (job.revision !== expectedRevision) return 'conflict';
    if (job.status === 'queued') {
      this.closeInvocations(job.id);
      this.put({
        ...job,
        status: 'cancelled',
        plannedStatus: null,
        cancelRequested: true,
        finishedAt: at,
        updatedAt: at,
        revision: job.revision + 1,
      });
    } else {
      this.put({ ...job, cancelRequested: true, updatedAt: at, revision: job.revision + 1 });
    }
    return 'ok';
  }

  public async retry(
    tenantId: string,
    jobId: string,
    expectedRevision: number,
    at: Date,
  ): Promise<InvestigationCommandOutcome> {
    const job = this.jobs.get(jobId);
    if (!job || job.tenantId !== tenantId) return 'not_found';
    if (!isTerminalStatus(job.status)) return 'conflict';
    if (!INVESTIGATION_RETRYABLE_STATUSES.includes(job.status)) return 'terminal';
    if (job.revision !== expectedRevision) return 'conflict';
    this.put({
      ...job,
      status: 'queued',
      stage: null,
      inference: null,
      attempt: 0,
      availableAt: at,
      leaseUntil: null,
      cancelRequested: false,
      lastErrorCode: null,
      result: null,
      plannedStatus: null,
      finishedAt: null,
      updatedAt: at,
      revision: job.revision + 1,
    });
    return 'ok';
  }

  public async byId(tenantId: string, jobId: string): Promise<InvestigationJob | undefined> {
    const job = this.jobs.get(jobId);
    return job && job.tenantId === tenantId ? job : undefined;
  }

  public async list(
    tenantId: string,
    options: InvestigationListOptions = {},
  ): Promise<InvestigationPage> {
    const pageSize = clampPageSize(options.pageSize);
    const cursor = options.cursor;
    const rows = [...this.jobs.values()]
      .filter((job) => job.tenantId === tenantId)
      .filter((job) => options.status === undefined || job.status === options.status)
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || (left.id < right.id ? 1 : -1),
      )
      .filter(
        (job) =>
          cursor === undefined ||
          job.createdAt.getTime() < cursor.createdAt.getTime() ||
          (job.createdAt.getTime() === cursor.createdAt.getTime() && job.id < cursor.id),
      );
    const items = rows.slice(0, pageSize);
    const last = items.at(-1);
    return {
      items,
      next: rows.length > pageSize && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }

  public async events(tenantId: string, jobId: string): Promise<readonly InvestigationEvent[]> {
    return this.jobs.get(jobId)?.tenantId === tenantId ? [...(this.eventLog.get(jobId) ?? [])] : [];
  }

  public async invocations(
    tenantId: string,
    jobId: string,
  ): Promise<readonly InvestigationInvocation[]> {
    return this.jobs.get(jobId)?.tenantId === tenantId ? this.invocationsOf(jobId) : [];
  }

  public async findPriorInference(
    tenantId: string,
    fingerprint: string,
    excludeJobId: string,
  ): Promise<InvestigationJob | undefined> {
    const row = [...this.ledger.values()]
      .filter(
        (entry) =>
          entry.tenantId === tenantId &&
          entry.fingerprint === fingerprint &&
          entry.state === 'settled' &&
          entry.jobId !== excludeJobId,
      )
      .sort(
        (left, right) => (right.settledAt?.getTime() ?? 0) - (left.settledAt?.getTime() ?? 0),
      )[0];
    return row ? this.jobs.get(row.jobId) : undefined;
  }

  private dayRows(tenantId: string, at: Date): InvestigationInvocation[] {
    const start = utcDayStart(at).getTime();
    return [...this.ledger.values()].filter(
      (row) =>
        row.tenantId === tenantId &&
        row.createdAt.getTime() >= start &&
        row.createdAt.getTime() < start + DAY_MS,
    );
  }

  public async reserveInvocation(
    lease: WorkerLease,
    request: InvocationReservationRequest,
  ): Promise<InvocationReservation> {
    const job = this.owned(lease, request.at);
    if (!job) return { ok: false, reason: 'STALE_LEASE' };
    if (job.cancelRequested) return { ok: false, reason: 'CANCELLED' };

    const rows = this.invocationsOf(job.id);
    const sameKey = (row: InvestigationInvocation) =>
      row.phase === request.phase && row.fingerprint === request.fingerprint;
    const committed = rows.filter(
      (row) =>
        row.state === 'dispatching' || row.state === 'usage_unknown' || row.state === 'settled',
    );
    // Misma huella ya enviada, o un envío ambiguo de cualquier huella: nunca se reenvía.
    const prior = committed.find(sameKey) ?? committed.find((row) => row.state !== 'settled');
    if (prior) return { ok: true, invocation: prior, reused: true };
    if (committed.length >= request.maxCallsPerRun) return { ok: false, reason: 'RUN_CAP' };
    const reserved = rows.find((row) => row.state === 'reserved' && sameKey(row));
    if (reserved) return { ok: true, invocation: reserved, reused: true };
    // Reservas de otra huella: el dueño anterior perdió el lease antes de enviar.
    for (const row of rows) {
      if (row.state === 'reserved') this.ledger.set(row.id, { ...row, state: 'released' });
    }

    const committedToday = this.dayRows(job.tenantId, request.at).reduce((total, row) => {
      if (row.state === 'released') return total;
      return (
        total + (row.state === 'settled' ? (row.estimatedMicroUsd ?? 0) : row.reservedMicroUsd)
      );
    }, 0);
    if (committedToday + request.reservedMicroUsd > request.dailyCeilingMicroUsd) {
      return { ok: false, reason: 'DAILY_CAP' };
    }

    const released = this.invocationsOf(job.id).find(
      (row) => row.state === 'released' && sameKey(row),
    );
    const invocation: InvestigationInvocation = {
      id: released?.id ?? randomUUID(),
      jobId: job.id,
      tenantId: job.tenantId,
      phase: request.phase,
      fingerprint: request.fingerprint,
      tier: request.tier,
      model: request.model,
      state: 'reserved',
      reservedInputTokens: request.reservedInputTokens,
      reservedOutputTokens: request.reservedOutputTokens,
      reservedMicroUsd: request.reservedMicroUsd,
      usage: null,
      estimatedMicroUsd: null,
      rateCardVersion: request.rateCardVersion,
      createdAt: request.at,
      settledAt: null,
    };
    this.ledger.set(invocation.id, invocation);
    return { ok: true, invocation, reused: false };
  }

  private ownedInvocation(
    lease: WorkerLease,
    invocationId: string,
    at: Date,
  ): InvestigationInvocation | undefined {
    if (!this.owned(lease, at)) return undefined;
    const row = this.ledger.get(invocationId);
    return row && row.jobId === lease.jobId ? row : undefined;
  }

  public async markDispatching(
    lease: WorkerLease,
    invocationId: string,
    at: Date,
  ): Promise<DispatchOutcome> {
    const row = this.ownedInvocation(lease, invocationId, at);
    if (!row || row.state !== 'reserved') return 'stale';
    if (this.jobs.get(lease.jobId)?.cancelRequested) return 'cancelled';
    this.ledger.set(row.id, { ...row, state: 'dispatching' });
    return 'ok';
  }

  public async settleInvocation(
    lease: WorkerLease,
    invocationId: string,
    settlement: InvocationSettlement,
  ): Promise<boolean> {
    const row = this.ownedInvocation(lease, invocationId, settlement.at);
    if (!row || row.state !== 'dispatching') return false;
    this.ledger.set(row.id, {
      ...row,
      state: 'settled',
      usage: { ...settlement.usage },
      estimatedMicroUsd: settlement.estimatedMicroUsd,
      settledAt: settlement.at,
    });
    return true;
  }

  public async releaseInvocation(
    lease: WorkerLease,
    invocationId: string,
    at: Date,
  ): Promise<boolean> {
    const row = this.ownedInvocation(lease, invocationId, at);
    if (!row || (row.state !== 'reserved' && row.state !== 'dispatching')) return false;
    this.ledger.set(row.id, { ...row, state: 'released' });
    return true;
  }

  public async markUsageUnknown(
    lease: WorkerLease,
    invocationId: string,
    at: Date,
  ): Promise<boolean> {
    const row = this.ownedInvocation(lease, invocationId, at);
    if (!row || row.state !== 'dispatching') return false;
    this.ledger.set(row.id, { ...row, state: 'usage_unknown' });
    return true;
  }

  public async budgetSnapshot(
    tenantId: string,
    at: Date,
    limitMicroUsd: number | null = null,
  ): Promise<BudgetSnapshot> {
    const start = utcDayStart(at).getTime();
    const snapshot = {
      reservedMicroUsd: 0,
      settledMicroUsd: 0,
      unknownCount: 0,
      unknownMicroUsd: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      runsToday: { none: 0, economy: 0, advanced: 0 },
    };
    for (const row of this.dayRows(tenantId, at)) {
      if (row.state === 'reserved' || row.state === 'dispatching') {
        snapshot.reservedMicroUsd += row.reservedMicroUsd;
      } else if (row.state === 'usage_unknown') {
        snapshot.unknownCount += 1;
        snapshot.unknownMicroUsd += row.reservedMicroUsd;
      } else if (row.state === 'settled') {
        snapshot.settledMicroUsd += row.estimatedMicroUsd ?? 0;
        snapshot.tokens.input += row.usage?.inputTokens ?? 0;
        snapshot.tokens.output += row.usage?.outputTokens ?? 0;
        snapshot.tokens.cacheRead += row.usage?.cacheReadTokens ?? 0;
        snapshot.tokens.cacheWrite += row.usage?.cacheWriteTokens ?? 0;
      }
    }
    for (const job of this.jobs.values()) {
      const finished = job.finishedAt?.getTime();
      if (job.tenantId !== tenantId || finished === undefined || job.inference === null) continue;
      if (finished >= start && finished < start + DAY_MS) snapshot.runsToday[job.inference] += 1;
    }
    return {
      tenantId,
      day: utcDayStart(at).toISOString().slice(0, 10),
      limitMicroUsd,
      ...snapshot,
    };
  }

  public async activityCounts(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<InvestigationActivityCounts> {
    const byPriority: Record<InvestigationPriority, number> = { P1: 0, P2: 0, P3: 0, P4: 0 };
    const byInference = { none: 0, economy: 0, advanced: 0 };
    const byStatus: Partial<Record<InvestigationStatus, number>> = {};
    let queued = 0;
    let running = 0;
    let oldest: Date | null = null;
    let total = 0;
    for (const job of this.jobs.values()) {
      if (job.tenantId !== tenantId) continue;
      if (job.status === 'queued') {
        queued += 1;
        byPriority[job.priority] += 1;
        if (!oldest || job.createdAt < oldest) oldest = job.createdAt;
      } else if (job.status === 'running') {
        running += 1;
      }
      if (isTerminalStatus(job.status) && job.finishedAt && job.finishedAt >= from && job.finishedAt < to) {
        total += 1;
        byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
        if (job.inference !== null) byInference[job.inference] += 1;
      }
    }
    let settledMicroUsd = 0;
    for (const row of this.ledger.values()) {
      if (row.tenantId === tenantId && row.state === 'settled' && row.createdAt >= from && row.createdAt < to) {
        settledMicroUsd += row.estimatedMicroUsd ?? 0;
      }
    }
    return {
      queue: { queued, running, oldestQueuedAt: oldest, byPriority },
      finished: { total, byInference, byStatus },
      settledMicroUsd,
    };
  }

  public async recentJobs(
    tenantId: string,
    since: Date,
    limit: number,
  ): Promise<readonly InvestigationJob[]> {
    const activity = (job: InvestigationJob) =>
      (job.finishedAt ?? job.startedAt ?? job.updatedAt).getTime();
    return [...this.jobs.values()]
      .filter(
        (job) =>
          job.tenantId === tenantId &&
          (job.status === 'running' ||
            (isTerminalStatus(job.status) && job.finishedAt !== null && job.finishedAt >= since)),
      )
      .sort((left, right) => activity(right) - activity(left) || (left.id < right.id ? 1 : -1))
      .slice(0, Math.max(1, Math.min(Math.trunc(limit) || 1, ACTIVITY_LIMITS.recentJobs)));
  }

  public async escalationOutcomes(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<readonly EscalationOutcome[]> {
    const out: EscalationOutcome[] = [];
    for (const [jobId, log] of this.eventLog) {
      if (this.jobs.get(jobId)?.tenantId !== tenantId) continue;
      for (const event of log) {
        const disposition = event.detail['incident'];
        if (
          event.stage === 'acting' &&
          event.kind === 'completed' &&
          event.detail['action'] === 'escalate' &&
          (disposition === 'created' || disposition === 'attached') &&
          event.at >= from &&
          event.at < to
        ) {
          out.push({ jobId, at: event.at, disposition });
        }
      }
    }
    return out
      .sort((left, right) => right.at.getTime() - left.at.getTime())
      .slice(0, ACTIVITY_LIMITS.escalationOutcomes);
  }

  public async existingKeys(tenantId: string, keys: readonly string[]): Promise<ReadonlySet<string>> {
    const wanted = new Set(keys.slice(0, ACTIVITY_LIMITS.existingKeys));
    const found = new Set<string>();
    for (const job of this.jobs.values()) {
      if (job.tenantId === tenantId && wanted.has(job.idempotencyKey)) found.add(job.idempotencyKey);
    }
    return found;
  }
}
