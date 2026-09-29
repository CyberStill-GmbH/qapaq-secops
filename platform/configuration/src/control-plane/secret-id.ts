import { randomBytes } from 'node:crypto';

export const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * UUIDv7 derivado del instante de la operación. El repositorio genera los
 * identificadores en la aplicación, nunca en SQL (ver `platform/database`).
 */
export function newSecretMetadataId(occurredAt: Date): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(occurredAt.getTime());
  for (let index = 0; index < 6; index += 1)
    bytes[index] = Number((timestamp >> BigInt(8 * (5 - index))) & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
