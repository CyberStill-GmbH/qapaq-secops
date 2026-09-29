import type { SecretReference } from '../secrets/index.js';
import type { SecretFingerprint } from './secret-fingerprint.js';

/** Estado persistido. La rotación no crea un estado propio: incrementa la versión viva. */
export type SecretLifecycleStatus = 'active' | 'revoked';

/** Estado presentado, derivado del persistido más la expiración declarada. */
export type SecretLifecycleView = 'active' | 'expired' | 'revoked';

export type SecretActorType = 'human' | 'service';

export interface SecretActor {
  readonly actorType: SecretActorType;
  readonly actorId: string;
}

/** Contexto de la operación. `requestId` es la clave de idempotencia del control plane. */
export interface SecretOperationContext {
  readonly actor: SecretActor;
  readonly requestId: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
}

export type SecretLabels = Readonly<Record<string, string>>;

/**
 * Metadata no sensible. Es el único registro durable que QAPAQ conserva: ninguna
 * propiedad admite material secreto, ni siquiera cifrado de forma reversible.
 */
export interface SecretMetadata {
  readonly id: string;
  readonly reference: SecretReference;
  readonly namespace: string;
  readonly purpose: string;
  readonly provider: string;
  readonly owner: string;
  readonly status: SecretLifecycleStatus;
  readonly version: number;
  readonly revision: bigint;
  readonly fingerprint: SecretFingerprint;
  readonly labels: SecretLabels;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly rotatedAt?: Date;
  readonly rotatedBy?: string;
  readonly revokedAt?: Date;
  readonly revokedBy?: string;
  readonly expiresAt?: Date;
}

/** Proyección de salida del control plane. No existe una proyección que incluya el valor. */
export interface SecretMetadataView {
  readonly id: string;
  readonly reference: SecretReference;
  readonly purpose: string;
  readonly provider: string;
  readonly owner: string;
  readonly status: SecretLifecycleView;
  readonly version: number;
  readonly fingerprint: SecretFingerprint;
  readonly labels: SecretLabels;
  readonly createdAt: string;
  readonly rotatedAt?: string;
  readonly revokedAt?: string;
  readonly expiresAt?: string;
}

export function deriveLifecycleView(metadata: SecretMetadata, now: Date): SecretLifecycleView {
  if (metadata.status === 'revoked') return 'revoked';
  if (metadata.expiresAt !== undefined && metadata.expiresAt.getTime() <= now.getTime())
    return 'expired';
  return 'active';
}

export function toMetadataView(metadata: SecretMetadata, now: Date): SecretMetadataView {
  return Object.freeze({
    id: metadata.id,
    reference: metadata.reference,
    purpose: metadata.purpose,
    provider: metadata.provider,
    owner: metadata.owner,
    status: deriveLifecycleView(metadata, now),
    version: metadata.version,
    fingerprint: metadata.fingerprint,
    labels: metadata.labels,
    createdAt: metadata.createdAt.toISOString(),
    ...(metadata.rotatedAt === undefined ? {} : { rotatedAt: metadata.rotatedAt.toISOString() }),
    ...(metadata.revokedAt === undefined ? {} : { revokedAt: metadata.revokedAt.toISOString() }),
    ...(metadata.expiresAt === undefined ? {} : { expiresAt: metadata.expiresAt.toISOString() }),
  });
}
