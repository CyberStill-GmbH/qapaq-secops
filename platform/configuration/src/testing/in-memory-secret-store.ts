import type { SecretReference } from '../secrets/index.js';
import type { SecretAuditEvent } from '../control-plane/secret-audit.js';
import type { SecretMetadata } from '../control-plane/secret-lifecycle.types.js';
import {
  SecretStoreError,
  type SecretMetadataStore,
  type SecretRegistration,
  type SecretRevocation,
  type SecretRotation,
} from '../control-plane/secret-metadata-store.port.js';

/**
 * Almacén en memoria para specs de contrato. Reproduce la atomicidad exigida a la
 * implementación real: si el registro de auditoría falla, la mutación no se aplica.
 * No es una implementación de producción y no persiste material secreto.
 */
export class InMemorySecretStore implements SecretMetadataStore {
  readonly #records = new Map<string, SecretMetadata>();
  readonly #byRequest = new Map<string, string>();
  public readonly auditTrail: SecretAuditEvent[] = [];
  public failAuditOnce = false;
  public failStoreOnce = false;

  public async register(
    registration: SecretRegistration,
    audit: SecretAuditEvent,
  ): Promise<SecretMetadata> {
    this.#guard();
    if (this.#records.has(registration.reference)) throw new SecretStoreError('STORE_DUPLICATE');
    const metadata: SecretMetadata = Object.freeze({
      id: registration.id,
      reference: registration.reference,
      namespace: registration.namespace,
      purpose: registration.purpose,
      provider: registration.provider,
      owner: registration.owner,
      status: 'active' as const,
      version: registration.version,
      revision: 1n,
      fingerprint: registration.fingerprint,
      labels: registration.labels,
      createdAt: registration.createdAt,
      createdBy: registration.createdBy,
      ...(registration.expiresAt === undefined ? {} : { expiresAt: registration.expiresAt }),
    });
    return this.#commit(metadata, registration.requestId, audit);
  }

  public async rotate(rotation: SecretRotation, audit: SecretAuditEvent): Promise<SecretMetadata> {
    this.#guard();
    const current = this.#expect(rotation.reference, rotation.expectedRevision);
    const metadata: SecretMetadata = Object.freeze({
      ...current,
      version: rotation.version,
      revision: current.revision + 1n,
      fingerprint: rotation.fingerprint,
      rotatedAt: rotation.rotatedAt,
      rotatedBy: rotation.rotatedBy,
      ...(rotation.expiresAt === undefined ? {} : { expiresAt: rotation.expiresAt }),
    });
    return this.#commit(metadata, rotation.requestId, audit);
  }

  public async revoke(
    revocation: SecretRevocation,
    audit: SecretAuditEvent,
  ): Promise<SecretMetadata> {
    this.#guard();
    const current = this.#expect(revocation.reference, revocation.expectedRevision);
    const metadata: SecretMetadata = Object.freeze({
      ...current,
      status: 'revoked' as const,
      revision: current.revision + 1n,
      revokedAt: revocation.revokedAt,
      revokedBy: revocation.revokedBy,
    });
    return this.#commit(metadata, revocation.requestId, audit);
  }

  public async findByReference(reference: SecretReference): Promise<SecretMetadata | undefined> {
    return this.#records.get(reference);
  }

  public async findByRequestId(requestId: string): Promise<SecretMetadata | undefined> {
    const reference = this.#byRequest.get(requestId);
    return reference === undefined ? undefined : this.#records.get(reference);
  }

  /** Proyección cruda de lo persistido, para inspección de fugas en specs. */
  public dump(): readonly SecretMetadata[] {
    return [...this.#records.values()];
  }

  #guard(): void {
    if (this.failStoreOnce) {
      this.failStoreOnce = false;
      throw new SecretStoreError('STORE_UNAVAILABLE');
    }
  }

  #expect(reference: SecretReference, expectedRevision: bigint): SecretMetadata {
    const current = this.#records.get(reference);
    if (current === undefined) throw new SecretStoreError('STORE_NOT_FOUND');
    if (current.revision !== expectedRevision)
      throw new SecretStoreError('STORE_REVISION_CONFLICT');
    return current;
  }

  #commit(metadata: SecretMetadata, requestId: string, audit: SecretAuditEvent): SecretMetadata {
    if (this.failAuditOnce) {
      this.failAuditOnce = false;
      throw new SecretStoreError('STORE_AUDIT_UNAVAILABLE');
    }
    this.#records.set(metadata.reference, metadata);
    this.#byRequest.set(requestId, metadata.reference);
    this.auditTrail.push(audit);
    return metadata;
  }
}
