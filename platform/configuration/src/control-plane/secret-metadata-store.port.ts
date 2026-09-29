import type { SecretReference } from '../secrets/index.js';
import type { SecretAuditEvent } from './secret-audit.js';
import type { SecretFingerprint } from './secret-fingerprint.js';
import type { SecretLabels, SecretMetadata } from './secret-lifecycle.types.js';

export interface SecretRegistration {
  readonly id: string;
  readonly reference: SecretReference;
  readonly namespace: string;
  readonly purpose: string;
  readonly provider: string;
  readonly owner: string;
  readonly version: number;
  readonly fingerprint: SecretFingerprint;
  readonly labels: SecretLabels;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly requestId: string;
  readonly expiresAt?: Date;
}

export interface SecretRotation {
  readonly reference: SecretReference;
  readonly expectedRevision: bigint;
  readonly version: number;
  readonly fingerprint: SecretFingerprint;
  readonly rotatedAt: Date;
  readonly rotatedBy: string;
  readonly requestId: string;
  readonly expiresAt?: Date;
}

export interface SecretRevocation {
  readonly reference: SecretReference;
  readonly expectedRevision: bigint;
  readonly revokedAt: Date;
  readonly revokedBy: string;
  readonly requestId: string;
}

export type SecretStoreErrorCode =
  | 'STORE_DUPLICATE'
  | 'STORE_NOT_FOUND'
  | 'STORE_REVISION_CONFLICT'
  | 'STORE_AUDIT_UNAVAILABLE'
  | 'STORE_UNAVAILABLE';

export class SecretStoreError extends Error {
  public readonly code: SecretStoreErrorCode;

  public constructor(code: SecretStoreErrorCode) {
    super(code);
    this.name = 'SecretStoreError';
    this.code = code;
  }
}

/**
 * Persistencia de metadata. Cada mutación exige su evento de auditoría en la misma
 * firma y debe aplicarse de forma atómica: si el evento no puede escribirse, la
 * mutación no queda visible y la operación falla, conforme a ADR-012. La ausencia
 * de un método de lectura de valor es deliberada; el almacén nunca recibe material
 * secreto que pudiera devolver.
 */
export interface SecretMetadataStore {
  register(registration: SecretRegistration, audit: SecretAuditEvent): Promise<SecretMetadata>;
  rotate(rotation: SecretRotation, audit: SecretAuditEvent): Promise<SecretMetadata>;
  revoke(revocation: SecretRevocation, audit: SecretAuditEvent): Promise<SecretMetadata>;
  findByReference(reference: SecretReference): Promise<SecretMetadata | undefined>;
  findByRequestId(requestId: string): Promise<SecretMetadata | undefined>;
}
