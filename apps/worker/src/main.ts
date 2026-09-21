import { Redis } from 'ioredis';

import { loadWorkerConfig } from '@qapaq/configuration';

const config = loadWorkerConfig(process.env);
const redis = new Redis(config.redisUrl.toString(), {
  enableReadyCheck: true,
  lazyConnect: true,
  maxRetriesPerRequest: null,
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
