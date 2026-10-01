/**
 * Puertos de C-20.
 *
 * `OutboxReader.claimPending` toma un lease: dos réplicas del worker no deben despachar
 * el mismo mensaje a la vez. La idempotencia del intento protege igualmente, pero un
 * lease evita gastar dos llamadas al destino por cada crítico.
 */

import type { OutboxMessageDraft } from '@qapaq/soc';

import type { NotificationAttempt, NotificationChannel } from './notification.js';

export interface OutboxReader {
  claimPending(limit: number, now: Date): Promise<readonly OutboxMessageDraft[]>;
  markPublished(messageId: string, at: Date): Promise<void>;
  scheduleRetry(messageId: string, availableAt: Date, errorCode: string): Promise<void>;
}

export interface AttemptStore {
  byIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<NotificationAttempt | undefined>;
  byId(tenantId: string, attemptId: string): Promise<NotificationAttempt | undefined>;
  save(attempt: NotificationAttempt): Promise<void>;
}

export interface FallbackNotification {
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly title: string;
  readonly severity: string;
  readonly reason: string;
  readonly at: Date;
}

export interface FallbackChannel {
  notify(
    notification: FallbackNotification,
  ): Promise<{ readonly channel: NotificationChannel; readonly reference: string }>;
}
