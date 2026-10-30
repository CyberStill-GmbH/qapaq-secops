/**
 * Puerto neutral de reputación de archivos por hash.
 *
 * El dominio pregunta "¿qué se sabe de este hash?" y recibe un resultado normalizado; qué
 * servicio responde, con qué credencial y en qué formato es asunto del adapter. El puerto solo
 * admite hashes: no hay operación para subir archivos ni para consultar URLs, dominios o IPs, y
 * esa ausencia es deliberada.
 */

import type { FileHash, FileReputation } from '@qapaq/contracts';

export type FileReputationLookup =
  | { readonly status: 'found'; readonly reputation: FileReputation }
  | { readonly status: 'unknown' };

export type FileReputationErrorCode =
  /** El servicio rechazó la credencial: sin clave válida no hay consulta posible. */
  | 'REPUTATION_AUTHENTICATION_FAILED'
  /** El servicio aplicó su propio límite de tasa o de cuota. */
  | 'REPUTATION_RATE_LIMITED'
  | 'REPUTATION_TIMEOUT'
  /** Red, DNS, TLS o 5xx del servicio. */
  | 'REPUTATION_UNAVAILABLE'
  /** Respuesta que no cumple el formato esperado o excede el tamaño admitido. */
  | 'REPUTATION_RESPONSE_INVALID'
  /** El servicio rechazó la consulta (4xx distinto de 401/403/404/429). */
  | 'REPUTATION_QUERY_REJECTED';

export class FileReputationProviderError extends Error {
  public constructor(
    public readonly code: FileReputationErrorCode,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = 'FileReputationProviderError';
  }
}

export interface FileReputationProvider {
  /** Identificador estable del servicio, para auditoría y caché; no se muestra como texto. */
  readonly providerId: string;
  lookup(hash: FileHash, signal?: AbortSignal): Promise<FileReputationLookup>;
}
