import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HmacSha256SecretFingerprinter,
  SECRET_CAPABILITIES,
  SecretControlPlane,
  SecretControlPlaneError,
  SecretLifecycleProviderError,
  SecretMaterial,
  SecretMetadataStoreError,
  type ManagedSecretMetadata,
  type ProviderRevocation,
  type ProviderSecretVersion,
  type SecretAuditEvent,
  type SecretLifecycleProvider,
  type SecretMetadataStore,
  type SecretOperationReceipt,
  type SecretReconciliationRecord,
} from '../src/index.js';
import { defineSecretLifecycleProviderContract } from '../src/testing/secret-lifecycle-provider.contract.js';

const ID = '01890f47-7abc-7def-8abc-0123456789ab';
const ACTOR = {
  id: 'platform-admin-1',
  capabilities: Object.values(SECRET_CAPABILITIES),
} as const;

class FakeLifecycleProvider implements SecretLifecycleProvider {
  public readonly providerType = 'test-only';
  public calls = { create: 0, rotate: 0, revoke: 0 };
  public failure: unknown;
  readonly #operations = new Map<string, ProviderSecretVersion | ProviderRevocation>();
  #version = 0;
  #rotationWaiters: Array<() => void> = [];
  public synchronizeRotations = false;

  public async create(input: Parameters<SecretLifecycleProvider['create']>[0]) {
    this.calls.create += 1;
    if (this.failure) throw this.failure;
    const replay = this.#operations.get(input.operationId) as ProviderSecretVersion | undefined;
    if (replay) return replay;
    const result = this.#versionResult(input.secretId);
    this.#operations.set(input.operationId, result);
    return result;
  }

  public async rotate(input: Parameters<SecretLifecycleProvider['rotate']>[0]) {
    this.calls.rotate += 1;
    if (this.failure) throw this.failure;
    if (this.synchronizeRotations) {
      await new Promise<void>((resolveWaiter) => {
        this.#rotationWaiters.push(resolveWaiter);
        if (this.#rotationWaiters.length === 2) {
          for (const release of this.#rotationWaiters.splice(0)) release();
        }
      });
    }
    const replay = this.#operations.get(input.operationId) as ProviderSecretVersion | undefined;
    if (replay) return replay;
    const result = this.#versionResult(input.secretId);
    this.#operations.set(input.operationId, result);
    return result;
  }

  public async revoke(input: Parameters<SecretLifecycleProvider['revoke']>[0]) {
    this.calls.revoke += 1;
    if (this.failure) throw this.failure;
    const replay = this.#operations.get(input.operationId) as ProviderRevocation | undefined;
    if (replay) return replay;
    const result = { providerRef: input.providerRef, revoked: true as const };
    this.#operations.set(input.operationId, result);
    return result;
  }

  #versionResult(secretId: string): ProviderSecretVersion {
    this.#version += 1;
    return {
      providerRef:
        `secret://test/${secretId}/v${this.#version}` as ProviderSecretVersion['providerRef'],
      providerVersion: String(this.#version),
    };
  }
}

class MemoryMetadataStore implements SecretMetadataStore {
  public secrets = new Map<string, ManagedSecretMetadata>();
  public operations = new Map<string, SecretOperationReceipt>();
  public audits: SecretAuditEvent[] = [];
  public reconciliations: SecretReconciliationRecord[] = [];
  public failNextMutation = false;

  public async findById(id: string) {
    return this.secrets.get(id);
  }
  public async findByLogicalName(name: string) {
    return [...this.secrets.values()].find((secret) => secret.logicalName === name);
  }
  public async findOperation(id: string) {
    return this.operations.get(id);
  }
  public async create(input: Parameters<SecretMetadataStore['create']>[0]) {
    this.#maybeFail();
    if (
      this.secrets.has(input.secret.id) ||
      (await this.findByLogicalName(input.secret.logicalName))
    )
      throw new SecretMetadataStoreError('STORE_DUPLICATE');
    this.secrets.set(input.secret.id, structuredClone(input.secret));
    this.operations.set(input.receipt.operationId, structuredClone(input.receipt));
    this.audits.push(structuredClone(input.audit));
  }
  public async rotate(input: Parameters<SecretMetadataStore['rotate']>[0]) {
    this.#maybeFail();
    const secret = this.secrets.get(input.secretId);
    if (!secret) throw new SecretMetadataStoreError('STORE_NOT_FOUND');
    if (secret.revision !== input.expectedRevision)
      throw new SecretMetadataStoreError('STORE_CONFLICT');
    const versions = secret.versions.map((version) =>
      version.status === 'ACTIVE'
        ? { ...version, status: 'SUPERSEDED' as const, supersededAt: input.rotatedAt }
        : version,
    );
    this.secrets.set(input.secretId, {
      ...secret,
      currentVersion: input.version.version,
      revision: secret.revision + 1,
      updatedAt: input.rotatedAt,
      rotatedAt: input.rotatedAt,
      rotatedBy: input.rotatedBy,
      versions: [...versions, structuredClone(input.version)],
    });
    this.operations.set(input.receipt.operationId, structuredClone(input.receipt));
    this.audits.push(structuredClone(input.audit));
  }
  public async revoke(input: Parameters<SecretMetadataStore['revoke']>[0]) {
    this.#maybeFail();
    const secret = this.secrets.get(input.secretId);
    if (!secret) throw new SecretMetadataStoreError('STORE_NOT_FOUND');
    if (secret.revision !== input.expectedRevision)
      throw new SecretMetadataStoreError('STORE_CONFLICT');
    this.secrets.set(input.secretId, {
      ...secret,
      status: 'REVOKED',
      revision: secret.revision + 1,
      updatedAt: input.revokedAt,
      revokedAt: input.revokedAt,
      revokedBy: input.revokedBy,
      versions: secret.versions.map((version) =>
        version.version === secret.currentVersion
          ? {
              ...version,
              status: 'REVOKED' as const,
              revokedAt: input.revokedAt,
              revokedBy: input.revokedBy,
            }
          : version,
      ),
    });
    this.operations.set(input.receipt.operationId, structuredClone(input.receipt));
    this.audits.push(structuredClone(input.audit));
  }
  public async recordIdempotent(input: Parameters<SecretMetadataStore['recordIdempotent']>[0]) {
    this.#maybeFail();
    this.operations.set(input.receipt.operationId, structuredClone(input.receipt));
    this.audits.push(structuredClone(input.audit));
  }
  public async recordFailedAttempt(audit: SecretAuditEvent) {
    this.audits.push(structuredClone(audit));
  }
  public async recordReconciliation(
    input: Parameters<SecretMetadataStore['recordReconciliation']>[0],
  ) {
    this.reconciliations.push(structuredClone(input.record));
    this.audits.push(structuredClone(input.audit));
  }
  #maybeFail() {
    if (!this.failNextMutation) return;
    this.failNextMutation = false;
    throw new SecretMetadataStoreError('STORE_UNAVAILABLE');
  }
}

function fixture() {
  const provider = new FakeLifecycleProvider();
  const store = new MemoryMetadataStore();
  const logs: unknown[] = [];
  const telemetry: unknown[] = [];
  let time = Date.parse('2026-09-28T12:00:00.000Z');
  const service = new SecretControlPlane({
    provider,
    store,
    fingerprinter: new HmacSha256SecretFingerprinter('c24-fingerprint-key-32-bytes-minimum'),
    logger: { write: (entry) => logs.push(structuredClone(entry)) },
    telemetry: { record: (entry) => telemetry.push(structuredClone(entry)) },
    now: () => time++,
  });
  const create = (material = new SecretMaterial('synthetic-secret')) => ({
    id: ID,
    logicalName: 'integrations/wazuh/gateway',
    purpose: 'Gateway authentication',
    owner: 'platform-security',
    classification: 'restricted',
    material,
    operationId: 'create-1',
    correlationId: 'correlation-1',
    actor: ACTOR,
  });
  return { provider, store, logs, telemetry, service, create };
}

describe('C-24 write-only secret control plane', () => {
  it('rejects an undersized keyed-fingerprint key', () => {
    expect(() => new HmacSha256SecretFingerprinter('too-short')).toThrow(
      'SECRET_FINGERPRINT_KEY_INVALID',
    );
  });

  it('creates metadata with a keyed fingerprint and no material in the response', async () => {
    const context = fixture();
    const result = await context.service.create(context.create());
    expect(result).toMatchObject({ status: 'ACTIVE', currentVersion: 1, revision: 1 });
    expect(result.current.fingerprint).toMatch(/^hmac-sha256:v1:[0-9a-f]{64}$/u);
    expect(result.current.providerRef).toMatch(/^secret:\/\/test\//u);
    expect(Object.keys(result.current)).not.toEqual(
      expect.arrayContaining(['secret', 'value', 'token', 'password']),
    );
    expect(context.telemetry).toMatchObject([
      { phase: 'provider', operation: 'create', provider: 'test-only', result: 'success' },
      { phase: 'operation', operation: 'create', provider: 'test-only', result: 'success' },
    ]);
    for (const event of context.telemetry)
      expect(Object.keys(event as object).sort()).toEqual(
        ['durationMs', 'operation', 'phase', 'provider', 'result'].sort(),
      );
  });

  it('rejects a duplicate logical name before sending material to the provider', async () => {
    const context = fixture();
    await context.service.create(context.create());
    await expect(
      context.service.create({
        ...context.create(new SecretMaterial('duplicate-secret')),
        id: '01890f47-7abc-7def-8abc-0123456789ac',
        operationId: 'create-duplicate',
      }),
    ).rejects.toMatchObject({ code: 'SECRET_DUPLICATE' });
    expect(context.provider.calls.create).toBe(1);
  });

  it('binds every idempotency key to the original secret and operation', async () => {
    const context = fixture();
    await context.service.create(context.create());
    await expect(
      context.service.create({
        ...context.create(new SecretMaterial('other-secret')),
        id: '01890f47-7abc-7def-8abc-0123456789ac',
        logicalName: 'integrations/other',
      }),
    ).rejects.toMatchObject({ code: 'SECRET_REQUEST_INVALID' });
    await expect(
      context.service.rotate({
        id: ID,
        material: new SecretMaterial('wrong-operation'),
        operationId: 'create-1',
        correlationId: 'correlation-wrong-operation',
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ code: 'SECRET_REQUEST_INVALID' });
    expect(context.provider.calls.create).toBe(1);
    expect(context.provider.calls.rotate).toBe(0);
  });

  it('rotates with immutable version history and idempotent operation receipts', async () => {
    const context = fixture();
    await context.service.create(context.create());
    const command = {
      id: ID,
      material: new SecretMaterial('rotated-secret'),
      operationId: 'rotate-1',
      correlationId: 'correlation-2',
      actor: ACTOR,
    };
    const first = await context.service.rotate(command);
    const repeated = await context.service.rotate({
      ...command,
      material: new SecretMaterial('ignored-retry'),
    });
    expect(first.currentVersion).toBe(2);
    expect(repeated).toEqual(first);
    expect(context.provider.calls.rotate).toBe(1);
    expect(context.store.secrets.get(ID)?.versions.map((version) => version.status)).toEqual([
      'SUPERSEDED',
      'ACTIVE',
    ]);
  });

  it('preserves the complete metadata history across multiple rotations', async () => {
    const context = fixture();
    await context.service.create(context.create());
    for (const sequence of [1, 2]) {
      await context.service.rotate({
        id: ID,
        material: new SecretMaterial(`rotation-${sequence}`),
        operationId: `rotate-${sequence}`,
        correlationId: `correlation-${sequence + 1}`,
        actor: ACTOR,
      });
    }
    const persisted = context.store.secrets.get(ID);
    expect(persisted).toMatchObject({ currentVersion: 3, revision: 3 });
    expect(persisted?.versions.map(({ version, status }) => ({ version, status }))).toEqual([
      { version: 1, status: 'SUPERSEDED' },
      { version: 2, status: 'SUPERSEDED' },
      { version: 3, status: 'ACTIVE' },
    ]);
  });

  it('revokes idempotently and never permits rotating a revoked secret', async () => {
    const context = fixture();
    await context.service.create(context.create());
    const first = await context.service.revoke({
      id: ID,
      operationId: 'revoke-1',
      correlationId: 'correlation-2',
      actor: ACTOR,
    });
    const repeated = await context.service.revoke({
      id: ID,
      operationId: 'revoke-2',
      correlationId: 'correlation-3',
      actor: ACTOR,
    });
    const replayed = await context.service.revoke({
      id: ID,
      operationId: 'revoke-2',
      correlationId: 'correlation-3',
      actor: ACTOR,
    });
    expect(first.status).toBe('REVOKED');
    expect(repeated.status).toBe('REVOKED');
    expect(replayed).toEqual(repeated);
    expect(context.provider.calls.revoke).toBe(1);
    await expect(
      context.service.rotate({
        id: ID,
        material: new SecretMaterial('forbidden'),
        operationId: 'rotate-after-revoke',
        correlationId: 'correlation-4',
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ code: 'SECRET_TRANSITION_INVALID' });
  });

  it('enforces explicit capabilities for mutations and metadata reads', async () => {
    const context = fixture();
    await expect(
      context.service.create({ ...context.create(), actor: { id: 'user-1', capabilities: [] } }),
    ).rejects.toMatchObject({ code: 'SECRET_FORBIDDEN' });
    await expect(
      context.service.create({ ...context.create(), actor: undefined as never }),
    ).rejects.toMatchObject({ code: 'SECRET_UNAUTHENTICATED' });
    await context.service.create(context.create());
    await expect(
      context.service.readMetadata({ id: ID, actor: { id: 'auditor-1', capabilities: [] } }),
    ).rejects.toMatchObject({ code: 'SECRET_FORBIDDEN' });
    await expect(
      context.service.readMetadata({
        id: ID,
        actor: { id: 'auditor-1', capabilities: [SECRET_CAPABILITIES.readMetadata] },
      }),
    ).resolves.toMatchObject({ id: ID, currentVersion: 1 });
  });

  it.each([
    ['PROVIDER_UNAVAILABLE', 'SECRET_PROVIDER_UNAVAILABLE'],
    ['PROVIDER_TIMEOUT', 'SECRET_PROVIDER_TIMEOUT'],
    ['PROVIDER_REJECTED', 'SECRET_PROVIDER_REJECTED'],
  ] as const)('maps %s without leaking provider details', async (providerCode, expected) => {
    const context = fixture();
    context.provider.failure = new SecretLifecycleProviderError(providerCode);
    await expect(context.service.create(context.create())).rejects.toMatchObject({
      code: expected,
    });
    expect(context.store.secrets.size).toBe(0);
    expect(context.store.audits).toHaveLength(providerCode === 'PROVIDER_TIMEOUT' ? 2 : 1);
  });

  it('records reconciliation when provider succeeds and metadata persistence fails', async () => {
    const context = fixture();
    context.store.failNextMutation = true;
    await expect(context.service.create(context.create())).rejects.toMatchObject({
      code: 'SECRET_EXTERNAL_STATE_INCONSISTENT',
    });
    expect(context.store.secrets.size).toBe(0);
    expect(context.store.reconciliations).toMatchObject([
      { operation: 'create', reason: 'METADATA_PERSISTENCE_FAILED', intendedVersion: 1 },
    ]);
  });

  it('resolves concurrent rotations with one persisted version and reconciliation for the loser', async () => {
    const context = fixture();
    await context.service.create(context.create());
    context.provider.synchronizeRotations = true;
    const results = await Promise.allSettled([
      context.service.rotate({
        id: ID,
        material: new SecretMaterial('rotation-a'),
        operationId: 'rotate-a',
        correlationId: 'corr-a',
        actor: ACTOR,
      }),
      context.service.rotate({
        id: ID,
        material: new SecretMaterial('rotation-b'),
        operationId: 'rotate-b',
        correlationId: 'corr-b',
        actor: ACTOR,
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(context.store.secrets.get(ID)?.versions).toHaveLength(2);
    expect(context.store.reconciliations).toHaveLength(1);
  });

  it('keeps a consistent state during a concurrent rotate/revoke race', async () => {
    const context = fixture();
    await context.service.create(context.create());
    const results = await Promise.allSettled([
      context.service.rotate({
        id: ID,
        material: new SecretMaterial('rotation-race'),
        operationId: 'rotate-race',
        correlationId: 'corr-r',
        actor: ACTOR,
      }),
      context.service.revoke({
        id: ID,
        operationId: 'revoke-race',
        correlationId: 'corr-v',
        actor: ACTOR,
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(context.store.secrets.get(ID)?.status).toMatch(/^(?:ACTIVE|REVOKED)$/u);
    expect(context.store.reconciliations).toHaveLength(1);
  });

  it('proves Secret plaintext persistence: NONE across all C-24 surfaces', async () => {
    const canary = `C24_TEST_SECRET_CANARY_${randomUUID()}`;
    const context = fixture();
    const input = new SecretMaterial(canary);
    expect(JSON.stringify(input)).not.toContain(canary);
    expect(String(input)).toBe('[REDACTED]');
    const result = await context.service.create(context.create(input));
    const surfaces = {
      database: [...context.store.secrets.values()],
      audit: context.store.audits,
      logs: context.logs,
      responses: result,
      events: [],
      reconciliation: context.store.reconciliations,
      telemetry: context.telemetry,
    };
    expect(JSON.stringify(surfaces)).not.toContain(canary);
  });

  it('sanitizes unknown provider exceptions containing the secret canary', async () => {
    const canary = `C24_TEST_SECRET_CANARY_${randomUUID()}`;
    const context = fixture();
    context.provider.failure = new Error(`provider failed with ${canary}`);
    let error: unknown;
    try {
      await context.service.create(context.create(new SecretMaterial(canary)));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SecretControlPlaneError);
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(JSON.stringify(context.store.audits)).not.toContain(canary);
    expect(JSON.stringify(context.logs)).not.toContain(canary);
  });

  it('never reflects invalid request fields into audit, logs or typed errors', async () => {
    const canary = `C24_TEST_SECRET_CANARY_${randomUUID()}`;
    const context = fixture();
    const material = new SecretMaterial(canary);
    await expect(
      context.service.create({
        ...context.create(material),
        correlationId: `${canary}\n`,
      }),
    ).rejects.toMatchObject({ code: 'SECRET_REQUEST_INVALID' });
    expect(JSON.stringify(context.store.audits)).not.toContain(canary);
    expect(JSON.stringify(context.logs)).not.toContain(canary);
    expect(context.provider.calls.create).toBe(0);
    await expect(material.consume(async () => undefined)).rejects.toMatchObject({
      code: 'SECRET_REQUEST_INVALID',
    });
  });
});

describe('SecretLifecycleProvider portable contract', () => {
  defineSecretLifecycleProviderContract({
    createProvider: () => new FakeLifecycleProvider(),
    material: () => new TextEncoder().encode('contract-secret-material'),
  });
});

describe('C-24 negative API and persistence security', () => {
  const root = resolve(import.meta.dirname, '../../..');
  async function textTree(directory: string): Promise<string> {
    const entries = await readdir(directory, { withFileTypes: true });
    return (
      await Promise.all(
        entries.map(async (entry) => {
          const path = resolve(directory, entry.name);
          return entry.isDirectory()
            ? textTree(path)
            : /\.(?:ts|prisma|sql)$/u.test(entry.name)
              ? readFile(path, 'utf8')
              : '';
        }),
      )
    ).join('\n');
  }

  it('has no GET/export/read-value operation in the control-plane contract or API', async () => {
    const source = await textTree(resolve(root, 'platform/configuration/src/control-plane'));
    const api = await textTree(resolve(root, 'apps/api/src'));
    for (const content of [source, api]) {
      expect(content).not.toMatch(
        /getSecretValue|readSecretValue|exportSecret|downloadSecret|listSecretValues/iu,
      );
      expect(content).not.toMatch(
        /GET\s+[^\n]*(?:secret|credential)[^\n]*(?:value|plaintext|export)/iu,
      );
    }
  });

  it('allows only metadata columns in the C-24 Prisma models and migration', async () => {
    const schema = await readFile(resolve(root, 'platform/database/prisma/schema.prisma'), 'utf8');
    const migrations = await textTree(resolve(root, 'platform/database/prisma/migrations'));
    const prohibited =
      /secret_value|plaintext|credential_value|private_key|api_key|client_secret|password|\btoken\b/iu;
    expect(schema).not.toMatch(prohibited);
    expect(migrations).not.toMatch(prohibited);
  });
});
