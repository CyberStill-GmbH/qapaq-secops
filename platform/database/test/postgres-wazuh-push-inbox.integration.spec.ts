/** Store contract against PostgreSQL: durable receipt, concurrent claims, retries and fencing. */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabaseClient, createDatabaseClient } from '../src/client.js';
import { PrismaWazuhPushInboxStore } from '../src/wazuh-push-inbox-store.js';

const exec = promisify(execFile);
const databaseUrl = process.env['DATABASE_URL'];
const databaseRoot = fileURLToPath(new URL('../', import.meta.url));

function hint(alertId: string, occurredAt = '2026-11-11T12:00:00.123+0000') {
  const managerName = 'manager-a';
  return {
    managerName,
    alertId,
    occurredAt,
    idempotencyKey: createHash('sha256')
      .update(`${managerName}|${alertId}|${occurredAt}`)
      .digest('hex'),
  };
}

async function provisionDatabase() {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for Wazuh push inbox integration');
  const parsed = new URL(databaseUrl);
  const name = `qapaq_wazuh_inbox_${process.pid}_${Date.now()}`.toLowerCase();
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

describe.skipIf(!databaseUrl)('WazuhPushInboxStore · contrato PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof provisionDatabase>> | undefined;
  let client: ReturnType<typeof createDatabaseClient>;
  let store: PrismaWazuhPushInboxStore;

  beforeAll(async () => {
    database = await provisionDatabase();
    client = createDatabaseClient({ connectionString: database.url, maxConnections: 8 });
    store = new PrismaWazuhPushInboxStore(client);
  });

  beforeEach(async () => {
    await client.$executeRaw`TRUNCATE TABLE "wazuh_push_inbox_hints"`;
  });

  afterAll(async () => {
    if (!database) return;
    await closeDatabaseClient(client);
    await database.admin.query(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`);
    await database.admin.end();
  });

  it('inserta el hint minimizado y deduplica escrituras concurrentes por clave', async () => {
    const value = hint('alert-concurrent');
    const results = await Promise.all(Array.from({ length: 12 }, () => store.enqueue(value)));

    expect(results.filter((result) => result === 'inserted')).toHaveLength(1);
    expect(results.filter((result) => result === 'duplicate')).toHaveLength(11);
    await expect(client.wazuhPushInboxHint.count()).resolves.toBe(1);
    await expect(store.metrics()).resolves.toMatchObject({
      counts: { pending: 1, processing: 0, processed: 0, 'failed-terminal': 0 },
      oldestPendingAt: expect.any(Date),
      oldestUnresolvedAt: expect.any(Date),
    });
  });

  it('ready valida el esquema y falla con un error estable si falta la migracion', async () => {
    await expect(store.ready()).resolves.toBeUndefined();
    await client.$executeRaw`ALTER TABLE "wazuh_push_inbox_hints" RENAME TO "wazuh_push_inbox_hints_unready"`;
    try {
      await expect(store.ready()).rejects.toThrow('WAZUH_PUSH_INBOX_SCHEMA_NOT_READY');
    } finally {
      await client.$executeRaw`ALTER TABLE "wazuh_push_inbox_hints_unready" RENAME TO "wazuh_push_inbox_hints"`;
    }
    await expect(store.ready()).resolves.toBeUndefined();
  });

  it('no oculta una colision de clave cuando los datos de identidad no coinciden', async () => {
    const first = hint('alert-original');
    await store.enqueue(first);

    await expect(
      store.enqueue({ ...hint('alert-other'), idempotencyKey: first.idempotencyKey }),
    ).rejects.toThrow('WAZUH_PUSH_HINT_IDEMPOTENCY_CONFLICT');
  });

  it('usa SKIP LOCKED para que otra replica reclame otras filas mientras una esta bloqueada', async () => {
    const lockedHint = hint('alert-locked');
    const otherHint1 = hint('alert-other-1');
    const otherHint2 = hint('alert-other-2');
    await Promise.all([
      store.enqueue(lockedHint),
      store.enqueue(otherHint1),
      store.enqueue(otherHint2),
    ]);
    const lockedRow = await client.wazuhPushInboxHint.findUniqueOrThrow({
      where: { idempotencyKey: lockedHint.idempotencyKey },
      select: { id: true },
    });

    let releaseLock!: () => void;
    let notifyLocked!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      notifyLocked = resolve;
    });
    const lockRelease = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "wazuh_push_inbox_hints" WHERE "id" = ${lockedRow.id}::uuid FOR UPDATE`;
      notifyLocked();
      await lockRelease;
    });

    try {
      await lockAcquired;
      const claimed = await store.claimBatch(new Date(Date.now() + 5_000), 10, 10_000);
      expect(claimed).toHaveLength(2);
      expect(claimed.map((row) => row.id)).not.toContain(lockedRow.id);
    } finally {
      releaseLock();
      await blocker;
    }

    const claimedAfterUnlock = await store.claimBatch(new Date(Date.now() + 5_000), 10, 10_000);
    expect(claimedAfterUnlock.map((row) => row.id)).toEqual([lockedRow.id]);
  });

  it('recupera lease vencido y cerca complete/retry/terminal con el claim vigente', async () => {
    const value = hint('alert-fencing');
    await store.enqueue(value);
    const at = new Date(Date.now() + 2_000);
    const [stale] = await store.claimBatch(at, 1, 2_000);
    expect(stale).toBeDefined();

    const [current] = await store.claimBatch(new Date(at.getTime() + 2_001), 1, 5_000);
    expect(current).toBeDefined();
    expect(current?.claimId).not.toBe(stale?.claimId);
    expect(current?.attemptCount).toBe(2);
    await expect(store.complete(stale!)).resolves.toBe(false);
    await expect(
      store.scheduleRetry(stale!, new Date(at.getTime() + 10_000), 'INDEXER_LOOKUP_RETRYABLE'),
    ).resolves.toBe(false);
    await expect(store.failTerminal(stale!, 'INDEXER_LOOKUP_PERMANENT')).resolves.toBe(false);
    await expect(store.complete(current!)).resolves.toBe(true);
    await expect(store.complete(current!)).resolves.toBe(false);
    await expect(store.metrics()).resolves.toMatchObject({
      counts: { pending: 0, processing: 0, processed: 1, 'failed-terminal': 0 },
      oldestUnresolvedAt: null,
    });
  });

  it('reprograma retry, respeta availableAt y terminaliza sin volver a reclamar', async () => {
    await store.enqueue(hint('alert-retry-terminal'));
    const at = new Date(Date.now() + 2_000);
    const [first] = await store.claimBatch(at, 1, 10_000);
    expect(first).toBeDefined();
    const retryAt = new Date(at.getTime() + 10_000);
    await expect(store.scheduleRetry(first!, retryAt, 'INDEXER_NOT_VISIBLE')).resolves.toBe(true);
    await expect(
      store.claimBatch(new Date(retryAt.getTime() - 1), 1, 10_000),
    ).resolves.toHaveLength(0);

    const [retried] = await store.claimBatch(retryAt, 1, 10_000);
    expect(retried?.attemptCount).toBe(2);
    await expect(store.failTerminal(retried!, 'INDEXER_LOOKUP_PERMANENT')).resolves.toBe(true);
    await expect(
      store.claimBatch(new Date(retryAt.getTime() + 20_000), 1, 10_000),
    ).resolves.toHaveLength(0);
    await expect(store.metrics()).resolves.toMatchObject({
      counts: { pending: 0, processing: 0, processed: 0, 'failed-terminal': 1 },
      oldestUnresolvedAt: null,
    });
  });

  it('reabre por redelivery exacta solo los terminales y conserva processed', async () => {
    const value = hint('alert-terminal-redelivery');
    await store.enqueue(value);
    const at = new Date(Date.now() + 2_000);
    const [first] = await store.claimBatch(at, 1, 10_000);
    expect(first).toBeDefined();
    await expect(store.failTerminal(first!, 'INDEXER_HINT_AMBIGUOUS')).resolves.toBe(true);
    await expect(
      store.enqueue({ ...hint('alert-other-identity'), idempotencyKey: value.idempotencyKey }),
    ).rejects.toThrow('WAZUH_PUSH_HINT_IDEMPOTENCY_CONFLICT');
    await expect(store.metrics()).resolves.toMatchObject({
      counts: { pending: 0, processing: 0, processed: 0, 'failed-terminal': 1 },
    });

    await expect(store.enqueue(value)).resolves.toBe('reopened-terminal');
    await expect(store.metrics()).resolves.toMatchObject({
      counts: { pending: 1, processing: 0, processed: 0, 'failed-terminal': 0 },
      oldestPendingAt: expect.any(Date),
      oldestUnresolvedAt: expect.any(Date),
    });

    const [redelivered] = await store.claimBatch(new Date(at.getTime() + 1_000), 1, 10_000);
    expect(redelivered?.attemptCount).toBe(1);
    await expect(store.complete(redelivered!)).resolves.toBe(true);
    await expect(store.enqueue(value)).resolves.toBe('duplicate');
    await expect(store.metrics()).resolves.toMatchObject({
      counts: { pending: 0, processing: 0, processed: 1, 'failed-terminal': 0 },
      oldestUnresolvedAt: null,
    });
  });

  it('conserva receipt y dedupe al reconstruir el cliente PostgreSQL', async () => {
    const value = hint('alert-persisted');
    await store.enqueue(value);
    await closeDatabaseClient(client);
    client = createDatabaseClient({ connectionString: database!.url, maxConnections: 4 });
    store = new PrismaWazuhPushInboxStore(client);

    await expect(store.enqueue(value)).resolves.toBe('duplicate');
    await expect(store.metrics()).resolves.toMatchObject({
      counts: { pending: 1, processing: 0, processed: 0, 'failed-terminal': 0 },
      oldestPendingAt: expect.any(Date),
    });
  });

  it('mide origen→recepción en la ventana y excluye skew de reloj', async () => {
    const through = new Date(Date.now() + 1_000);
    const samples = [1_000, 2_000, 3_000, -1_000];
    for (const [index, latencyMs] of samples.entries()) {
      const receivedAt = new Date(through.getTime() - 1_000 - index * 1_000);
      const isoOccurredAt = new Date(receivedAt.getTime() - latencyMs).toISOString();
      const occurredAt = index === 0 ? isoOccurredAt.replace('Z', '+0000') : isoOccurredAt;
      const value = hint(`alert-source-lag-${index}`, occurredAt);
      await store.enqueue(value);
      await client.$executeRaw`
        UPDATE "wazuh_push_inbox_hints"
           SET "received_at" = ${receivedAt}
         WHERE "idempotency_key" = ${value.idempotencyKey}
      `;
    }

    const outsideWindow = hint(
      'alert-source-lag-old',
      new Date(through.getTime() - 26 * 60 * 60_000).toISOString(),
    );
    await store.enqueue(outsideWindow);
    await client.$executeRaw`
      UPDATE "wazuh_push_inbox_hints"
         SET "received_at" = ${new Date(through.getTime() - 25 * 60 * 60_000)}
       WHERE "idempotency_key" = ${outsideWindow.idempotencyKey}
    `;

    await expect(store.metrics(through)).resolves.toMatchObject({
      sourceToReceiptMs: {
        windowHours: 24,
        sampleCount: 3,
        clockSkewSamples: 1,
        sampleCapReached: false,
        p50: 2_000,
        p95: 2_900,
        p99: 2_980,
      },
    });
  });
});
