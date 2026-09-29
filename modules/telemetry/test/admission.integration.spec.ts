import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabaseClient, commitAdmission, createDatabaseClient } from '@qapaq/database';
import { IntegrationEnvironment } from '@qapaq/testing';
import type { AdmissionCommand } from '@qapaq/database/admission-contract';
import { admitPage, TelemetryAdmissionError } from '../src/admission.js';
import { S3RawStore } from '../src/s3-raw-store.js';

const exec = promisify(execFile);
const environment = new IntegrationEnvironment({ profile: 'base', repositoryRoot: process.cwd() });
let db: ReturnType<typeof createDatabaseClient> | undefined;
let s3: S3Client | undefined;
let rawStore: S3RawStore | undefined;
const ids = {
  tenant: 'tenant-c11-test',
  source: '01996000-0000-7000-8000-000000000011',
  manifest: '01996000-0000-7000-8000-000000000012',
};

describe('C-11 con PostgreSQL + MinIO de C-06', () => {
  beforeAll(async () => {
    const preflight = await environment.preflight();
    if (preflight.status !== 'PASS')
      throw new Error(`C-06 preflight: ${JSON.stringify(preflight.checks)}`);
    const services = await environment.start();
    const postgres = services.postgres;
    const objectStorage = services.objectStorage;
    if (!postgres || !objectStorage)
      throw new Error('C-06 base debe proporcionar PostgreSQL y MinIO');
    const databaseRoot = new URL('../../../platform/database/', import.meta.url);
    await exec(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
      {
        cwd: databaseRoot,
        env: { ...process.env, DATABASE_URL: postgres.connectionString },
        shell: process.platform === 'win32',
      },
    );
    db = createDatabaseClient({ connectionString: postgres.connectionString, maxConnections: 4 });
    s3 = new S3Client({
      endpoint: objectStorage.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: objectStorage.accessKey,
        secretAccessKey: objectStorage.secretKey,
      },
      maxAttempts: 1,
    });
    await s3.send(new CreateBucketCommand({ Bucket: objectStorage.bucket }));
    rawStore = new S3RawStore({
      endpoint: objectStorage.endpoint,
      region: 'us-east-1',
      bucket: objectStorage.bucket,
      accessKeyId: objectStorage.accessKey,
      secretAccessKey: objectStorage.secretKey,
      maxAttempts: 1,
      allowInsecureLocalhost: true,
    });
    await db.source.create({
      data: {
        id: ids.source,
        tenantId: ids.tenant,
        provider: 'synthetic',
        product: 'test',
        dataset: 'alerts',
        instanceKey: 'c11-integration',
        status: 'planned',
        updatedAt: new Date(),
      },
    });
  }, 300_000);

  afterAll(async () => {
    rawStore?.close();
    s3?.destroy();
    if (db) await closeDatabaseClient(db);
    await environment.stop();
  });

  it('verifies raw storage before committing refs, manifest, outbox and checkpoint atomically', async () => {
    const receivedAt = new Date('2026-09-28T12:00:00.000Z');
    const page = {
      sourceId: ids.source,
      dataset: 'alerts',
      manifestKey: 'batch-1',
      manifestId: ids.manifest,
      receivedAt,
      expectedRevision: 0n,
      cursor: { from: null, to: 'cursor-1', version: '1' },
      records: [
        {
          sourceRecordId: 'provider-record-1',
          dataset: 'alerts',
          collectedAt: receivedAt.toISOString(),
          raw: { b: 2, a: 'evento sintético' },
        },
      ],
    };
    const result = await admitPage(page, rawStore!, {
      commit: (command) => commitAdmission(db!, command),
    });
    const replay = await admitPage(page, rawStore!, {
      commit: (command) => commitAdmission(db!, command),
    });
    expect(replay.receipt).toEqual(result.receipt);
    expect(result.receipt.checkpointRevision).toBe(1n);
    expect(await db!.ingestionManifest.count({ where: { id: ids.manifest } })).toBe(1);
    expect(await db!.rawEventReference.count({ where: { manifestId: ids.manifest } })).toBe(1);
    expect(await db!.eventInbox.count({ where: { manifestId: ids.manifest } })).toBe(1);
    expect(await db!.outboxMessage.count({ where: { aggregateId: ids.manifest } })).toBe(1);
    expect(
      await db!.sourceCheckpoint.findUnique({
        where: { sourceId_dataset: { sourceId: ids.source, dataset: 'alerts' } },
      }),
    ).toMatchObject({ cursor: 'cursor-1', revision: 1n });
  }, 60_000);

  it('leaves checkpoint unchanged when PostgreSQL admission fails after raw is durable', async () => {
    const request = {
      sourceId: ids.source,
      dataset: 'alerts',
      manifestKey: 'batch-fail',
      manifestId: '01996000-0000-7000-8000-000000000013',
      receivedAt: new Date('2026-09-28T12:01:00.000Z'),
      expectedRevision: 1n,
      cursor: { from: 'cursor-1', to: 'cursor-2', version: '1' },
      records: [
        {
          sourceRecordId: 'provider-record-2',
          dataset: 'alerts',
          collectedAt: '2026-09-28T12:01:00.000Z',
          raw: { event: 2 },
        },
      ],
    };
    const failingRepo = {
      async commit(_command: AdmissionCommand) {
        throw new Error('fault injected before DB commit');
      },
    };
    await expect(admitPage(request, rawStore!, failingRepo)).rejects.toMatchObject({
      code: 'DATABASE_ADMISSION_FAILED',
    } satisfies Partial<TelemetryAdmissionError>);
    expect(
      await db!.sourceCheckpoint.findUnique({
        where: { sourceId_dataset: { sourceId: ids.source, dataset: 'alerts' } },
      }),
    ).toMatchObject({ cursor: 'cursor-1', revision: 1n });
  }, 60_000);
});
