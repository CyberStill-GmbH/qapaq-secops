import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { ApiConfig, RedisConfig } from '@qapaq/configuration';
import { AppModule } from './app.module.js';
import type { ApiLifecycle } from './lifecycle.js';
import type { SecOpsRuntime } from './runtime/secops-runtime.js';
import { RedisEventsPageCache, type EventsPageCache } from './runtime/events-page-cache.js';
import { NOTIFICATION_DRAIN_JOB, NOTIFICATION_QUEUE_NAME } from './runtime/notification-queue.js';
import { redisConnectionOptions } from './runtime/redis-options.js';

export interface RedisRuntimeIntegrations {
  readonly eventsPageCache?: EventsPageCache;
  readonly enqueueNotificationWake?: () => Promise<void>;
  close(): Promise<void>;
}

/** Los clientes Redis/BullMQ se crean en la raíz de composición de la API. */
export function createRedisRuntimeIntegrations(config?: RedisConfig): RedisRuntimeIntegrations {
  if (!config) return { close: async () => undefined };

  const redis = new Redis(redisConnectionOptions(config, 'cache'));
  redis.on('error', () => undefined);
  const queue = new Queue(NOTIFICATION_QUEUE_NAME, {
    connection: redisConnectionOptions(config, 'producer'),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  });
  queue.on('error', () => undefined);

  return {
    eventsPageCache: new RedisEventsPageCache(redis),
    enqueueNotificationWake: async () => {
      // BullMQ lleva solo una señal; el cuerpo y los leases durables permanecen en PostgreSQL.
      await queue.add(
        NOTIFICATION_DRAIN_JOB,
        {},
        { jobId: 'notification-outbox-wake', removeOnComplete: true },
      );
    },
    async close() {
      try {
        await queue.close();
      } finally {
        redis.disconnect();
      }
    },
  };
}

export async function composeApi(
  _config: ApiConfig,
  lifecycle: ApiLifecycle,
  runtime?: SecOpsRuntime,
) {
  const adapter = new FastifyAdapter({
    bodyLimit: 1024 * 1024,
    requestTimeout: 15_000,
    logger: false,
    forceCloseConnections: 'idle',
    // El BFF decide la IP del cliente con su propia política de proxies confiables
    // (C-25); delegarlo en Fastify haría confiable cualquier X-Forwarded-For.
    trustProxy: false,
  });
  // Fastify no emite X-Powered-By. CORS permanece deshabilitado.
  // Readiness incluye el estado SOC: con PostgreSQL caído la API no se declara lista.
  const contributors = runtime
    ? [
        () =>
          runtime.soc.ready().then(
            () => true,
            () => false,
          ),
      ]
    : [];
  return NestFactory.create<NestFastifyApplication>(
    AppModule.compose(lifecycle, contributors, runtime),
    adapter,
    { logger: false, abortOnError: false },
  );
}
