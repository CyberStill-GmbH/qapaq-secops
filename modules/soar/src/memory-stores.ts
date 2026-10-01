/**
 * Stores en memoria de C-20, para unit specs y para el harness E2E.
 *
 * `InMemoryOutbox` reproduce el lease y el reintento diferido; sin eso, una spec de
 * drenaje mediría algo distinto de lo que hará el adapter sobre PostgreSQL.
 */

import type { OutboxMessageDraft } from '@qapaq/soc';

import type { NotificationAttempt, NotificationChannel } from './notification.js';
import type { AttemptStore, FallbackChannel, FallbackNotification, OutboxReader } from './ports.js';

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

  public save(attempt: NotificationAttempt): Promise<void> {
    this.rows.set(`${attempt.tenantId}|${attempt.idempotencyKey}`, attempt);
    return Promise.resolve();
  }
}

/**
 * Fallback de registro: deja el crítico en una bandeja que la consola muestra y que
 * sigue exigiendo acuse. No pretende ser un segundo canal de mensajería.
 */
export class ConsoleFallbackChannel implements FallbackChannel {
  public readonly delivered: FallbackNotification[] = [];

  public notify(
    notification: FallbackNotification,
  ): Promise<{ readonly channel: NotificationChannel; readonly reference: string }> {
    this.delivered.push(notification);
    return Promise.resolve({
      channel: 'manual_console',
      reference: `fallback:${notification.tenantId}:${notification.aggregateId}`,
    });
  }
}
