import { CONFIGURATION_LIMITS, REDACTED_VALUE } from '../limits.js';
import { secretControlPlaneError } from './secret-lifecycle.errors.js';

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * Material secreto recibido una sola vez por el control plane. El valor nunca se
 * expone por getter: solo `use` lo entrega a un consumidor explícito y queda
 * quemado en la primera invocación, de modo que un retry o un segundo lector no
 * pueden volver a leerlo.
 */
export class SubmittedSecret {
  #plaintext: string | undefined;
  readonly #byteLength: number;

  public constructor(plaintext: string, path = 'secret') {
    if (typeof plaintext !== 'string')
      throw secretControlPlaneError('SECRET_REQUEST_INVALID', path);
    const byteLength = Buffer.byteLength(plaintext, 'utf8');
    if (
      byteLength < CONFIGURATION_LIMITS.secretPlaintextMinimumBytes ||
      byteLength > CONFIGURATION_LIMITS.secretPlaintextMaximumBytes
    )
      throw secretControlPlaneError('SECRET_REQUEST_INVALID', path);
    this.#plaintext = plaintext;
    this.#byteLength = byteLength;
  }

  public get byteLength(): number {
    return this.#byteLength;
  }

  public get consumed(): boolean {
    return this.#plaintext === undefined;
  }

  /** Entrega el material una única vez y lo descarta antes de invocar al consumidor. */
  public use<T>(consume: (plaintext: string) => T): T {
    const plaintext = this.#plaintext;
    if (plaintext === undefined) throw secretControlPlaneError('SECRET_ALREADY_CONSUMED', 'secret');
    this.#plaintext = undefined;
    return consume(plaintext);
  }

  public toJSON(): string {
    return REDACTED_VALUE;
  }

  public toString(): string {
    return REDACTED_VALUE;
  }

  public [INSPECT](): string {
    return REDACTED_VALUE;
  }
}
