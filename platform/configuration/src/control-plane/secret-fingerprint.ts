import { createHmac } from 'node:crypto';

export interface SecretFingerprinter {
  fingerprint(material: Uint8Array): string;
}

/** Keyed fingerprint prevents cheap offline guessing of low-entropy secrets. */
export class HmacSha256SecretFingerprinter implements SecretFingerprinter {
  readonly #key: Uint8Array;

  public constructor(key: string | Uint8Array) {
    this.#key = typeof key === 'string' ? new TextEncoder().encode(key) : new Uint8Array(key);
    if (this.#key.byteLength < 32) throw new Error('SECRET_FINGERPRINT_KEY_INVALID');
  }

  public fingerprint(material: Uint8Array): string {
    return `hmac-sha256:v1:${createHmac('sha256', this.#key).update(material).digest('hex')}`;
  }
}
