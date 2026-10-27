import { Queue, Worker, type Job } from 'bullmq';
import {
  NOTIFICATION_DLQ,
  NOTIFICATION_QUEUE,
  notificationJobId,
  parseOutboxReference,
  type OutboxReference,
} from './notification-contract.js';
import {
  type QueueMetricsSink,
  type QueueNamespace,
  safelyRecord,
  toBullMqConnectionOptions,
  type RedisConnectionOptions,
} from './notification-queue.js';

export interface NotificationJobHandler {
  /** Recupera y reclama el outbox por ID; debe aplicar fencing e idempotencia antes del efecto. */
  process(outboxId: string): Promise<void>;
}

export interface NotificationQueueConsumer {
  start(): void;
  depth(): Promise<Readonly<Record<string, number>>>;
  close(): Promise<void>;
}

const RETRY_ATTEMPTS = 5;

/** Código de error acotado; nunca persiste texto de error del proveedor en BullMQ. */
function safeErrorCode(error: unknown): string {
  const candidate =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof candidate === 'string' && /^[A-Z0-9_]{1,64}$/u.test(candidate)
    ? candidate
    : 'JOB_PROCESSING_FAILED';
}

export function createNotificationQueueConsumer(
  connection: RedisConnectionOptions,
  handler: NotificationJobHandler,
  metrics: QueueMetricsSink = () => undefined,
  namespace: QueueNamespace = {},
): NotificationQueueConsumer {
  const deadLetter = new Queue<OutboxReference, unknown, string>(NOTIFICATION_DLQ, {
    connection: toBullMqConnectionOptions(connection, 1),
    ...(namespace.prefix ? { prefix: namespace.prefix } : {}),
    defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
  });
  const queue = new Queue<OutboxReference, unknown, string>(NOTIFICATION_QUEUE, {
    connection: toBullMqConnectionOptions(connection, 1),
    ...(namespace.prefix ? { prefix: namespace.prefix } : {}),
  });
  const worker = new Worker<OutboxReference, unknown, string>(
    NOTIFICATION_QUEUE,
    async (job) => {
      const reference = parseOutboxReference(job.data);
      try {
        await handler.process(reference.outboxId);
      } catch (error) {
        const code = safeErrorCode(error);
        if (job.attemptsMade + 1 >= (job.opts.attempts ?? RETRY_ATTEMPTS)) {
          // BullMQ also retains this job in its failed set; the DLQ carries only its outbox ID.
          const jobId = notificationJobId(reference.outboxId);
          await deadLetter.add('exhausted-outbox', reference, { jobId });
          safelyRecord(metrics, { event: 'dead-lettered', queue: NOTIFICATION_DLQ, jobId });
        }
        throw new Error(`QAPAQ_JOB_FAILED:${code}`);
      }
      return { outboxId: reference.outboxId };
    },
    {
      connection: toBullMqConnectionOptions(connection, null),
      concurrency: 4,
      autorun: false,
      ...(namespace.prefix ? { prefix: namespace.prefix } : {}),
    },
  );
  let started = false;
  let closing: Promise<void> | undefined;

  worker.on('completed', (job: Job<OutboxReference>) => {
    const jobId = job.id ?? notificationJobId(job.data.outboxId);
    safelyRecord(metrics, { event: 'completed', queue: NOTIFICATION_QUEUE, jobId });
  });
  worker.on('failed', (job) => {
    if (!job) return;
    const jobId = job.id ?? notificationJobId(job.data.outboxId);
    safelyRecord(metrics, { event: 'failed', queue: NOTIFICATION_QUEUE, jobId });
  });
  worker.on('stalled', (jobId) =>
    safelyRecord(metrics, { event: 'stalled', queue: NOTIFICATION_QUEUE, jobId }),
  );
  worker.on('error', () => {
    // Error details may contain connection metadata; readiness owns reporting at the composition boundary.
  });

  return {
    start() {
      if (started) throw new Error('QUEUE_CONSUMER_ALREADY_STARTED');
      if (closing) throw new Error('QUEUE_CONSUMER_CLOSED');
      started = true;
      void worker.run().catch(() => undefined);
    },
    async depth() {
      const [counts, dlqCounts] = await Promise.all([
        queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed'),
        deadLetter.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed'),
      ]);
      safelyRecord(metrics, {
        event: 'depth',
        queue: NOTIFICATION_QUEUE,
        counts,
      });
      safelyRecord(metrics, {
        event: 'depth',
        queue: NOTIFICATION_DLQ,
        counts: dlqCounts,
      });
      return Object.fromEntries([
        ...Object.entries(counts).map(([state, count]) => [
          `${NOTIFICATION_QUEUE}.${state}`,
          count,
        ]),
        ...Object.entries(dlqCounts).map(([state, count]) => [
          `${NOTIFICATION_DLQ}.${state}`,
          count,
        ]),
      ]);
    },
    close() {
      return (closing ??= (async () => {
        // BullMQ close stops fetching new jobs and waits for active handlers to finish.
        await worker.close();
        await Promise.all([queue.close(), deadLetter.close()]);
      })());
    },
  };
}
