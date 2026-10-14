import { Queue, Worker as BullWorker } from 'bullmq';
import { setTimeout as delay } from 'node:timers/promises';
import type { EnvironmentInput } from '@qapaq/configuration';
import { loadInjectedWorkerConfig } from '@qapaq/configuration';
import {
  buildNotificationDrain,
  NOTIFICATION_DRAIN_JOB,
  NOTIFICATION_QUEUE_NAME,
  redisConnectionOptions,
} from '@qapaq/api/worker';
import {
  WorkerRuntime,
  type WorkerEvent,
  type WorkerResources,
} from './lifecycle/worker-runtime.js';

const RECONCILIATION_INTERVAL_MS = 30_000;
const OUTBOX_BATCH_SIZE = 5;
const OUTBOX_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1_000 },
  removeOnComplete: 100,
  removeOnFail: 200,
};
const SCHEDULER_RETRY_INITIAL_MS = 1_000;
const SCHEDULER_RETRY_MAX_MS = 30_000;

export async function buildWorker(
  environment: EnvironmentInput,
  emit: WorkerEvent,
  onError: (error: unknown) => void = () => undefined,
) {
  const config = loadInjectedWorkerConfig(environment);
  emit('starting');
  // The worker reuses the API's Postgres policies/dispatch code but does not need to allocate
  // the API's optional Redis event cache or its wake-up producer.
  const apiEnvironment = Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith('QAPAQ_REDIS_')),
  );
  const api = await buildNotificationDrain(apiEnvironment, onError);
  const producerConnection = redisConnectionOptions(config.redis, 'producer');
  const workerConnection = redisConnectionOptions(config.redis, 'worker');
  const queue = new Queue(NOTIFICATION_QUEUE_NAME, {
    connection: producerConnection,
    defaultJobOptions: OUTBOX_JOB_OPTIONS,
  });
  queue.on('error', () => undefined);
  let consumer: BullWorker | undefined;
  let consumerLoop: Promise<void> | undefined;
  const schedulerAbort = new AbortController();
  const consumerAbort = new AbortController();
  let dependencyFailureReported = false;
  const reportDependencyFailure = (error: unknown) => {
    if (dependencyFailureReported) return;
    dependencyFailureReported = true;
    onError(error);
  };
  const resources: WorkerResources = {
    start(run) {
      let retryDelayMs = SCHEDULER_RETRY_INITIAL_MS;
      const reconcileScheduler = async () => {
        while (!schedulerAbort.signal.aborted) {
          try {
            await queue.waitUntilReady();
            dependencyFailureReported = false;
            // Solo persiste una señal repetible; los datos y leases de cada aviso viven en Postgres.
            await queue.upsertJobScheduler(
              'notification-outbox-reconciliation',
              { every: RECONCILIATION_INTERVAL_MS },
              {
                name: NOTIFICATION_DRAIN_JOB,
                data: { source: 'reconciliation' },
                opts: OUTBOX_JOB_OPTIONS,
              },
            );
            return;
          } catch (error) {
            if (schedulerAbort.signal.aborted) return;
            reportDependencyFailure(error);
            try {
              await delay(retryDelayMs, undefined, { signal: schedulerAbort.signal });
            } catch {
              return;
            }
            retryDelayMs = Math.min(retryDelayMs * 2, SCHEDULER_RETRY_MAX_MS);
          }
        }
      };
      void reconcileScheduler();
      consumerLoop = (async () => {
        let retryDelayMs = SCHEDULER_RETRY_INITIAL_MS;
        while (!consumerAbort.signal.aborted) {
          const activeConsumer = new BullWorker(
            NOTIFICATION_QUEUE_NAME,
            async () =>
              run(async () => {
                try {
                  return await api.drain(OUTBOX_BATCH_SIZE);
                } catch (error) {
                  onError(error);
                  throw error;
                }
              }),
            {
              connection: workerConnection,
              concurrency: 1,
              autorun: false,
              lockDuration: 120_000,
              maxStalledCount: 2,
            },
          );
          consumer = activeConsumer;
          activeConsumer.on('error', () => undefined);
          try {
            await activeConsumer.waitUntilReady();
            dependencyFailureReported = false;
            await activeConsumer.run();
          } catch (error) {
            if (consumerAbort.signal.aborted) break;
            reportDependencyFailure(error);
          }
          await activeConsumer.close().catch(() => undefined);
          if (consumerAbort.signal.aborted) break;
          try {
            await delay(retryDelayMs, undefined, { signal: consumerAbort.signal });
          } catch {
            break;
          }
          retryDelayMs = Math.min(retryDelayMs * 2, SCHEDULER_RETRY_MAX_MS);
        }
      })();
    },
    async stop() {
      schedulerAbort.abort();
      consumerAbort.abort();
      await consumer?.close();
      await consumerLoop;
    },
    async close() {
      const results = await Promise.allSettled([queue.close(), api.close()]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    },
  };
  return new WorkerRuntime(emit, 115_000, resources);
}
