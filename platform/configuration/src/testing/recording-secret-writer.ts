import type { SecretReference } from '../secrets/index.js';
import {
  SecretWriterError,
  type SecretCreateRequest,
  type SecretRevokeRequest,
  type SecretRotateRequest,
  type SecretWriteReceipt,
  type SecretWriter,
  type SecretWriterErrorCode,
} from '../control-plane/secret-writer.port.js';

interface WriterCall {
  readonly operation: 'create' | 'rotate' | 'revoke';
  readonly reference: SecretReference;
  readonly idempotencyKey: string;
  readonly plaintextByteLength: number;
}

/**
 * Escritor de pruebas. Registra la invocación y el tamaño del material recibido,
 * nunca su contenido: una spec que inspeccione este doble no puede convertirlo en
 * un almacén de secretos ni filtrar el valor a la evidencia.
 */
export class RecordingSecretWriter implements SecretWriter {
  public readonly providerId = 'in-memory';
  public readonly calls: WriterCall[] = [];
  readonly #versions = new Map<string, number>();
  public failNextWith: SecretWriterErrorCode | undefined;

  public async create(request: SecretCreateRequest): Promise<SecretWriteReceipt> {
    this.#record('create', request.reference, request.idempotencyKey, request.plaintext);
    this.#maybeFail();
    const version = 1;
    this.#versions.set(request.reference, version);
    return this.#receipt(request.reference, version);
  }

  public async rotate(request: SecretRotateRequest): Promise<SecretWriteReceipt> {
    this.#record('rotate', request.reference, request.idempotencyKey, request.plaintext);
    this.#maybeFail();
    const current = this.#versions.get(request.reference) ?? 0;
    if (current !== request.currentVersion) throw new SecretWriterError('WRITER_VERSION_CONFLICT');
    const version = current + 1;
    this.#versions.set(request.reference, version);
    return this.#receipt(request.reference, version);
  }

  public async revoke(request: SecretRevokeRequest): Promise<void> {
    this.calls.push({
      operation: 'revoke',
      reference: request.reference,
      idempotencyKey: request.idempotencyKey,
      plaintextByteLength: 0,
    });
    this.#maybeFail();
    this.#versions.delete(request.reference);
  }

  #record(
    operation: 'create' | 'rotate',
    reference: SecretReference,
    idempotencyKey: string,
    plaintext: string,
  ): void {
    this.calls.push({
      operation,
      reference,
      idempotencyKey,
      plaintextByteLength: Buffer.byteLength(plaintext, 'utf8'),
    });
  }

  #maybeFail(): void {
    const failure = this.failNextWith;
    if (failure === undefined) return;
    this.failNextWith = undefined;
    throw new SecretWriterError(failure);
  }

  #receipt(reference: SecretReference, version: number): SecretWriteReceipt {
    return Object.freeze({
      reference,
      version,
      providerOperationId: `op-${reference}-${version}`,
      acknowledgedAt: new Date(0),
    });
  }
}
