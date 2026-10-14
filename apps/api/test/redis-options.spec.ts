import { describe, expect, it } from 'vitest';
import type { RedisConfig } from '@qapaq/configuration';
import { redisConnectionOptions } from '../src/runtime/redis-options.js';

const config = {
  host: 'valkey.internal',
  port: 6379,
  username: 'default',
  password: { value: { reveal: () => 'test-secret' } },
  database: 0,
  tls: true,
  connectionTimeoutMs: 5_000,
  commandTimeoutMs: 5_000,
  retryLimit: 5,
} as unknown as RedisConfig;

describe('opciones de conexión por rol Redis', () => {
  it('mantiene la caché fail-fast con TLS verificado y presupuesto corto', () => {
    const options = redisConnectionOptions(config, 'cache');
    expect(options).toMatchObject({
      host: 'valkey.internal',
      port: 6379,
      username: 'default',
      password: 'test-secret',
      db: 0,
      tls: { servername: 'valkey.internal' },
      connectTimeout: 500,
      commandTimeout: 250,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
  });

  it('conserva el modo durable de BullMQ worker durante una reconexión', () => {
    const options = redisConnectionOptions(config, 'worker');
    expect(options).toMatchObject({
      connectTimeout: 5_000,
      commandTimeout: 5_000,
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    });
  });
});
