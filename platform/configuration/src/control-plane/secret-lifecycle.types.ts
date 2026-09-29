import type { SecretReference } from '../secrets/secret-reference.js';

export const SECRET_CAPABILITIES = Object.freeze({
  create: 'secret:create',
  rotate: 'secret:rotate',
  revoke: 'secret:revoke',
  readMetadata: 'secret:read_metadata',
} as const);

export type SecretCapability = (typeof SECRET_CAPABILITIES)[keyof typeof SECRET_CAPABILITIES];
export type SecretOperation = 'create' | 'rotate' | 'revoke';
export type SecretStatus = 'ACTIVE' | 'REVOKED' | 'RECONCILIATION_REQUIRED';
export type SecretVersionStatus = 'ACTIVE' | 'SUPERSEDED' | 'REVOKED' | 'RECONCILIATION_REQUIRED';

export interface SecretActor {
  readonly id: string;
  readonly capabilities: readonly SecretCapability[];
}

export interface SecretVersionMetadata {
  readonly version: number;
  readonly providerRef: SecretReference;
  readonly providerVersion: string;
  readonly fingerprint: string;
  readonly status: SecretVersionStatus;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAt?: string;
  readonly supersededAt?: string;
  readonly revokedAt?: string;
  readonly revokedBy?: string;
}

export interface ManagedSecretMetadata {
  readonly id: string;
  readonly logicalName: string;
  readonly purpose: string;
  readonly owner: string;
  readonly classification: string;
  readonly provider: string;
  readonly status: SecretStatus;
  readonly currentVersion: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly rotatedAt?: string;
  readonly rotatedBy?: string;
  readonly revokedAt?: string;
  readonly revokedBy?: string;
  readonly versions: readonly SecretVersionMetadata[];
}

export type SecretMetadataResponse = Omit<ManagedSecretMetadata, 'versions'> & {
  readonly current: SecretVersionMetadata;
};

export interface SecretAuditEvent {
  readonly actorId: string;
  readonly action: `secret.${SecretOperation}`;
  readonly targetSecretId: string;
  readonly provider: string;
  readonly providerRef?: SecretReference;
  readonly version?: number;
  readonly fingerprint?: string;
  readonly timestamp: string;
  readonly result: 'success' | 'failure' | 'reconciliation_required';
  readonly correlationId: string;
  readonly failureClass?: string;
}

export interface SecretOperationReceipt {
  readonly operationId: string;
  readonly operation: SecretOperation;
  readonly secretId: string;
  readonly version: number;
  readonly completedAt: string;
}

export interface SecretReconciliationRecord {
  readonly operationId: string;
  readonly operation: SecretOperation;
  readonly secretId: string;
  readonly logicalName: string;
  readonly provider: string;
  readonly providerRef?: SecretReference;
  readonly fingerprint?: string;
  readonly intendedVersion: number;
  readonly reason:
    'PROVIDER_STATE_UNKNOWN' | 'METADATA_PERSISTENCE_FAILED' | 'CONCURRENT_STATE_CHANGE';
  readonly actorId: string;
  readonly correlationId: string;
  readonly createdAt: string;
}

export interface SecretTelemetryEvent {
  readonly phase: 'operation' | 'provider';
  readonly operation: SecretOperation;
  readonly provider: string;
  readonly result: 'success' | 'failure' | 'reconciliation_required';
  readonly failureClass?: string;
  readonly durationMs: number;
}

export interface SecretTelemetry {
  record(event: SecretTelemetryEvent): void;
}

export interface SecretSafeLogger {
  write(entry: {
    readonly operation: `secret.${SecretOperation}`;
    readonly secretId: string;
    readonly version?: number;
    readonly provider: string;
    readonly result: 'success' | 'failure' | 'reconciliation_required';
    readonly failureClass?: string;
    readonly correlationId: string;
  }): void;
}

export type SecretControlPlaneErrorCode =
  | 'SECRET_REQUEST_INVALID'
  | 'SECRET_UNAUTHENTICATED'
  | 'SECRET_FORBIDDEN'
  | 'SECRET_DUPLICATE'
  | 'SECRET_NOT_FOUND'
  | 'SECRET_TRANSITION_INVALID'
  | 'SECRET_PROVIDER_UNAVAILABLE'
  | 'SECRET_PROVIDER_TIMEOUT'
  | 'SECRET_PROVIDER_REJECTED'
  | 'SECRET_ROTATION_CONFLICT'
  | 'SECRET_REVOCATION_FAILED'
  | 'SECRET_PERSISTENCE_FAILED'
  | 'SECRET_EXTERNAL_STATE_INCONSISTENT';

export class SecretControlPlaneError extends Error {
  public constructor(
    public readonly code: SecretControlPlaneErrorCode,
    public readonly operation: SecretOperation,
    public readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'SecretControlPlaneError';
  }
}

const MAX_SECRET_BYTES = 65_536;

/** One-shot, non-serializable input. Bytes are zeroed immediately after use. */
export class SecretMaterial {
  #bytes: Uint8Array | undefined;

  public constructor(value: string | Uint8Array) {
    const bytes =
      typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_SECRET_BYTES) {
      bytes.fill(0);
      throw new SecretControlPlaneError('SECRET_REQUEST_INVALID', 'create', false);
    }
    this.#bytes = bytes;
    Object.seal(this);
  }

  public async consume<T>(consumer: (bytes: Uint8Array) => Promise<T>): Promise<T> {
    const bytes = this.#bytes;
    if (!bytes) throw new SecretControlPlaneError('SECRET_REQUEST_INVALID', 'create', false);
    this.#bytes = undefined;
    try {
      return await consumer(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  /** Clears material that was rejected before it could be consumed by a provider. */
  public destroy(): void {
    this.#bytes?.fill(0);
    this.#bytes = undefined;
  }

  public toJSON(): string {
    return '[REDACTED]';
  }

  public toString(): string {
    return '[REDACTED]';
  }
}

interface SecretMutationBase {
  readonly operationId: string;
  readonly actor: SecretActor;
  readonly correlationId: string;
}

export interface CreateSecretCommand extends SecretMutationBase {
  readonly id: string;
  readonly logicalName: string;
  readonly purpose: string;
  readonly owner: string;
  readonly classification: string;
  readonly material: SecretMaterial;
  readonly expiresAt?: string;
  readonly signal?: AbortSignal;
}

export interface RotateSecretCommand extends SecretMutationBase {
  readonly id: string;
  readonly material: SecretMaterial;
  readonly expiresAt?: string;
  readonly signal?: AbortSignal;
}

export interface RevokeSecretCommand extends SecretMutationBase {
  readonly id: string;
  readonly signal?: AbortSignal;
}

export interface ReadSecretMetadataQuery {
  readonly id: string;
  readonly actor: SecretActor;
}
