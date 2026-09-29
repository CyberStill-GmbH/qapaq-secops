import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  HmacSha256SecretFingerprinter,
  SECRET_CAPABILITIES,
  SecretControlPlane,
  SecretMaterial,
  type ProviderSecretVersion,
  type SecretLifecycleProvider,
} from '@qapaq/configuration';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabaseClient, createDatabaseClient } from '../src/client.js';
import { PrismaSecretMetadataStore } from '../src/secret-metadata.store.js';

const exec = promisify(execFile);
const databaseUrl = process.env['DATABASE_URL'];
const databaseRoot = fileURLToPath(new URL('../', import.meta.url));
const SECRET_ID = '01996000-0000-7000-8000-000000000024';
const ACTOR = {
  id: 'platform-admin-c24',
  capabilities: Object.values(SECRET_CAPABILITIES),
} as const;

class IntegrationLifecycleProvider implements SecretLifecycleProvider {
  public readonly providerType = 'integration-only';
  #version = 0;

  public async create(
    input: Parameters<SecretLifecycleProvider['create']>[0],
  ): Promise<ProviderSecretVersion> {
    return this.#next(input.secretId);
  }

  public async rotate(
    input: Parameters<SecretLifecycleProvider['rotate']>[0],
  ): Promise<ProviderSecretVersion> {
    return this.#next(input.secretId);
  }

  public async revoke(input: Parameters<SecretLifecycleProvider['revoke']>[0]) {
    return { providerRef: input.providerRef, revoked: true as const };
  }

  #next(secretId: string): ProviderSecretVersion {
    this.#version += 1;
    return {
      providerRef:
        `secret://integration/${secretId}/v${this.#version}` as ProviderSecretVersion['providerRef'],
      providerVersion: String(this.#version),
    };
  }
}

async function provisionDatabase() {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for C-24 PostgreSQL integration');
  const parsed = new URL(databaseUrl);
  const name = `qapaq_c24_${process.pid}_${Date.now()}`.toLowerCase();
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

describe.skipIf(!databaseUrl)('C-24 PostgreSQL metadata-only lifecycle', () => {
  let database: Awaited<ReturnType<typeof provisionDatabase>> | undefined;

  beforeAll(async () => {
    database = await provisionDatabase();
  });

  afterAll(async () => {
    if (!database) return;
    await database.admin.query(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`);
    await database.admin.end();
  });

  it('commits create/rotate/revoke metadata and audit without persisting the canary', async () => {
    const canary = 'C24_TEST_SECRET_CANARY_POSTGRES';
    const client = createDatabaseClient({ connectionString: database!.url, maxConnections: 4 });
    try {
      const controlPlane = new SecretControlPlane({
        provider: new IntegrationLifecycleProvider(),
        store: new PrismaSecretMetadataStore(client),
        fingerprinter: new HmacSha256SecretFingerprinter(
          'c24-integration-fingerprint-key-32-bytes',
        ),
      });
      await controlPlane.create({
        id: SECRET_ID,
        logicalName: 'integration/c24/postgres',
        purpose: 'C-24 integration proof',
        owner: 'platform-security',
        classification: 'restricted',
        material: new SecretMaterial(canary),
        operationId: 'c24-pg-create',
        correlationId: 'c24-pg-correlation-create',
        actor: ACTOR,
      });
      await controlPlane.rotate({
        id: SECRET_ID,
        material: new SecretMaterial(`${canary}_ROTATED`),
        operationId: 'c24-pg-rotate',
        correlationId: 'c24-pg-correlation-rotate',
        actor: ACTOR,
      });
      const result = await controlPlane.revoke({
        id: SECRET_ID,
        operationId: 'c24-pg-revoke',
        correlationId: 'c24-pg-correlation-revoke',
        actor: ACTOR,
      });
      expect(result).toMatchObject({ status: 'REVOKED', currentVersion: 2, revision: 3 });
      expect(await client.secretVersion.count({ where: { secretId: SECRET_ID } })).toBe(2);
      expect(await client.secretLifecycleOperation.count({ where: { secretId: SECRET_ID } })).toBe(
        3,
      );
      expect(await client.secretLifecycleAudit.count({ where: { secretId: SECRET_ID } })).toBe(3);

      const raw = new Client(database!.url);
      await raw.connect();
      const tables = [
        'managed_secrets',
        'secret_versions',
        'secret_lifecycle_operations',
        'secret_lifecycle_audit',
        'secret_reconciliations',
      ];
      const serialized: string[] = [];
      for (const table of tables) {
        const rows = await raw.query<{ payload: string }>(
          `SELECT row_to_json(record)::text AS payload FROM "${table}" AS record`,
        );
        serialized.push(...rows.rows.map(({ payload }) => payload));
      }
      await raw.end();
      expect(serialized.join('\n')).not.toContain(canary);
    } finally {
      await closeDatabaseClient(client);
    }
  });
});
