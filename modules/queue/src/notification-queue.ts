import { Queue } from 'bullmq';
import type { RedisOptions as BullMqRedisOptions } from 'bullmq';
import type { RedisOptions as Ioredis6Options } from 'ioredis';
import {
  NOTIFICATION_QUEUE,
  notificationJobId,
  type OutboxReference,
} from './notification-contract.js';

export type RedisConnectionOptions = Pick<
  Ioredis6Options,
  'host' | 'port' | 'username' | 'password' | 'db' | 'tls' | 'connectTimeout'
>;

/** Copia solo opciones de conexión públicas; BullMQ crea su cliente ioredis 5 interno. */
export function toBullMqConnectionOptions(
  options: RedisConnectionOptions,
  maxRetriesPerRequest: number | null,
): BullMqRedisOptions {
  return {
    ...(options.host ? { host: options.host } : {}),
    ...(options.port ? { port: options.port } : {}),
    ...(options.username ? { username: options.username } : {}),
    ...(options.password ? { password: options.password } : {}),
    ...(options.db === undefined ? {} : { db: options.db }),
    ...(options.tls ? { tls: options.tls } : {}),
    ...(options.connectTimeout === undefined ? {} : { connectTimeout: options.connectTimeout }),
    maxRetriesPerRequest,
  };
}

export interface QueueNamespace {
  /** Permite aislar pruebas; producción conserva el prefijo compartido por BullMQ. */
  readonly prefix?: string;
}

export type QueueMetricEvent =
  | { readonly event: 'enqueued'; readonly queue: string; readonly jobId: string }
  | {
      readonly event: 'completed' | 'failed' | 'stalled' | 'dead-lettered';
      readonly queue: string;
      readonly jobId: string;
    }
  | {
      readonly event: 'depth';
      readonly queue: string;
      readonly counts: Readonly<Record<string, number>>;
    };

export type QueueMetricsSink = (metric: QueueMetricEvent) => void;

export interface NotificationQueuePolicy {
  readonly attempts: number;
  readonly backoffDelayMs: number;
  readonly dedupeRetentionSeconds: number;
  readonly dedupeRetentionCount: number;
}

export const DEFAULT_NOTIFICATION_QUEUE_POLICY: NotificationQueuePolicy = Object.freeze({
  attempts: 5,
  backoffDelayMs: 5_000,
  dedupeRetentionSeconds: 7 * 24 * 60 * 60,
  dedupeRetentionCount: 10_000,
});

export interface NotificationQueuePublisher {
  /** Encola solo el UUID del outbox; reintentar la llamada conserva el mismo jobId. */
  enqueue(outboxId: string): Promise<string>;
  /** Exposición de profundidad para observabilidad operativa, sin leer datos de jobs. */
  depth(): Promise<Readonly<Record<string, number>>>;
  close(): Promise<void>;
}

export function safelyRecord(metrics: QueueMetricsSink, event: QueueMetricEvent): void {
  try {
    metrics(event);
  } catch {
    // Observabilidad nunca debe convertir un enqueue o consumo exitoso en fallo de trabajo.
  }
}

export function createNotificationQueuePublisher(
  connection: RedisConnectionOptions,
  metrics: QueueMetricsSink = () => undefined,
  namespace: QueueNamespace = {},
  policy: NotificationQueuePolicy = DEFAULT_NOTIFICATION_QUEUE_POLICY,
): NotificationQueuePublisher {
  if (
    !Number.isSafeInteger(policy.attempts) ||
    policy.attempts < 1 ||
    !Number.isSafeInteger(policy.backoffDelayMs) ||
    policy.backoffDelayMs < 0 ||
    !Number.isSafeInteger(policy.dedupeRetentionSeconds) ||
    policy.dedupeRetentionSeconds < 1 ||
    !Number.isSafeInteger(policy.dedupeRetentionCount) ||
    policy.dedupeRetentionCount < 1
  ) {
    throw new Error('QUEUE_POLICY_INVALID');
  }
  const queue = new Queue<OutboxReference, unknown, string>(NOTIFICATION_QUEUE, {
    connection: toBullMqConnectionOptions(connection, 1),
    ...(namespace.prefix ? { prefix: namespace.prefix } : {}),
    defaultJobOptions: {
      attempts: policy.attempts,
      backoff: { type: 'exponential', delay: policy.backoffDelayMs },
      removeOnComplete: {
        age: policy.dedupeRetentionSeconds,
        count: policy.dedupeRetentionCount,
      },
      // Retain exhausted jobs as the operational DLQ source of truth.
      removeOnFail: false,
    },
  });
  let closing: Promise<void> | undefined;

  return {
    async enqueue(outboxId) {
      const jobId = notificationJobId(outboxId);
      await queue.add('dispatch-outbox', { schemaVersion: 1, outboxId }, { jobId });
      safelyRecord(metrics, { event: 'enqueued', queue: NOTIFICATION_QUEUE, jobId });
      return jobId;
    },
    async depth() {
      const counts = await queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'completed',
        'failed',
      );
      safelyRecord(metrics, { event: 'depth', queue: NOTIFICATION_QUEUE, counts });
      return counts;
    },
    close() {
      return (closing ??= queue.close());
    },
  };
}
