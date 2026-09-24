import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabaseClient, createDatabaseClient } from '../src/client.js';
import { AdmissionError, commitAdmission, type AdmissionCommand } from '../src/commit-admission.js';
import { runDatabaseTransaction } from '../src/transaction.js';
import { admissionCommandFixture, admissionFixture, insertFixture } from './fixtures.js';

const exec = promisify(execFile);
const databaseUrl = process.env['DATABASE_URL'];
const databaseRoot = fileURLToPath(new URL('../', import.meta.url));

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

  it('admite un lote completo, devuelve el mismo recibo y revierte un cursor obsoleto', async () => {
    const client = createDatabaseClient({ connectionString: temporary!.url, maxConnections: 4 });
    try {
      const fixture = admissionFixture();
      await client.source.create({ data: fixture.source });
      const command: AdmissionCommand = {
        sourceId: fixture.source.id,
        dataset: fixture.source.dataset,
        manifestKey: fixture.manifest.manifestKey,
        manifestId: fixture.manifest.id,
        outboxId: fixture.outbox.id,
        messageId: fixture.outbox.messageId,
        outboxIdempotencyKey: fixture.outbox.idempotencyKey,
        receivedAt: fixture.manifest.receivedAt,
        expectedRevision: 0n,
        cursor: { from: null, to: 'cursor-1', version: '1' },
        newRawObjects: [
          {
            id: fixture.raw.id,
            objectRef: fixture.raw.objectRef,
            sha256: fixture.raw.sha256,
            mediaType: fixture.raw.mediaType,
            sizeBytes: fixture.raw.sizeBytes,
            receivedAt: fixture.raw.receivedAt,
          },
        ],
        events: [
          {
            id: fixture.inbox.id,
            recordId: fixture.inbox.recordId,
            providerEventId: fixture.inbox.providerEventId,
            idempotencyKey: fixture.inbox.idempotencyKey,
            rawReferenceId: fixture.raw.id,
            quarantine: { id: fixture.quarantine.id, errorCode: fixture.quarantine.errorCode },
          },
        ],
      };
      const committed = await commitAdmission(client, command);
      expect(committed).toEqual({
        manifestId: fixture.manifest.id,
        eventCount: 1,
        acceptedCount: 0,
        quarantinedCount: 1,
        duplicateCount: 0,
        checkpointRevision: 1n,
      });
      expect(await commitAdmission(client, command)).toEqual(committed);
      const changed = {
        ...command,
        events: [{ ...command.events[0]!, providerEventId: 'otro-evento' }],
      };
      await expect(commitAdmission(client, changed)).rejects.toMatchObject({
        code: 'PERSISTENCE_CONSTRAINT_VIOLATION',
      } satisfies Partial<AdmissionError>);
      const next = admissionFixture();
      const stale: AdmissionCommand = {
        ...command,
        manifestKey: next.manifest.manifestKey,
        manifestId: next.manifest.id,
        outboxId: next.outbox.id,
        messageId: next.outbox.messageId,
        outboxIdempotencyKey: next.outbox.idempotencyKey,
        newRawObjects: [
          { ...command.newRawObjects[0]!, id: next.raw.id, objectRef: next.raw.objectRef },
        ],
        events: [
          {
            ...command.events[0]!,
            id: next.inbox.id,
            recordId: next.inbox.recordId,
            idempotencyKey: next.inbox.idempotencyKey,
            rawReferenceId: next.raw.id,
            quarantine: { id: next.quarantine.id, errorCode: next.quarantine.errorCode },
          },
        ],
      };
      await expect(commitAdmission(client, stale)).rejects.toMatchObject({
        code: 'PERSISTENCE_CONCURRENCY_CONFLICT',
      } satisfies Partial<AdmissionError>);
      expect(await client.ingestionManifest.count({ where: { sourceId: fixture.source.id } })).toBe(
        1,
      );
      expect(await client.eventInbox.count({ where: { sourceId: fixture.source.id } })).toBe(1);
      expect(
        await client.sourceCheckpoint.findUnique({
          where: {
            sourceId_dataset: {
              sourceId: fixture.source.id,
              dataset: fixture.source.dataset,
            },
          },
        }),
      ).toMatchObject({ revision: 1n });
    } finally {
      await closeDatabaseClient(client);
    }
  });

  it('rechaza un comando cuyo dataset no coincide con el dataset registrado de la Source', async () => {
    const client = createDatabaseClient({ connectionString: temporary!.url, maxConnections: 4 });
    try {
      const { fixture, command } = admissionCommandFixture();
      await client.source.create({ data: fixture.source });
      const crossDataset: AdmissionCommand = { ...command, dataset: 'otro-dataset' };
      await expect(commitAdmission(client, crossDataset)).rejects.toMatchObject({
        code: 'PERSISTENCE_NOT_FOUND',
      } satisfies Partial<AdmissionError>);
      expect(await client.ingestionManifest.count()).toBe(0);
      expect(await client.eventInbox.count()).toBe(0);
      expect(await client.rawEventReference.count()).toBe(0);
    } finally {
      await closeDatabaseClient(client);
    }
  });

  it('rechaza un evento cuyo rawReferenceId pertenece a otra Source (aislamiento de tenant)', async () => {
    const client = createDatabaseClient({ connectionString: temporary!.url, maxConnections: 4 });
    try {
      const own = admissionCommandFixture();
      const foreign = admissionCommandFixture();
      await client.source.create({ data: own.fixture.source });
      await client.source.create({ data: foreign.fixture.source });
      // El raw referenciado por el evento pertenece a `foreign`, no a `own.command.sourceId`.
      await client.rawEventReference.create({
        data: {
          id: foreign.command.newRawObjects[0]!.id,
          sourceId: foreign.fixture.source.id,
          manifestId: foreign.fixture.manifest.id,
          objectRef: foreign.command.newRawObjects[0]!.objectRef,
          sha256: foreign.command.newRawObjects[0]!.sha256,
          mediaType: foreign.command.newRawObjects[0]!.mediaType,
          sizeBytes: foreign.command.newRawObjects[0]!.sizeBytes,
          receivedAt: foreign.command.newRawObjects[0]!.receivedAt,
        },
      });
      await client.ingestionManifest.create({
        data: {
          id: foreign.fixture.manifest.id,
          sourceId: foreign.fixture.source.id,
          dataset: foreign.fixture.source.dataset,
          manifestKey: foreign.fixture.manifest.manifestKey,
          admissionDigest: 'c'.repeat(64),
          receivedAt: foreign.fixture.manifest.receivedAt,
          durableAt: foreign.fixture.manifest.receivedAt,
          eventCount: 0,
          acceptedCount: 0,
          duplicateCount: 0,
          quarantinedCount: 0,
          updatedAt: foreign.fixture.manifest.receivedAt,
        },
      });
      const crossTenant: AdmissionCommand = {
        ...own.command,
        newRawObjects: [],
        events: [
          { ...own.command.events[0]!, rawReferenceId: foreign.command.newRawObjects[0]!.id },
        ],
      };
      await expect(commitAdmission(client, crossTenant)).rejects.toMatchObject({
        code: 'PERSISTENCE_NOT_FOUND',
      } satisfies Partial<AdmissionError>);
      expect(
        await client.ingestionManifest.count({ where: { sourceId: own.fixture.source.id } }),
      ).toBe(0);
      expect(await client.eventInbox.count({ where: { sourceId: own.fixture.source.id } })).toBe(0);
    } finally {
      await closeDatabaseClient(client);
    }
  });
});
