import { randomBytes } from 'node:crypto';
import {
  SecretMetadataStoreError,
  type ManagedSecretMetadata,
  type SecretAuditEvent,
  type SecretMetadataStore,
  type SecretOperationReceipt,
  type SecretReconciliationRecord,
  type SecretReference,
  type SecretVersionMetadata,
} from '@qapaq/configuration';
import { Prisma, type PrismaClient } from '../generated/client/client.js';
import { runDatabaseTransaction } from './transaction.js';

type SecretWithVersions = Prisma.ManagedSecretGetPayload<{ include: { versions: true } }>;

/** Generates RFC 9562 UUIDv7 identifiers without database-side defaults. */
export function createUuidV7(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff)
    throw new RangeError('UUID_V7_TIMESTAMP_INVALID');
  const bytes = randomBytes(16);
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mapVersion(version: SecretWithVersions['versions'][number]): SecretVersionMetadata {
  return {
    version: version.version,
    providerRef: version.providerRef as SecretReference,
    providerVersion: version.providerVersion,
    fingerprint: version.fingerprint,
    status: version.status as SecretVersionMetadata['status'],
    createdAt: version.createdAt.toISOString(),
    createdBy: version.createdBy,
    ...(version.expiresAt ? { expiresAt: version.expiresAt.toISOString() } : {}),
    ...(version.supersededAt ? { supersededAt: version.supersededAt.toISOString() } : {}),
    ...(version.revokedAt ? { revokedAt: version.revokedAt.toISOString() } : {}),
    ...(version.revokedBy ? { revokedBy: version.revokedBy } : {}),
  };
}

function mapSecret(secret: SecretWithVersions): ManagedSecretMetadata {
  return {
    id: secret.id,
    logicalName: secret.logicalName,
    purpose: secret.purpose,
    owner: secret.owner,
    classification: secret.classification,
    provider: secret.provider,
    status: secret.status as ManagedSecretMetadata['status'],
    currentVersion: secret.currentVersion,
    revision: secret.revision,
    createdAt: secret.createdAt.toISOString(),
    createdBy: secret.createdBy,
    updatedAt: secret.updatedAt.toISOString(),
    ...(secret.rotatedAt ? { rotatedAt: secret.rotatedAt.toISOString() } : {}),
    ...(secret.rotatedBy ? { rotatedBy: secret.rotatedBy } : {}),
    ...(secret.revokedAt ? { revokedAt: secret.revokedAt.toISOString() } : {}),
    ...(secret.revokedBy ? { revokedBy: secret.revokedBy } : {}),
    versions: secret.versions.map(mapVersion).sort((left, right) => left.version - right.version),
  };
}

function operationData(receipt: SecretOperationReceipt) {
  return {
    operationId: receipt.operationId,
    secretId: receipt.secretId,
    operation: receipt.operation,
    version: receipt.version,
    completedAt: new Date(receipt.completedAt),
  };
}

function auditData(audit: SecretAuditEvent, id: string) {
  return {
    id,
    secretId: audit.targetSecretId,
    actorId: audit.actorId,
    action: audit.action,
    provider: audit.provider,
    ...(audit.providerRef ? { providerRef: audit.providerRef } : {}),
    ...(audit.version === undefined ? {} : { version: audit.version }),
    ...(audit.fingerprint ? { fingerprint: audit.fingerprint } : {}),
    occurredAt: new Date(audit.timestamp),
    result: audit.result,
    correlationId: audit.correlationId,
    ...(audit.failureClass ? { failureClass: audit.failureClass } : {}),
  };
}

function mappedStoreError(error: unknown): SecretMetadataStoreError {
  if (error instanceof SecretMetadataStoreError) return error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') return new SecretMetadataStoreError('STORE_DUPLICATE');
    if (error.code === 'P2025') return new SecretMetadataStoreError('STORE_NOT_FOUND');
    if (error.code === 'P2034') return new SecretMetadataStoreError('STORE_CONFLICT');
  }
  return new SecretMetadataStoreError('STORE_UNAVAILABLE');
}

/** PostgreSQL adapter. Every successful mutation commits metadata, receipt and audit atomically. */
export class PrismaSecretMetadataStore implements SecretMetadataStore {
  public constructor(
    private readonly client: PrismaClient,
    private readonly idFactory: () => string = createUuidV7,
  ) {}

  public async findById(id: string): Promise<ManagedSecretMetadata | undefined> {
    try {
      const secret = await this.client.managedSecret.findUnique({
        where: { id },
        include: { versions: true },
      });
      return secret ? mapSecret(secret) : undefined;
    } catch (error) {
      throw mappedStoreError(error);
    }
  }

  public async findByLogicalName(logicalName: string): Promise<ManagedSecretMetadata | undefined> {
    try {
      const secret = await this.client.managedSecret.findUnique({
        where: { logicalName },
        include: { versions: true },
      });
      return secret ? mapSecret(secret) : undefined;
    } catch (error) {
      throw mappedStoreError(error);
    }
  }

  public async findOperation(operationId: string): Promise<SecretOperationReceipt | undefined> {
    try {
      const receipt = await this.client.secretLifecycleOperation.findUnique({
        where: { operationId },
      });
      return receipt
        ? {
            operationId: receipt.operationId,
            operation: receipt.operation as SecretOperationReceipt['operation'],
            secretId: receipt.secretId,
            version: receipt.version,
            completedAt: receipt.completedAt.toISOString(),
          }
        : undefined;
    } catch (error) {
      throw mappedStoreError(error);
    }
  }

  public async create(input: Parameters<SecretMetadataStore['create']>[0]): Promise<void> {
    try {
      await runDatabaseTransaction(this.client, async (tx) => {
        const first = input.secret.versions[0];
        if (!first) throw new SecretMetadataStoreError('STORE_UNAVAILABLE');
        await tx.managedSecret.create({
          data: {
            id: input.secret.id,
            logicalName: input.secret.logicalName,
            purpose: input.secret.purpose,
            owner: input.secret.owner,
            classification: input.secret.classification,
            provider: input.secret.provider,
            status: input.secret.status,
            currentVersion: input.secret.currentVersion,
            revision: input.secret.revision,
            createdAt: new Date(input.secret.createdAt),
            createdBy: input.secret.createdBy,
            updatedAt: new Date(input.secret.updatedAt),
            versions: {
              create: {
                version: first.version,
                providerRef: first.providerRef,
                providerVersion: first.providerVersion,
                fingerprint: first.fingerprint,
                status: first.status,
                createdAt: new Date(first.createdAt),
                createdBy: first.createdBy,
                ...(first.expiresAt ? { expiresAt: new Date(first.expiresAt) } : {}),
              },
            },
          },
        });
        await tx.secretLifecycleOperation.create({ data: operationData(input.receipt) });
        await tx.secretLifecycleAudit.create({ data: auditData(input.audit, this.idFactory()) });
      });
    } catch (error) {
      throw mappedStoreError(error);
    }
  }

  public async rotate(input: Parameters<SecretMetadataStore['rotate']>[0]): Promise<void> {
    try {
      await runDatabaseTransaction(this.client, async (tx) => {
        const changed = await tx.managedSecret.updateMany({
          where: {
            id: input.secretId,
            status: 'ACTIVE',
            revision: input.expectedRevision,
            currentVersion: input.version.version - 1,
          },
          data: {
            currentVersion: input.version.version,
            revision: { increment: 1 },
            updatedAt: new Date(input.rotatedAt),
            rotatedAt: new Date(input.rotatedAt),
            rotatedBy: input.rotatedBy,
          },
        });
        if (changed.count !== 1) throw new SecretMetadataStoreError('STORE_CONFLICT');
        await tx.secretVersion.updateMany({
          where: { secretId: input.secretId, status: 'ACTIVE' },
          data: { status: 'SUPERSEDED', supersededAt: new Date(input.rotatedAt) },
        });
        await tx.secretVersion.create({
          data: {
            secretId: input.secretId,
            version: input.version.version,
            providerRef: input.version.providerRef,
            providerVersion: input.version.providerVersion,
            fingerprint: input.version.fingerprint,
            status: input.version.status,
            createdAt: new Date(input.version.createdAt),
            createdBy: input.version.createdBy,
            ...(input.version.expiresAt ? { expiresAt: new Date(input.version.expiresAt) } : {}),
          },
        });
        await tx.secretLifecycleOperation.create({ data: operationData(input.receipt) });
        await tx.secretLifecycleAudit.create({ data: auditData(input.audit, this.idFactory()) });
      });
    } catch (error) {
      throw mappedStoreError(error);
    }
  }

  public async revoke(input: Parameters<SecretMetadataStore['revoke']>[0]): Promise<void> {
    try {
      await runDatabaseTransaction(this.client, async (tx) => {
        const secret = await tx.managedSecret.findUnique({ where: { id: input.secretId } });
        if (!secret) throw new SecretMetadataStoreError('STORE_NOT_FOUND');
        const changed = await tx.managedSecret.updateMany({
          where: { id: input.secretId, status: 'ACTIVE', revision: input.expectedRevision },
          data: {
            status: 'REVOKED',
            revision: { increment: 1 },
            updatedAt: new Date(input.revokedAt),
            revokedAt: new Date(input.revokedAt),
            revokedBy: input.revokedBy,
          },
        });
        if (changed.count !== 1) throw new SecretMetadataStoreError('STORE_CONFLICT');
        await tx.secretVersion.update({
          where: {
            secretId_version: { secretId: input.secretId, version: secret.currentVersion },
          },
          data: {
            status: 'REVOKED',
            revokedAt: new Date(input.revokedAt),
            revokedBy: input.revokedBy,
          },
        });
        await tx.secretLifecycleOperation.create({ data: operationData(input.receipt) });
        await tx.secretLifecycleAudit.create({ data: auditData(input.audit, this.idFactory()) });
      });
    } catch (error) {
      throw mappedStoreError(error);
    }
  }

  public async recordIdempotent(
    input: Parameters<SecretMetadataStore['recordIdempotent']>[0],
  ): Promise<void> {
    try {
      await runDatabaseTransaction(this.client, async (tx) => {
        await tx.secretLifecycleOperation.create({ data: operationData(input.receipt) });
        await tx.secretLifecycleAudit.create({ data: auditData(input.audit, this.idFactory()) });
      });
    } catch (error) {
      throw mappedStoreError(error);
    }
  }

  public async recordFailedAttempt(audit: SecretAuditEvent): Promise<void> {
    try {
      await this.client.secretLifecycleAudit.create({ data: auditData(audit, this.idFactory()) });
    } catch (error) {
      throw mappedStoreError(error);
    }
  }

  public async recordReconciliation(
    input: Parameters<SecretMetadataStore['recordReconciliation']>[0],
  ): Promise<void> {
    try {
      await runDatabaseTransaction(this.client, async (tx) => {
        const record: SecretReconciliationRecord = input.record;
        await tx.secretReconciliation.create({
          data: {
            id: this.idFactory(),
            operationId: record.operationId,
            secretId: record.secretId,
            logicalName: record.logicalName,
            operation: record.operation,
            provider: record.provider,
            ...(record.providerRef ? { providerRef: record.providerRef } : {}),
            ...(record.fingerprint ? { fingerprint: record.fingerprint } : {}),
            intendedVersion: record.intendedVersion,
            reason: record.reason,
            actorId: record.actorId,
            correlationId: record.correlationId,
            createdAt: new Date(record.createdAt),
          },
        });
        await tx.secretLifecycleAudit.create({ data: auditData(input.audit, this.idFactory()) });
      });
    } catch (error) {
      throw mappedStoreError(error);
    }
  }
}
