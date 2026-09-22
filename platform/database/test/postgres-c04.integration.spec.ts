import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabaseClient, createDatabaseClient } from '../src/client.js';
import { runDatabaseTransaction } from '../src/transaction.js';
import { admissionFixture, insertFixture } from './fixtures.js';

const exec = promisify(execFile);
const databaseUrl = process.env['DATABASE_URL'];
const databaseRoot = new URL('../', import.meta.url).pathname
  .replace(/^\//, '')
  .replace(/\//g, '\\');

function temporaryDatabaseName(): string {
  return `qapaq_c04_${process.pid}_${Date.now()}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

async function createTemporaryDatabase(): Promise<{
  readonly url: string;
  readonly name: string;
  readonly admin: Client;
}> {
  if (!databaseUrl) throw new Error('DATABASE_URL es obligatorio para la suite PostgreSQL C-04');
  const parsed = new URL(databaseUrl);
  const name = temporaryDatabaseName();
  const adminUrl = new URL(parsed);
  adminUrl.pathname = '/postgres';
  const admin = new Client(adminUrl.toString());
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  parsed.pathname = `/${name}`;
  const url = parsed.toString();
  try {
    const output = await exec(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
      {
        cwd: databaseRoot,
        env: { ...process.env, DATABASE_URL: url },
        shell: process.platform === 'win32',
      },
    );
    expect(`${output.stdout}${output.stderr}`).toMatch(
      /No pending migrations to apply|All migrations have been successfully applied/u,
    );
    return { url, name, admin };
  } catch (error) {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
    throw error;
  }
}

describe.skipIf(!databaseUrl)('C-04 PostgreSQL real: vacío, rollback y concurrencia', () => {
  let temporary:
    { readonly url: string; readonly name: string; readonly admin: Client } | undefined;

  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
  });

  afterAll(async () => {
    if (temporary) {
      await temporary.admin.query(`DROP DATABASE IF EXISTS "${temporary.name}" WITH (FORCE)`);
      await temporary.admin.end();
    }
  });

  it('aplica la migración desde una base vacía y crea exactamente siete tablas', async () => {
    const client = new Client(temporary!.url);
    await client.connect();
    const result = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`,
    );
    await client.end();
    expect(result.rows.map((row) => row.tablename)).toEqual([
      'event_inbox',
      'ingestion_manifests',
      'outbox_messages',
      'quarantined_events',
      'raw_event_references',
      'source_checkpoints',
      'sources',
    ]);
  });

  it('revierte todas las escrituras cuando falla una etapa de admisión', async () => {
    const client = createDatabaseClient({ connectionString: temporary!.url });
    const fixture = admissionFixture();
    await expect(
      runDatabaseTransaction(client, (tx) => insertFixture(tx, fixture, 4)),
    ).rejects.toThrow('Fallo inyectado de prueba');
    const counts = await Promise.all([
      client.source.count(),
      client.ingestionManifest.count(),
      client.rawEventReference.count(),
      client.eventInbox.count(),
      client.outboxMessage.count(),
      client.quarantinedEvent.count(),
      client.sourceCheckpoint.count(),
    ]);
    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0]);
    await closeDatabaseClient(client);
  });

  it('resuelve una carrera concurrente en una sola escritura', async () => {
    const client = createDatabaseClient({ connectionString: temporary!.url, maxConnections: 4 });
    const fixture = admissionFixture();
    const attempts = await Promise.allSettled([
      runDatabaseTransaction(client, (tx) => insertFixture(tx, fixture)),
      runDatabaseTransaction(client, (tx) => insertFixture(tx, fixture)),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(await client.source.count()).toBe(1);
    expect(await client.ingestionManifest.count()).toBe(1);
    expect(await client.eventInbox.count()).toBe(1);
    expect(await client.outboxMessage.count()).toBe(1);
    await closeDatabaseClient(client);
  });
});
