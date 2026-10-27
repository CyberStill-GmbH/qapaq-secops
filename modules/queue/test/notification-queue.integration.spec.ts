import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import type { RedisOptions } from 'bullmq';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NOTIFICATION_DLQ,
  NOTIFICATION_QUEUE,
  createNotificationQueueConsumer,
  createNotificationQueuePublisher,
} from '../src/index.js';

const outboxId = 'b25b59b2-5c61-4e0b-8eaf-123456789abc';
const connection: RedisOptions = {
  host: process.env.QAPAQ_TEST_REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.QAPAQ_TEST_REDIS_PORT ?? '6379'),
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  connectTimeout: 3_000,
};
const openedQueues: Queue[] = [];

function waitFor<T>(promise: Promise<T>, timeoutMs = 8_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('QUEUE_ACCEPTANCE_TIMEOUT')), timeoutMs).unref();
    }),
  ]);
}

afterEach(async () => {
  await Promise.all(openedQueues.splice(0).map((queue) => queue.close()));
});

describe('BullMQ notification runtime against Redis', () => {
  it('enqueues ID-only jobs once, consumes them, exposes depth, and drains active work on shutdown', async () => {
    const namespace = { prefix: `qapaq-test-${randomUUID()}` };
    const metrics: string[] = [];
    const publisher = createNotificationQueuePublisher(
      connection,
      (metric) => metrics.push(metric.event),
      namespace,
    );
    let notifyStarted!: () => void;
    let releaseHandler!: () => void;
    const started = new Promise<void>((resolve) => (notifyStarted = resolve));
    const released = new Promise<void>((resolve) => (releaseHandler = resolve));
    const handled: string[] = [];
    const consumer = createNotificationQueueConsumer(
      connection,
      {
        async process(id) {
          handled.push(id);
          notifyStarted();
          await released;
        },
      },
      (metric) => metrics.push(metric.event),
      namespace,
    );
    const inspect = new Queue(NOTIFICATION_QUEUE, {
      connection,
      prefix: namespace.prefix,
    });
    const inspectDlq = new Queue(NOTIFICATION_DLQ, {
      connection,
      prefix: namespace.prefix,
    });
    openedQueues.push(inspect, inspectDlq);

    try {
      consumer.start();
      const firstId = await publisher.enqueue(outboxId);
      const duplicateId = await publisher.enqueue(outboxId);
      expect(firstId).toBe(duplicateId);
      await waitFor(started);

      const queuedJob = await inspect.getJob(firstId);
      expect(queuedJob?.data).toEqual({ schemaVersion: 1, outboxId });
      expect(Object.keys(queuedJob?.data ?? {}).sort()).toEqual(['outboxId', 'schemaVersion']);
      expect(
        await inspectDlq.getJobCounts('waiting', 'active', 'completed', 'failed'),
      ).toMatchObject({
        waiting: 0,
        active: 0,
      });
      expect(handled).toEqual([outboxId]);

      let closed = false;
      const closing = consumer.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      releaseHandler();
      await waitFor(closing);

      const depth = await publisher.depth();
      expect(depth.completed).toBe(1);
      expect(metrics).toContain('enqueued');
      expect(metrics).toContain('completed');
      expect(metrics).toContain('depth');
    } finally {
      releaseHandler();
      await consumer.close();
      await publisher.close();
    }
  });

  it('retries transient work and places only the outbox reference in the dead-letter queue', async () => {
    const namespace = { prefix: `qapaq-test-${randomUUID()}` };
    const metrics: string[] = [];
    let attempts = 0;
    const publisher = createNotificationQueuePublisher(
      connection,
      (metric) => metrics.push(metric.event),
      namespace,
      {
        attempts: 2,
        backoffDelayMs: 10,
        dedupeRetentionSeconds: 60,
        dedupeRetentionCount: 100,
      },
    );
    const consumer = createNotificationQueueConsumer(
      connection,
      {
        async process() {
          attempts += 1;
          const error = new Error('provider response may contain sensitive data');
          Object.assign(error, { code: 'PROVIDER_TIMEOUT' });
          throw error;
        },
      },
      (metric) => metrics.push(metric.event),
      namespace,
    );
    const queue = new Queue(NOTIFICATION_QUEUE, {
      connection,
      prefix: namespace.prefix,
    });
    const deadLetter = new Queue(NOTIFICATION_DLQ, {
      connection,
      prefix: namespace.prefix,
    });
    openedQueues.push(queue, deadLetter);

    try {
      consumer.start();
      const jobId = await publisher.enqueue(outboxId);
      const deadLetterId = await waitFor(
        (async () => {
          const deadline = Date.now() + 8_000;
          while (Date.now() < deadline) {
            const jobs = await deadLetter.getJobs(['waiting', 'active', 'completed', 'failed']);
            if (jobs.length > 0) return jobs[0]!.id;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          throw new Error('QUEUE_ACCEPTANCE_TIMEOUT');
        })(),
      );
      const deadLetterJob = await deadLetter.getJob(String(deadLetterId));
      const failedJob = await queue.getJob(jobId);

      expect(attempts).toBe(2);
      expect(deadLetterJob?.data).toEqual({ schemaVersion: 1, outboxId });
      expect(failedJob?.failedReason).toBe('QAPAQ_JOB_FAILED:PROVIDER_TIMEOUT');
      expect(failedJob?.failedReason).not.toContain('sensitive');
      const depth = await consumer.depth();
      expect(depth[`${NOTIFICATION_DLQ}.waiting`]).toBe(1);
      expect(metrics).toContain('depth');
      expect(metrics).toContain('dead-lettered');
      expect(metrics).toContain('failed');
    } finally {
      await consumer.close();
      await publisher.close();
    }
  });
});
