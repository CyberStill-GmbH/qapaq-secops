/**
 * Adapter de reputación de archivos sobre la API v3 pública de VirusTotal.
 *
 * Los términos de la API pública no permiten automatizarla dentro de un producto comercial, así
 * que este adapter solo existe para la consulta manual del analista y está acotado a propósito:
 *
 * - Una única operación, `GET /api/v3/files/{hash}`, contra un host fijo. No sube archivos ni
 *   consulta URLs, dominios o IPs: no hay código que lo haga.
 * - El hash se valida antes de construir la URL; nunca se interpola texto libre.
 * - Timeout por consulta, respuesta acotada en bytes y sin seguir redirecciones.
 * - La salida es el `FileReputation` neutral; el documento del servicio no sale de aquí.
 *
 * La cuota (4/min y 500/día) y la caché no viven en el adapter: las aplica el caso de uso con el
 * almacenamiento compartido, para que valgan entre réplicas y reinicios.
 */

import { isFileHash, type FileHash, type FileReputation } from '@qapaq/contracts';

import {
  FileReputationProviderError,
  type FileReputationLookup,
  type FileReputationProvider,
} from '../../application/file-reputation-provider.js';

export const VIRUSTOTAL_PROVIDER_ID = 'virustotal' as const;
const API_BASE = 'https://www.virustotal.com/api/v3/files/';
const REPORT_BASE = 'https://www.virustotal.com/gui/file/';
const DEFAULT_TIMEOUT_MS = 10_000;
/** Un reporte de archivo ronda cientos de KB; 2 MiB deja margen sin aceptar cualquier cosa. */
const MAXIMUM_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_THREAT_LABELS = 10;
const MAXIMUM_THREAT_LABEL_LENGTH = 64;
/** Veredictos que cuentan como motor que analizó el archivo; timeouts y fallos no cuentan. */
const DETECTION_VERDICTS = ['malicious', 'suspicious'] as const;
const CLEAN_VERDICTS = ['undetected', 'harmless'] as const;

export interface VirusTotalProviderOptions {
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

function readObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Fechas del servicio: segundos Unix. Un valor fuera de rango se descarta, no se inventa. */
function unixSecondsToIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  const date = new Date(value * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function threatLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Solo texto imprimible y acotado: la etiqueta se muestra en la consola y se audita.
  const cleaned = value.replace(/[^\p{L}\p{N} ._:/@#()+-]/gu, '').trim();
  return cleaned.length === 0 ? undefined : cleaned.slice(0, MAXIMUM_THREAT_LABEL_LENGTH);
}

function threatLabels(attributes: Readonly<Record<string, unknown>>): readonly string[] {
  const labels: string[] = [];
  const push = (value: unknown) => {
    const label = threatLabel(value);
    if (label && !labels.includes(label) && labels.length < MAXIMUM_THREAT_LABELS) {
      labels.push(label);
    }
  };
  const classification = readObject(attributes['popular_threat_classification']);
  if (classification) {
    push(classification['suggested_threat_label']);
    for (const key of ['popular_threat_category', 'popular_threat_name']) {
      const entries = classification[key];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) push(readObject(entry)?.['value']);
    }
  }
  return labels;
}

/** Normaliza `data.attributes` del reporte de archivo; `undefined` si no tiene la forma esperada. */
export function normalizeVirusTotalFileReport(
  body: unknown,
  hash: FileHash,
): FileReputation | undefined {
  const data = readObject(readObject(body)?.['data']);
  const attributes = readObject(data?.['attributes']);
  const stats = readObject(attributes?.['last_analysis_stats']);
  if (!data || !attributes || !stats || data['type'] !== 'file') return undefined;
  const detections = DETECTION_VERDICTS.reduce((total, key) => total + count(stats[key]), 0);
  const engines = detections + CLEAN_VERDICTS.reduce((total, key) => total + count(stats[key]), 0);
  // El id del objeto es el SHA-256 aunque se haya buscado por MD5 o SHA-1.
  const id = typeof data['id'] === 'string' ? data['id'].toLowerCase() : '';
  const reportHash = isFileHash('sha256', id) ? id : hash.value;
  return {
    detections,
    engines,
    firstSeenAt: unixSecondsToIso(attributes['first_submission_date']),
    lastAnalysisAt: unixSecondsToIso(attributes['last_analysis_date']),
    threatLabels: threatLabels(attributes),
    reportUrl: `${REPORT_BASE}${reportHash}`,
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAXIMUM_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new FileReputationProviderError('REPUTATION_RESPONSE_INVALID', false);
  }
  if (!response.body) throw new FileReputationProviderError('REPUTATION_RESPONSE_INVALID', false);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > MAXIMUM_RESPONSE_BYTES) {
      await reader.cancel();
      throw new FileReputationProviderError('REPUTATION_RESPONSE_INVALID', false);
    }
    chunks.push(part.value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new FileReputationProviderError('REPUTATION_RESPONSE_INVALID', false);
  }
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null || !/^\d{1,5}$/u.test(header.trim())) return undefined;
  return Number(header.trim()) * 1_000;
}

function isAbort(error: unknown): boolean {
  const name = readObject(error)?.['name'];
  return name === 'AbortError' || name === 'TimeoutError';
}

export class VirusTotalFileReputationProvider implements FileReputationProvider {
  public readonly providerId = VIRUSTOTAL_PROVIDER_ID;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch | undefined;

  public constructor(options: VirusTotalProviderOptions) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      !/^[A-Za-z0-9]{32,128}$/u.test(options.apiKey) ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 60_000
    ) {
      throw new FileReputationProviderError('REPUTATION_QUERY_REJECTED', false);
    }
    this.#apiKey = options.apiKey;
    this.#timeoutMs = timeoutMs;
    this.#fetch = options.fetch;
  }

  public async lookup(hash: FileHash, signal?: AbortSignal): Promise<FileReputationLookup> {
    if (!isFileHash(hash.algorithm, hash.value)) {
      throw new FileReputationProviderError('REPUTATION_QUERY_REJECTED', false);
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      // `fetch` global se resuelve en cada consulta, no al construir.
      response = await (this.#fetch ?? globalThis.fetch)(`${API_BASE}${hash.value}`, {
        method: 'GET',
        headers: { accept: 'application/json', 'x-apikey': this.#apiKey },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        cache: 'no-store',
        redirect: 'error',
      });
    } catch (error) {
      throw new FileReputationProviderError(
        isAbort(error) ? 'REPUTATION_TIMEOUT' : 'REPUTATION_UNAVAILABLE',
        true,
      );
    }

    if (response.status === 404) {
      await response.body?.cancel();
      return { status: 'unknown' };
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        throw new FileReputationProviderError('REPUTATION_AUTHENTICATION_FAILED', false);
      }
      if (response.status === 429) {
        throw new FileReputationProviderError(
          'REPUTATION_RATE_LIMITED',
          true,
          retryAfterMs(response),
        );
      }
      if (response.status >= 500) {
        throw new FileReputationProviderError('REPUTATION_UNAVAILABLE', true);
      }
      throw new FileReputationProviderError('REPUTATION_QUERY_REJECTED', false);
    }

    let body: unknown;
    try {
      body = await readBoundedJson(response);
    } catch (error) {
      if (error instanceof FileReputationProviderError) throw error;
      throw new FileReputationProviderError(
        isAbort(error) ? 'REPUTATION_TIMEOUT' : 'REPUTATION_UNAVAILABLE',
        true,
      );
    }
    const reputation = normalizeVirusTotalFileReport(body, hash);
    if (!reputation) throw new FileReputationProviderError('REPUTATION_RESPONSE_INVALID', false);
    return { status: 'found', reputation };
  }
}

export function createVirusTotalFileReputationProvider(
  options: VirusTotalProviderOptions,
): FileReputationProvider {
  return new VirusTotalFileReputationProvider(options);
}
