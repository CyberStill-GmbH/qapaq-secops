import type {
  ManagedSecretMetadata,
  SecretAuditEvent,
  SecretOperationReceipt,
  SecretReconciliationRecord,
  SecretVersionMetadata,
} from './secret-lifecycle.types.js';

export type SecretMetadataStoreErrorCode =
  'STORE_DUPLICATE' | 'STORE_NOT_FOUND' | 'STORE_CONFLICT' | 'STORE_UNAVAILABLE';

export class SecretMetadataStoreError extends Error {
  public constructor(public readonly code: SecretMetadataStoreErrorCode) {
    super(code);
    this.name = 'SecretMetadataStoreError';
  }
}

/** All mutations atomically persist metadata, operation receipt and safe audit event. */
export interface SecretMetadataStore {
  findById(id: string): Promise<ManagedSecretMetadata | undefined>;
  findByLogicalName(logicalName: string): Promise<ManagedSecretMetadata | undefined>;
  findOperation(operationId: string): Promise<SecretOperationReceipt | undefined>;
  create(input: {
    readonly secret: ManagedSecretMetadata;
    readonly receipt: SecretOperationReceipt;
    readonly audit: SecretAuditEvent;
  }): Promise<void>;
  rotate(input: {
    readonly secretId: string;
    readonly expectedRevision: number;
    readonly version: SecretVersionMetadata;
    readonly rotatedAt: string;
    readonly rotatedBy: string;
    readonly receipt: SecretOperationReceipt;
    readonly audit: SecretAuditEvent;
  }): Promise<void>;
  revoke(input: {
    readonly secretId: string;
    readonly expectedRevision: number;
    readonly revokedAt: string;
    readonly revokedBy: string;
    readonly receipt: SecretOperationReceipt;
    readonly audit: SecretAuditEvent;
  }): Promise<void>;
  recordIdempotent(input: {
    readonly receipt: SecretOperationReceipt;
    readonly audit: SecretAuditEvent;
  }): Promise<void>;
  recordFailedAttempt(audit: SecretAuditEvent): Promise<void>;
  recordReconciliation(input: {
    readonly record: SecretReconciliationRecord;
    readonly audit: SecretAuditEvent;
  }): Promise<void>;
}
