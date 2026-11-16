/** Persistencia de intentos C-20 contra PostgreSQL real, aislada en una base temporal. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabaseClient, createDatabaseClient } from '../src/client.js';
import { PrismaNotificationAttemptStore } from '../src/notification-stores.js';

const exec = promisify(execFile);
const databaseUrl = process.env['DATABASE_URL'];
const databaseRoot = fileURLToPath(new URL('../', import.meta.url));
const TENANT = 'tenant-c20';
const ATTEMPT_ID = '0199c200-0000-7000-8000-000000000001';
const MESSAGE_ID = '0199c200-0000-7000-8000-000000000002';

const attempt = {
  id: ATTEMPT_ID,
  tenantId: TENANT,
  messageId: MESSAGE_ID,
  idempotencyKey: 'c20:event:critical-alert',
  clientRequestId: '0199c200-0000-7000-8000-000000000003',
  channel: 'teams',
  status: 'pending',
  attemptCount: 0,
  availableAt: new Date('2026-10-11T12:00:00.000Z'),
  createdAt: new Date('2026-10-11T12:00:00.000Z'),
  updatedAt: new Date('2026-10-11T12:00:00.000Z'),
  lastFailureCode: null,
  lastFailureClass: null,
  sentAt: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
};

async function provisionDatabase() {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for C-20 integration');
  const parsed = new URL(databaseUrl);
  const name = `qapaq_c20_${process.pid}_${Date.now()}`.toLowerCase();
  const adminUrl = new URL(parsed);
  adminUrl.pathname = '/postgres';
  const admin = new Client(adminUrl.toString());
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  parsed.pathname = `/${name}`;
  const url = parsed.toString();
  try {
    await exec(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
      {
        cwd: databaseRoot,
        env: { ...process.env, DATABASE_URL: url },
        shell: process.platform === 'win32',
      },
    );
    return { admin, name, url };
  } catch (error) {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
    throw error;
  }
}

describe.skipIf(!databaseUrl)('C-20 · intentos SOAR durables', () => {
  let database: Awaited<ReturnType<typeof provisionDatabase>> | undefined;
  let client: ReturnType<typeof createDatabaseClient>;
  let store: PrismaNotificationAttemptStore;

  beforeAll(async () => {
    database = await provisionDatabase();
    client = createDatabaseClient({ connectionString: database.url, maxConnections: 4 });
    store = new PrismaNotificationAttemptStore(client);
  });

  afterAll(async () => {
    if (!database) return;
    await closeDatabaseClient(client);
    await database.admin.query(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`);
    await database.admin.end();
  });

  it('conserva intento y estado entre instancias del store', async () => {
    await store.save(attempt);
    const restartedStore = new PrismaNotificationAttemptStore(client);
    const persisted = await restartedStore.byIdempotencyKey(TENANT, attempt.idempotencyKey);

    expect(persisted).toMatchObject({
      id: ATTEMPT_ID,
      messageId: MESSAGE_ID,
      status: 'pending',
      attemptCount: 0,
      clientRequestId: attempt.clientRequestId,
    });
  });

  it('actualiza el intento existente sin duplicar la clave idempotente', async () => {
    await store.save(attempt);
    await store.save({
      ...attempt,
      status: 'sent',
      attemptCount: 1,
      sentAt: new Date('2026-10-11T12:00:02.000Z'),
      updatedAt: new Date('2026-10-11T12:00:02.000Z'),
    });

    const persisted = await store.byId(TENANT, ATTEMPT_ID);
    const count = await client.notificationAttempt.count({
      where: { tenantId: TENANT, idempotencyKey: attempt.idempotencyKey },
    });

    expect(persisted?.status).toBe('sent');
    expect(persisted?.attemptCount).toBe(1);
    expect(count).toBe(1);
  });

  it('resuelve dos primeras escrituras concurrentes con una sola fila', async () => {
    await Promise.all([store.save(attempt), store.save(attempt)]);

    const count = await client.notificationAttempt.count({
      where: { tenantId: TENANT, idempotencyKey: attempt.idempotencyKey },
    });
    expect(count).toBe(1);
  });

  it('lista la bandeja del tenant, más recientes primero, sin filas ajenas', async () => {
    await store.save(attempt);
    await store.save({
      ...attempt,
      id: '0199c200-0000-7000-8000-000000000010',
      tenantId: 'otro-tenant',
      idempotencyKey: 'c20:event:otro',
    });

    const listed = await store.listByTenant(TENANT, 10);

    expect(listed.map((row) => row.tenantId)).toEqual([TENANT]);
  });

  it('cuenta por estado dentro de la ventana, sin filas de otros tenants ni anteriores', async () => {
    await store.save(attempt);
    const counts = await store.countByStatusSince(TENANT, new Date('2026-10-11T00:00:00.000Z'));
    const future = await store.countByStatusSince(TENANT, new Date('2026-10-13T00:00:00.000Z'));

    expect(Object.values(counts).reduce((total, value) => total + value, 0)).toBe(1);
    expect(future).toEqual({});
  });

  it('mide primera aceptación 2xx en 24 h, excluye skew y aísla el tenant', async () => {
    const through = new Date('2026-11-12T12:00:00.000Z');
    const since = new Date(through.getTime() - 24 * 60 * 60 * 1_000);
    const cases = [
      { messageId: '0199c200-0000-7000-8000-000000000101', latencyMs: 1_000 },
      { messageId: '0199c200-0000-7000-8000-000000000102', latencyMs: 2_000 },
      { messageId: '0199c200-0000-7000-8000-000000000103', latencyMs: 3_000 },
      { messageId: '0199c200-0000-7000-8000-000000000104', latencyMs: -500 },
    ];

    for (let index = 0; index < cases.length; index += 1) {
      const sample = cases[index]!;
      const createdAt = new Date(through.getTime() - 60_000 - index * 1_000);
      await client.$executeRaw`
        INSERT INTO soc_outbox_messages (
          message_id, tenant_id, aggregate_type, aggregate_id, message_type,
          schema_version, idempotency_key, payload, available_at, created_at
        ) VALUES (
          ${sample.messageId}::uuid, ${TENANT}, 'alert', ${ATTEMPT_ID}::uuid,
          'notification.requested', '1.0.0', ${`latency:${sample.messageId}`},
          '{}'::jsonb, ${createdAt}, ${createdAt}
        )
      `;
      const acceptedAt = new Date(createdAt.getTime() + sample.latencyMs);
      await store.save({
        ...attempt,
        id: `0199c200-0000-7000-8000-0000000001${index + 1}0`,
        messageId: sample.messageId,
        idempotencyKey: `latency:${sample.messageId}`,
        createdAt,
        updatedAt: createdAt,
        delivery: [
          ...(index === 0
            ? [
                {
                  channel: 'email' as const,
                  outcome: 'accepted' as const,
                  at: new Date(createdAt.getTime() - 500).toISOString(),
                  responseAt: new Date(createdAt.getTime() - 500).toISOString(),
                  httpStatus: 202,
                  providerMessageId: null,
                  providerLink: null,
                  reason: null,
                },
              ]
            : []),
          {
            channel: 'teams',
            outcome: 'accepted',
            at: acceptedAt.toISOString(),
            responseAt: acceptedAt.toISOString(),
            httpStatus: 202,
            providerMessageId: null,
            providerLink: null,
            reason: null,
          },
        ],
      });
    }

    const otherTenantMessage = '0199c200-0000-7000-8000-000000000105';
    const otherCreatedAt = new Date(through.getTime() - 50_000);
    await client.$executeRaw`
      INSERT INTO soc_outbox_messages (
        message_id, tenant_id, aggregate_type, aggregate_id, message_type,
        schema_version, idempotency_key, payload, available_at, created_at
      ) VALUES (
        ${otherTenantMessage}::uuid, 'another-tenant', 'alert', ${ATTEMPT_ID}::uuid,
        'notification.requested', '1.0.0', 'latency:other', '{}'::jsonb,
        ${otherCreatedAt}, ${otherCreatedAt}
      )
    `;
    await store.save({
      ...attempt,
      id: '0199c200-0000-7000-8000-000000000150',
      tenantId: 'another-tenant',
      messageId: otherTenantMessage,
      idempotencyKey: 'latency:other',
      createdAt: otherCreatedAt,
      updatedAt: otherCreatedAt,
      delivery: [
        {
          channel: 'teams',
          outcome: 'accepted',
          at: new Date(otherCreatedAt.getTime() + 100).toISOString(),
          responseAt: new Date(otherCreatedAt.getTime() + 100).toISOString(),
          httpStatus: 202,
          providerMessageId: null,
          providerLink: null,
          reason: null,
        },
      ],
    });

    const metric = await store.providerAcceptanceLatencySince(TENANT, since, through);
    expect(metric).toEqual({
      sampleCount: 3n,
      excludedClockSkewCount: 1n,
      sampleCapReached: false,
      p50: 2_000,
      p95: 2_900,
      p99: 2_980,
    });
  });

  it('no revela un intento de otro tenant por su ID', async () => {
    await store.save(attempt);
    await expect(store.byId('otro-tenant', ATTEMPT_ID)).resolves.toBeUndefined();
  });
});
