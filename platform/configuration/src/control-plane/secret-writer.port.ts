import type { SecretReference } from '../secrets/index.js';

/**
 * Resultado de una escritura. Transporta identificadores y versión, nunca el valor:
 * el control plane no dispone de ninguna ruta de tipos para recuperarlo.
 */
export interface SecretWriteReceipt {
  readonly reference: SecretReference;
  readonly version: number;
  readonly providerOperationId: string;
  readonly acknowledgedAt: Date;
}

export interface SecretCreateRequest {
  readonly reference: SecretReference;
  readonly plaintext: string;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

export interface SecretRotateRequest {
  readonly reference: SecretReference;
  readonly plaintext: string;
  readonly currentVersion: number;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

export interface SecretRevokeRequest {
  readonly reference: SecretReference;
  readonly version: number;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

/**
 * Frontera de escritura hacia el gestor de secretos externo. Es un puerto separado
 * de `SecretProvider` a propósito: aquel resuelve en runtime bajo la identidad del
 * adapter y este solo escribe bajo la identidad del control plane. Ninguna
 * implementación debe añadir una operación de lectura.
 */
export interface SecretWriter {
  /** Identidad del gestor externo. La declara la implementación, no el solicitante. */
  readonly providerId: string;
  create(request: SecretCreateRequest): Promise<SecretWriteReceipt>;
  rotate(request: SecretRotateRequest): Promise<SecretWriteReceipt>;
  revoke(request: SecretRevokeRequest): Promise<void>;
}

export type SecretWriterErrorCode =
  'WRITER_REJECTED' | 'WRITER_UNREACHABLE' | 'WRITER_VERSION_CONFLICT' | 'WRITER_OUTCOME_UNKNOWN';

/**
 * `WRITER_OUTCOME_UNKNOWN` describe un timeout o corte donde el proveedor pudo
 * haber aplicado la escritura. El control plane no puede afirmar éxito ni
 * compensar automáticamente: la revocación ciega destruiría una versión en uso.
 */
export class SecretWriterError extends Error {
  public readonly code: SecretWriterErrorCode;

  public constructor(code: SecretWriterErrorCode) {
    super(code);
    this.name = 'SecretWriterError';
    this.code = code;
  }
}
