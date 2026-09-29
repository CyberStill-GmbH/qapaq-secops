import { createHmac, timingSafeEqual } from 'node:crypto';
import { CONFIGURATION_LIMITS, REDACTED_VALUE } from '../limits.js';
import { secretControlPlaneError } from './secret-lifecycle.errors.js';

const INSPECT = Symbol.for('nodejs.util.inspect.custom');
const ALGORITHM = 'hmac-sha256';
const SCHEME_VERSION = 'v1';
const KEY_ID_LABEL = 'qapaq.secret-fingerprint.key-id';
const KEY_MINIMUM_BYTES = 32;
const DIGEST_BYTES = CONFIGURATION_LIMITS.secretFingerprintBits / 8;

declare const secretFingerprintBrand: unique symbol;
export type SecretFingerprint = string & { readonly [secretFingerprintBrand]: true };

export const SECRET_FINGERPRINT_PATTERN =
  /^hmac-sha256:v1:[0-9a-f]{8}:[A-Za-z0-9_-]{22}$/u as Readonly<RegExp>;

export function parseSecretFingerprint(value: unknown, path = 'fingerprint'): SecretFingerprint {
  if (typeof value !== 'string' || !SECRET_FINGERPRINT_PATTERN.test(value))
    throw secretControlPlaneError('SECRET_REQUEST_INVALID', path);
  return value as SecretFingerprint;
}

/**
 * Clave de fingerprint. Vive fuera de la tabla de metadata: un volcado de la base
 * de datos entrega fingerprints pero no permite recomputarlos, de modo que un
 * secreto de baja entropía no queda expuesto a fuerza bruta offline.
 */
export class SecretFingerprintKey {
  readonly #key: Buffer;
  public readonly keyId: string;

  public constructor(key: string, path = 'fingerprintKey') {
    const material = Buffer.from(key, 'utf8');
    if (material.byteLength < KEY_MINIMUM_BYTES)
      throw secretControlPlaneError('SECRET_REQUEST_INVALID', path);
    this.#key = material;
    this.keyId = createHmac('sha256', material).update(KEY_ID_LABEL).digest('hex').slice(0, 8);
    Object.freeze(this);
  }

  /**
   * Calcula el fingerprint del material recibido. Es una función de un solo sentido:
   * el resultado identifica un cambio de valor sin permitir reconstruirlo.
   */
  public compute(plaintext: string): SecretFingerprint {
    const digest = createHmac('sha256', this.#key)
      .update(plaintext, 'utf8')
      .digest()
      .subarray(0, DIGEST_BYTES)
      .toString('base64url');
    return `${ALGORITHM}:${SCHEME_VERSION}:${this.keyId}:${digest}` as SecretFingerprint;
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

export function fingerprintsMatch(left: SecretFingerprint, right: SecretFingerprint): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
