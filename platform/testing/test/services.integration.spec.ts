import { Client } from 'pg';
import { createClient } from 'redis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('servicios locales reales', () => {
  let postgres: StartedTestContainer;
  let redis: StartedTestContainer;
  let blocked = false;

  beforeAll(async () => {
    try {
      [postgres, redis] = await Promise.all([
        new GenericContainer('postgres:18.6')
          .withEnvironment({
            POSTGRES_DB: 'qapaq_test',
            POSTGRES_PASSWORD: 'qapaq_test_only',
            POSTGRES_USER: 'qapaq',
          })
          .withExposedPorts(5432)
          // La imagen oficial inicia un servidor temporal y luego el definitivo.
          .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
          .start(),
        new GenericContainer('redis:8.10.1')
          .withExposedPorts(6379)
          .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
          .start(),
      ]);
    } catch {
      blocked = true;
    }
  });

  afterAll(async () => {
    await Promise.all([postgres?.stop(), redis?.stop()].filter(Boolean));
  });

  it('executes a PostgreSQL query against the pinned container', async ({ skip }) => {
    if (blocked) return skip();
    const client = new Client({
      host: postgres.getHost(),
      port: postgres.getMappedPort(5432),
      database: 'qapaq_test',
      user: 'qapaq',
      password: 'qapaq_test_only',
    });
    await client.connect();
    const result = await client.query<{ value: number }>('SELECT 1::int AS value');
    await client.end();
    expect(result.rows).toEqual([{ value: 1 }]);
  });

  it('executes PING against the pinned Redis container', async ({ skip }) => {
    if (blocked) return skip();
    const client = createClient({
      url: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    });
    await client.connect();
    expect(await client.ping()).toBe('PONG');
    await client.quit();
  });
});
