/**
 * Stores en memoria de C-20, para unit specs y para el harness E2E.
 *
 * `InMemoryOutbox` reproduce el lease y el reintento diferido; sin eso, una spec de
 * drenaje mediría algo distinto de lo que hará el adapter sobre PostgreSQL.
 */

import type { OutboxMessageDraft } from '@qapaq/soc';
import { recordAudit, type AuditEventDraft, type AuditStore } from '@qapaq/audit';

import {
  acknowledge,
  type DeliveryEvidence,
  type NotificationAttempt,
  type NotificationChannel,
} from './notification.js';
import type {
  AttemptStore,
  FallbackChannel,
  FallbackNotification,
  OutboxReader,
  ProviderAcceptanceLatency,
} from './ports.js';

interface OutboxRow {
  readonly message: OutboxMessageDraft;
  status: 'pending' | 'processing' | 'published';
  availableAt: Date;
  attemptCount: number;
  lastErrorCode: string | null;
  publishedAt: Date | null;
}

export class InMemoryOutbox implements OutboxReader {
  public readonly rows = new Map<string, OutboxRow>();

  public enqueue(message: OutboxMessageDraft): void {
    if (this.rows.has(message.messageId)) return;
    this.rows.set(message.messageId, {
      message,
      status: 'pending',
      availableAt: message.availableAt,
      attemptCount: 0,
      lastErrorCode: null,
      publishedAt: null,
    });
  }

  public claimPending(limit: number, now: Date): Promise<readonly OutboxMessageDraft[]> {
    const claimed: OutboxMessageDraft[] = [];
    for (const row of this.rows.values()) {
      if (claimed.length >= limit) break;
      if (row.status !== 'pending' || row.availableAt.getTime() > now.getTime()) continue;
      row.status = 'processing';
      row.attemptCount += 1;
      claimed.push(row.message);
    }
    return Promise.resolve(claimed);
  }

  public markPublished(messageId: string, at: Date): Promise<void> {
    const row = this.rows.get(messageId);
    if (row) {
      row.status = 'published';
      row.publishedAt = at;
    }
    return Promise.resolve();
  }

  public scheduleRetry(messageId: string, availableAt: Date, errorCode: string): Promise<void> {
    const row = this.rows.get(messageId);
    if (row) {
      row.status = 'pending';
      row.availableAt = availableAt;
      row.lastErrorCode = errorCode;
    }
    return Promise.resolve();
  }
}

export class InMemoryAttemptStore implements AttemptStore {
  public readonly rows = new Map<string, NotificationAttempt>();
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly groupDispatchReservations = new Map<
    string,
    {
      readonly idempotencyKey: string;
      readonly attemptId: string;
      readonly fencingToken: string;
      readonly state: 'leased' | 'uncertain' | 'confirmed';
      readonly leaseUntil: Date;
      readonly quietUntil: Date;
    }
  >();
  private readonly p2ImmediateReservations = new Map<
    string,
    {
      readonly tenantId: string;
      readonly idempotencyKey: string;
      readonly at: Date;
      readonly leaseUntil: Date;
      readonly confirmedAt: Date | null;
    }
  >();

  public byIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<NotificationAttempt | undefined> {
    return Promise.resolve(this.rows.get(`${tenantId}|${idempotencyKey}`));
  }

  public byId(tenantId: string, attemptId: string): Promise<NotificationAttempt | undefined> {
    return Promise.resolve(
      [...this.rows.values()].find(
        (attempt) => attempt.tenantId === tenantId && attempt.id === attemptId,
      ),
    );
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  public save(attempt: NotificationAttempt): Promise<void> {
    return this.serialize(async () => {
      if (attempt.status === 'acknowledged') {
        throw new Error('NOTIFICATION_ACKNOWLEDGEMENT_REQUIRES_ATOMIC_WRITE');
      }
      const key = `${attempt.tenantId}|${attempt.idempotencyKey}`;
      const current = this.rows.get(key);
      // A dispatcher may finish with a stale pre-acknowledgement snapshot. The human
      // acknowledgement is terminal for this delivery attempt and must win.
      if (current?.status === 'acknowledged') return;
      this.rows.set(key, attempt);
    });
  }

  public acknowledgeWithAudit(
    tenantId: string,
    attemptId: string,
    actorId: string,
    at: Date,
    draft: (previousStatus: string) => AuditEventDraft,
    memoryAudit?: AuditStore,
  ): Promise<NotificationAttempt | undefined> {
    if (!memoryAudit) return Promise.reject(new Error('NOTIFICATION_AUDIT_STORE_REQUIRED'));
    return this.serialize(async () => {
      const current = [...this.rows.values()].find(
        (attempt) => attempt.tenantId === tenantId && attempt.id === attemptId,
      );
      if (!current) return undefined;
      const result = acknowledge(current, actorId, at);
      if (!result.ok) return undefined;
      const key = `${tenantId}|${current.idempotencyKey}`;
      try {
        // No attempt mutation is visible unless the append succeeds. If it fails, the
        // old row remains intact; Map.set below cannot fail after a successful append.
        await recordAudit(memoryAudit, draft(current.status));
        this.rows.set(key, result.attempt);
        return result.attempt;
      } catch (error) {
        this.rows.set(key, current);
        throw error;
      }
    });
  }

  public countByStatusSince(
    tenantId: string,
    since: Date,
  ): Promise<Readonly<Record<string, number>>> {
    const counts: Record<string, number> = {};
    for (const attempt of this.rows.values()) {
      if (attempt.tenantId !== tenantId || attempt.createdAt.getTime() < since.getTime()) continue;
      counts[attempt.status] = (counts[attempt.status] ?? 0) + 1;
    }
    return Promise.resolve(counts);
  }

  public providerAcceptanceLatencySince(
    _tenantId: string,
    _since: Date,
    _through: Date,
  ): Promise<ProviderAcceptanceLatency> {
    // In-memory attempts do not retain the durable outbox creation timestamp. Do not
    // manufacture latency from attempt.createdAt or from console fallback evidence.
    return Promise.resolve({
      windowHours: 24,
      sampleCount: 0,
      excludedClockSkewCount: 0,
      sampleCapReached: false,
      p50: null,
      p95: null,
      p99: null,
    });
  }

  public lastNotifiedInGroup(
    tenantId: string,
    groupKey: string,
    since: Date,
  ): Promise<NotificationAttempt | undefined> {
    const notified = [...this.rows.values()]
      .filter(
        (attempt) =>
          attempt.tenantId === tenantId &&
          attempt.groupKey === groupKey &&
          attempt.sentAt !== null &&
          attempt.sentAt.getTime() >= since.getTime(),
      )
      .sort((left, right) => right.sentAt!.getTime() - left.sentAt!.getTime());
    return Promise.resolve(notified[0]);
  }

  public listSuppressedInGroup(
    tenantId: string,
    groupKey: string,
    after: Date,
    limit: number,
  ): Promise<readonly NotificationAttempt[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (attempt) =>
            attempt.tenantId === tenantId &&
            attempt.groupKey === groupKey &&
            attempt.status === 'suppressed' &&
            attempt.createdAt.getTime() > after.getTime(),
        )
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
        .slice(0, limit),
    );
  }

  public reserveP2ImmediateSlot(
    tenantId: string,
    idempotencyKey: string,
    at: Date,
    maximum: number,
  ): Promise<boolean> {
    const reservationKey = JSON.stringify([tenantId, idempotencyKey]);
    const existing = this.p2ImmediateReservations.get(reservationKey);
    const since = at.getTime() - 3_600_000;
    if (
      existing &&
      existing.at.getTime() >= since &&
      existing.at.getTime() <= at.getTime() &&
      (existing.confirmedAt !== null || existing.leaseUntil.getTime() > at.getTime())
    ) {
      if (existing.confirmedAt === null) {
        this.p2ImmediateReservations.set(reservationKey, {
          ...existing,
          at,
          leaseUntil: new Date(at.getTime() + 120_000),
        });
      }
      return Promise.resolve(true);
    }
    for (const [key, reservation] of this.p2ImmediateReservations) {
      if (reservation.confirmedAt === null && reservation.leaseUntil.getTime() <= at.getTime()) {
        this.p2ImmediateReservations.delete(key);
      } else if (reservation.confirmedAt !== null && reservation.confirmedAt.getTime() < since) {
        this.p2ImmediateReservations.delete(key);
      }
    }
    const slots = new Set<string>();
    for (const reservation of this.p2ImmediateReservations.values()) {
      if (
        reservation.tenantId === tenantId &&
        reservation.at.getTime() >= since &&
        reservation.at.getTime() <= at.getTime() &&
        (reservation.confirmedAt !== null || reservation.leaseUntil.getTime() > at.getTime())
      ) {
        slots.add(reservation.idempotencyKey);
      }
    }
    // Preserve the cap for P2 notifications sent before reservations were introduced.
    for (const attempt of this.rows.values()) {
      if (
        attempt.tenantId === tenantId &&
        attempt.context?.['priority'] === 'P2' &&
        attempt.sentAt !== null &&
        attempt.sentAt.getTime() >= since &&
        attempt.sentAt.getTime() <= at.getTime()
      ) {
        slots.add(attempt.idempotencyKey);
      }
    }
    if (maximum <= 0 || slots.size >= maximum) return Promise.resolve(false);
    this.p2ImmediateReservations.set(reservationKey, {
      tenantId,
      idempotencyKey,
      at,
      leaseUntil: new Date(at.getTime() + 120_000),
      confirmedAt: null,
    });
    return Promise.resolve(true);
  }

  public settleP2ImmediateSlot(
    tenantId: string,
    idempotencyKey: string,
    at: Date,
    result: 'delivered' | 'failed' | 'uncertain',
  ): Promise<void> {
    const key = JSON.stringify([tenantId, idempotencyKey]);
    const reservation = this.p2ImmediateReservations.get(key);
    if (reservation) {
      if (result === 'failed') this.p2ImmediateReservations.delete(key);
      else if (result === 'delivered') {
        this.p2ImmediateReservations.set(key, {
          ...reservation,
          at,
          leaseUntil: at,
          confirmedAt: at,
        });
      } else {
        this.p2ImmediateReservations.set(key, {
          ...reservation,
          leaseUntil: new Date(at.getTime() + 120_000),
        });
      }
    }
    return Promise.resolve();
  }

  public reserveGroupDispatchSlot(
    tenantId: string,
    groupKey: string,
    idempotencyKey: string,
    attemptId: string,
    fencingToken: string,
    at: Date,
    quietPeriodMs: number,
    leaseMs: number,
  ): Promise<{ readonly granted: boolean; readonly coveredBy: string | null }> {
    const key = JSON.stringify([tenantId, groupKey]);
    const since = at.getTime() - quietPeriodMs;
    const previous = [...this.rows.values()]
      .filter(
        (attempt) =>
          attempt.tenantId === tenantId &&
          attempt.groupKey === groupKey &&
          attempt.idempotencyKey !== idempotencyKey &&
          attempt.sentAt !== null &&
          attempt.sentAt.getTime() >= since &&
          attempt.sentAt.getTime() <= at.getTime() &&
          ['sent', 'fallback', 'acknowledged', 'superseded'].includes(attempt.status),
      )
      .sort((left, right) => right.sentAt!.getTime() - left.sentAt!.getTime())[0];
    if (previous) return Promise.resolve({ granted: false, coveredBy: previous.id });

    const existing = this.groupDispatchReservations.get(key);
    if (existing) {
      const active =
        existing.state === 'confirmed'
          ? existing.quietUntil.getTime() > at.getTime()
          : existing.leaseUntil.getTime() > at.getTime();
      if (active && existing.state === 'leased') {
        return Promise.resolve({ granted: false, coveredBy: existing.attemptId });
      }
      if (active && existing.state === 'uncertain' && existing.idempotencyKey !== idempotencyKey) {
        return Promise.resolve({ granted: false, coveredBy: existing.attemptId });
      }
      if (active && existing.state === 'confirmed') {
        return Promise.resolve({ granted: false, coveredBy: existing.attemptId });
      }
    }

    this.groupDispatchReservations.set(key, {
      idempotencyKey,
      attemptId,
      fencingToken,
      state: 'leased',
      leaseUntil: new Date(at.getTime() + leaseMs),
      quietUntil: new Date(at.getTime() + quietPeriodMs),
    });
    return Promise.resolve({ granted: true, coveredBy: null });
  }

  public settleGroupDispatchSlot(
    tenantId: string,
    groupKey: string,
    idempotencyKey: string,
    fencingToken: string,
    at: Date,
    quietPeriodMs: number,
    leaseMs: number,
    result: 'delivered' | 'failed' | 'uncertain',
  ): Promise<void> {
    const key = JSON.stringify([tenantId, groupKey]);
    const current = this.groupDispatchReservations.get(key);
    if (
      !current ||
      current.idempotencyKey !== idempotencyKey ||
      current.fencingToken !== fencingToken
    ) {
      return Promise.resolve();
    }
    if (result === 'failed') {
      this.groupDispatchReservations.delete(key);
    } else if (result === 'delivered') {
      this.groupDispatchReservations.set(key, {
        ...current,
        state: 'confirmed',
        leaseUntil: at,
        quietUntil: new Date(at.getTime() + quietPeriodMs),
      });
    } else {
      this.groupDispatchReservations.set(key, {
        ...current,
        state: 'uncertain',
        leaseUntil: new Date(at.getTime() + leaseMs),
      });
    }
    return Promise.resolve();
  }

  public listUndigested(tenantId: string, limit: number): Promise<readonly NotificationAttempt[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (attempt) =>
            attempt.tenantId === tenantId &&
            attempt.status === 'suppressed' &&
            (attempt.digestId ?? null) === null,
        )
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
        .slice(0, limit),
    );
  }

  public listByTenant(tenantId: string, limit: number): Promise<readonly NotificationAttempt[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((attempt) => attempt.tenantId === tenantId)
        .sort(
          (left, right) =>
            right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
        )
        .slice(0, Math.max(limit, 1)),
    );
  }
}

/**
 * Fallback de registro: deja el crítico en una bandeja que la consola muestra y que
 * sigue exigiendo acuse. No pretende ser un segundo canal de mensajería.
 */
export class ConsoleFallbackChannel implements FallbackChannel {
  public readonly delivered: FallbackNotification[] = [];

  public notify(notification: FallbackNotification): Promise<{
    readonly channel: NotificationChannel;
    readonly reference: string;
    readonly evidence: readonly DeliveryEvidence[];
  }> {
    this.delivered.push(notification);
    return Promise.resolve({
      channel: 'manual_console',
      reference: `fallback:${notification.tenantId}:${notification.aggregateId}`,
      evidence: [
        {
          channel: 'console',
          outcome: 'accepted',
          at: notification.at.toISOString(),
          httpStatus: null,
          providerMessageId: null,
          providerLink: null,
          reason: notification.reason,
        },
      ],
    });
  }
}
