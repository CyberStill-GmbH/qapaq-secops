import { createHash } from 'node:crypto';

/**
 * Derivación determinista de UUIDv7, compartida por la admisión durable (C-11) y la
 * normalización (C-12).
 *
 * La identidad de un registro debe ser estable entre reintentos: el mismo `namespace` y
 * `label` sobre el mismo instante producen siempre el mismo identificador, de modo que
 * reprocesar una página no genera registros nuevos. El prefijo temporal de UUIDv7 se
 * conserva para mantener el orden de inserción en la base.
 */
export function deterministicUuid7(namespace: string, label: string, timestamp: Date): string {
  const millis = timestamp.getTime();
  if (!Number.isSafeInteger(millis) || millis < 0 || millis >= 2 ** 48) {
    throw new RangeError('El instante no es representable como UUIDv7.');
  }
  const digest = createHash('sha256').update(`${namespace}\0${label}`, 'utf8').digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  const time = BigInt(millis);
  for (let i = 5; i >= 0; i--) bytes[i] = Number((time >> BigInt((5 - i) * 8)) & 0xffn);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
