/**
 * Contrato del enriquecimiento de reputación de archivos por hash (v1).
 *
 * El analista lo pide de forma explícita sobre una alerta; el BFF consulta solo los hashes que
 * la alerta ya trae y devuelve un resultado normalizado, independiente del servicio externo que
 * lo respalde. Nada aquí identifica al servicio: la ruta del BFF sí, porque la cuota y los
 * términos de uso son de ese servicio.
 */

export const FILE_REPUTATION_CONTRACT_VERSION = '1.0.0' as const;

export const FILE_HASH_ALGORITHMS = ['md5', 'sha1', 'sha256'] as const;
export type FileHashAlgorithm = (typeof FILE_HASH_ALGORITHMS)[number];

/** Longitud hexadecimal de cada algoritmo; un valor con otra forma no es un hash consultable. */
export const FILE_HASH_HEX_LENGTH: Readonly<Record<FileHashAlgorithm, number>> = Object.freeze({
  md5: 32,
  sha1: 40,
  sha256: 64,
});

/** Preferencia de consulta: un mismo archivo se busca por el hash más fuerte que haya. */
export const FILE_HASH_PREFERENCE: readonly FileHashAlgorithm[] = ['sha256', 'sha1', 'md5'];

export interface FileHash {
  readonly algorithm: FileHashAlgorithm;
  /** Hexadecimal en minúsculas. */
  readonly value: string;
}

/** `true` si `value` es un hash hexadecimal válido para `algorithm`. */
export function isFileHash(algorithm: string, value: string): algorithm is FileHashAlgorithm {
  const length = FILE_HASH_HEX_LENGTH[algorithm as FileHashAlgorithm];
  return length !== undefined && value.length === length && /^[0-9a-f]+$/u.test(value);
}

export interface FileReputation {
  /** Motores que marcan el archivo como malicioso o sospechoso. */
  readonly detections: number;
  /** Motores que emitieron un veredicto en el último análisis. */
  readonly engines: number;
  readonly firstSeenAt: string | null;
  readonly lastAnalysisAt: string | null;
  /** Etiquetas de amenaza del servicio (familia, categoría), acotadas y sin duplicados. */
  readonly threatLabels: readonly string[];
  /** Ficha pública del archivo para que el analista la abra en el navegador. */
  readonly reportUrl: string;
}

export interface FileReputationQuota {
  readonly minute: { readonly limit: number; readonly remaining: number };
  readonly day: { readonly limit: number; readonly remaining: number; readonly resetsAt: string };
}

/**
 * Respuesta de `POST /api/alerts/:id/enrichment/virustotal`.
 *
 * - `found`: el servicio conoce el archivo y `reputation` trae el resumen.
 * - `unknown`: el servicio no tiene análisis de ese hash (no implica que sea benigno).
 *
 * `cached` dice si el resultado salió de la caché del tenant (vigente `cacheTtlHours`) en vez de
 * una consulta nueva; en ese caso no se gastó cuota.
 */
export interface FileReputationEnrichment {
  readonly correlationId: string;
  readonly alertId: string;
  readonly hash: FileHash;
  readonly status: 'found' | 'unknown';
  readonly reputation: FileReputation | null;
  readonly cached: boolean;
  readonly checkedAt: string;
  readonly cacheTtlHours: number;
  readonly quota: FileReputationQuota;
}
