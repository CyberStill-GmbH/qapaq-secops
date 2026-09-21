import { Redis } from 'ioredis';

import { ConfigurationError, loadLocalWorkerConfig } from '@qapaq/configuration';

async function main(): Promise<void> {
  const config = await loadLocalWorkerConfig(process.env);
  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    db: config.redis.database,
    ...(config.redis.username ? { username: config.redis.username } : {}),
    ...(config.redis.password ? { password: config.redis.password.value.reveal() } : {}),
    ...(config.redis.tls ? { tls: {} } : {}),
    connectTimeout: config.redis.connectionTimeoutMs,
    commandTimeout: config.redis.commandTimeoutMs,
    enableReadyCheck: true,
    lazyConnect: true,
    maxRetriesPerRequest: config.redis.retryLimit,
  });
  await redis.connect();
  await redis.ping();
  process.stdout.write('{"service":"qapaq-worker","status":"ready"}\n');

  const shutdown = async (): Promise<void> => {
    await redis.quit();
    process.exitCode = 0;
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

try {
  await main();
} catch (error) {
  const safeError =
    error instanceof ConfigurationError
      ? error.toJSON()
      : { code: 'BOOTSTRAP_FAILED', message: 'El worker no pudo iniciar de forma segura.' };
  process.stderr.write(`${JSON.stringify(safeError)}\n`);
  process.exitCode = 1;
}
