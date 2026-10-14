import type { RedisConfig } from '@qapaq/configuration';

export type RedisConnectionRole = 'cache' | 'producer' | 'worker';

/** Ajustes por tipo de conexión; TLS verifica el certificado por defecto. */
export function redisConnectionOptions(config: RedisConfig, role: RedisConnectionRole = 'cache') {
  const worker = role === 'worker';
  return {
    host: config.host,
    port: config.port,
    ...(config.username ? { username: config.username } : {}),
    ...(config.password ? { password: config.password.value.reveal() } : {}),
    db: config.database,
    ...(config.tls ? { tls: { servername: config.host } } : {}),
    connectTimeout: worker ? config.connectionTimeoutMs : Math.min(config.connectionTimeoutMs, 500),
    commandTimeout: worker
      ? config.commandTimeoutMs
      : Math.min(config.commandTimeoutMs, role === 'cache' ? 250 : 1_000),
    maxRetriesPerRequest: worker
      ? null
      : role === 'cache'
        ? 1
        : Math.max(1, Math.min(config.retryLimit, 2)),
    retryStrategy: (attempt: number) => Math.min(attempt * 100, 5_000),
    lazyConnect: true,
    // HTTP producers and cache reads fail quickly; a BullMQ consumer stays queued through
    // a Valkey interruption and reconnects without losing the PostgreSQL-backed work.
    enableOfflineQueue: worker,
  };
}
