import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  SecurityEventProviderError,
  type EventPage,
  type EventQuery,
  type JsonObject,
  type JsonValue,
  type ProviderHealth,
  type ProviderRecord,
  type SecurityEventProvider,
  type SourceCapabilities,
} from '../../application/security-event-provider.js';

export interface WazuhSearchHit {
  readonly _id?: unknown;
  readonly _source?: unknown;
  readonly sort?: unknown;
}
export interface WazuhSearchResponse {
  readonly hits?: { readonly hits?: readonly WazuhSearchHit[]; readonly total?: unknown };
}
export interface WazuhReadClient {
  health(signal?: AbortSignal): Promise<{ readonly status: string }>;
  search(
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<WazuhSearchResponse>;
  close(): Promise<void>;
}

export interface WazuhConnectorTelemetryEvent {
  readonly connector: 'wazuh';
  readonly operation: 'health' | 'search_security_events';
  readonly result: 'success' | 'failure';
  readonly errorClass?: string;
  readonly durationMs: number;
}

export interface WazuhConnectorTelemetry {
  record(event: WazuhConnectorTelemetryEvent): void;
}

export interface WazuhSecurityEventProviderOptions {
  readonly sourceId: string;
  readonly allowedDatasets: readonly string[];
  readonly maximumPageSize: number;
  readonly maximumResponseBytes: number;
  readonly retryLimit?: number;
  readonly maximumBackoffMs?: number;
  readonly cursorSecret: string;
  readonly cursorTtlMs?: number;
  readonly client: WazuhReadClient;
  readonly telemetry?: WazuhConnectorTelemetry;
  readonly now?: () => number;
}

interface CursorPayload {
  readonly v: 1;
  readonly sourceId: string;
  readonly dataset: string;
  readonly from: string;
  readonly to: string;
  readonly pageSize: number;
  readonly sort: readonly JsonValue[];
  readonly exp: number;
}

const MAX_CURSOR_LENGTH = 4096;
const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
const DATASET = 'wazuh-alerts';

function errorFrom(error: unknown, operation: 'health' | 'readPage'): SecurityEventProviderError {
  if (error instanceof SecurityEventProviderError) return error;
  const candidate = error as {
    statusCode?: number;
    name?: string;
    code?: string;
    meta?: { statusCode?: number };
  };
  const status = candidate?.statusCode ?? candidate?.meta?.statusCode;
  if (
    candidate?.name === 'AbortError' ||
    candidate?.code === 'REQUEST_TIMEOUT' ||
    candidate?.code === 'REQUEST_CANCELLED'
  )
    return new SecurityEventProviderError('PROVIDER_TIMEOUT', operation, false);
  if (status === 401)
    return new SecurityEventProviderError('PROVIDER_AUTHENTICATION_FAILED', operation, false);
  if (status === 403)
    return new SecurityEventProviderError('PROVIDER_AUTHORIZATION_DENIED', operation, false);
  if (status === 429)
    return new SecurityEventProviderError(
      'PROVIDER_RATE_LIMITED',
      operation,
      true,
      'PROVIDER_RATE_LIMITED',
      retryAfterMs(error),
    );
  if (status === 400)
    return new SecurityEventProviderError('PROVIDER_QUERY_REJECTED', operation, false);
  if (
    candidate?.code === 'CERT_HAS_EXPIRED' ||
    candidate?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    candidate?.code === 'ERR_TLS_CERT_ALTNAME_INVALID'
  )
    return new SecurityEventProviderError('PROVIDER_TLS_VALIDATION_FAILED', operation, false);
  if (status === 500)
    return new SecurityEventProviderError('PROVIDER_UPSTREAM_SERVER_ERROR', operation, false);
  if (status === 502 || status === 503 || status === 504)
    return new SecurityEventProviderError('PROVIDER_UPSTREAM_UNAVAILABLE', operation, true);
  if (candidate?.code === 'MALFORMED_RESPONSE' || candidate?.code === 'RESPONSE_TOO_LARGE')
    return new SecurityEventProviderError('PROVIDER_RESPONSE_INVALID', operation, false);
  return new SecurityEventProviderError('PROVIDER_GATEWAY_UNAVAILABLE', operation, true);
}

function retryAfterMs(error: unknown): number | undefined {
  const candidate = error as {
    retryAfter?: string;
    meta?: { headers?: Record<string, string> };
  };
  const value = candidate.retryAfter ?? candidate.meta?.headers?.['retry-after'];
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 60_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(0, date - Date.now()), 60_000) : undefined;
}

function transient(error: unknown): boolean {
  const candidate = error as { code?: string; statusCode?: number; meta?: { statusCode?: number } };
  const status = candidate.statusCode ?? candidate.meta?.statusCode;
  return (
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT'].includes(candidate.code ?? '')
  );
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new SecurityEventProviderError('PROVIDER_TIMEOUT', 'readPage', false);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new SecurityEventProviderError('PROVIDER_TIMEOUT', 'readPage', false));
      },
      { once: true },
    );
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonObject(value: unknown): JsonObject | undefined {
  if (!isObject(value)) return undefined;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || encoded.length > 1_000_000) return undefined;
    return JSON.parse(encoded) as JsonObject;
  } catch {
    return undefined;
  }
}

function parseCursor(
  value: string,
  secret: string,
  now: number,
): { payload: CursorPayload; encoded: string } {
  if (value.length > MAX_CURSOR_LENGTH)
    throw new SecurityEventProviderError('PROVIDER_CURSOR_INVALID', 'readPage', false);
  const parts = value.split('.');
  if (parts.length !== 2)
    throw new SecurityEventProviderError('PROVIDER_CURSOR_INVALID', 'readPage', false);
  const [encoded, signature] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(encoded).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'base64url');
  } catch {
    throw new SecurityEventProviderError('PROVIDER_CURSOR_INVALID', 'readPage', false);
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
    throw new SecurityEventProviderError('PROVIDER_CURSOR_INVALID', 'readPage', false);
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new SecurityEventProviderError('PROVIDER_CURSOR_INVALID', 'readPage', false);
  }
  if (
    !isObject(payload) ||
    payload['v'] !== 1 ||
    typeof payload['sourceId'] !== 'string' ||
    typeof payload['dataset'] !== 'string' ||
    typeof payload['from'] !== 'string' ||
    typeof payload['to'] !== 'string' ||
    typeof payload['exp'] !== 'number' ||
    typeof payload['pageSize'] !== 'number' ||
    !Array.isArray(payload['sort'])
  )
    throw new SecurityEventProviderError('PROVIDER_CURSOR_INVALID', 'readPage', false);
  if (payload['exp'] <= now)
    throw new SecurityEventProviderError('PROVIDER_CURSOR_EXPIRED', 'readPage', false);
  return { payload: payload as unknown as CursorPayload, encoded };
}

function makeCursor(payload: CursorPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
}

export class WazuhSecurityEventProvider implements SecurityEventProvider {
  readonly #now: () => number;
  public constructor(private readonly options: WazuhSecurityEventProviderOptions) {
    if (
      !options.sourceId ||
      options.cursorSecret.length < 32 ||
      options.maximumPageSize < 1 ||
      options.maximumResponseBytes < 1_024 ||
      options.allowedDatasets.length === 0
    )
      throw new SecurityEventProviderError('PROVIDER_CONFIGURATION_INVALID', 'health', false);
    this.#now = options.now ?? Date.now;
  }

  public async capabilities(): Promise<SourceCapabilities> {
    return {
      providerType: 'wazuh',
      datasets: [...this.options.allowedDatasets],
      paginationModes: ['search_after'],
      supportsRawRecords: true,
      supportsReplay: false,
      supportsHealth: true,
      maxPageSize: this.options.maximumPageSize,
      ordering: { primaryField: 'timestamp', tieBreaker: 'id' },
    };
  }

  public async health(): Promise<ProviderHealth> {
    const checkedAt = new Date(this.#now()).toISOString();
    const check = async (name: string, action: () => Promise<void>) => {
      const started = this.#now();
      try {
        await action();
        return {
          name,
          status: 'healthy' as const,
          code: `${name.toUpperCase()}_HEALTHY`,
          latencyMs: Math.max(0, this.#now() - started),
          message: 'Componente accesible',
        };
      } catch (error) {
        const mapped = errorFrom(error, 'health');
        return {
          name,
          status: 'unhealthy' as const,
          code: mapped.code,
          latencyMs: Math.max(0, this.#now() - started),
          message: 'No fue posible comprobar el componente',
        };
      }
    };
    const started = this.#now();
    const gateway = await check('c28-wazuh-gateway', async () => {
      const health = await this.options.client.health();
      if (
        typeof health.status !== 'string' ||
        !['green', 'yellow'].includes(health.status.toLowerCase())
      )
        throw new SecurityEventProviderError('PROVIDER_RESPONSE_INVALID', 'health', false);
    });
    this.options.telemetry?.record({
      connector: 'wazuh',
      operation: 'health',
      result: gateway.status === 'healthy' ? 'success' : 'failure',
      ...(gateway.status === 'healthy' ? {} : { errorClass: gateway.code }),
      durationMs: Math.max(0, this.#now() - started),
    });
    const components = [gateway];
    return {
      status: components.every((component) => component.status === 'healthy')
        ? 'healthy'
        : 'unhealthy',
      checkedAt,
      components,
    };
  }

  public async readPage(query: EventQuery): Promise<EventPage> {
    const readAt = new Date(this.#now()).toISOString();
    if (query.signal?.aborted)
      throw new SecurityEventProviderError('PROVIDER_TIMEOUT', 'readPage', false);
    if (query.cursor && query.sourceId !== this.options.sourceId) {
      const { payload } = parseCursor(query.cursor, this.options.cursorSecret, this.#now());
      if (payload.sourceId !== query.sourceId)
        throw new SecurityEventProviderError('PROVIDER_CURSOR_INCOMPATIBLE', 'readPage', false);
    }
    const from = Date.parse(query.from);
    const to = Date.parse(query.to);
    const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
    if (
      !query.sourceId ||
      query.sourceId !== this.options.sourceId ||
      !this.options.allowedDatasets.includes(query.dataset) ||
      query.dataset !== DATASET ||
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      !rfc3339.test(query.from) ||
      !rfc3339.test(query.to) ||
      from > to ||
      to - from > MAX_RANGE_MS ||
      !Number.isInteger(query.pageSize) ||
      query.pageSize < 1 ||
      query.pageSize > this.options.maximumPageSize
    )
      throw new SecurityEventProviderError('PROVIDER_QUERY_REJECTED', 'readPage', false);
    let searchAfter: readonly JsonValue[] | undefined;
    if (query.cursor) {
      const { payload } = parseCursor(query.cursor, this.options.cursorSecret, this.#now());
      if (
        payload.sourceId !== query.sourceId ||
        payload.dataset !== query.dataset ||
        payload.from !== query.from ||
        payload.to !== query.to ||
        payload.pageSize !== query.pageSize
      )
        throw new SecurityEventProviderError('PROVIDER_CURSOR_INCOMPATIBLE', 'readPage', false);
      searchAfter = payload.sort;
    }
    try {
      let response: WazuhSearchResponse | undefined;
      for (let attempt = 0; attempt <= (this.options.retryLimit ?? 0); attempt += 1) {
        try {
          response = await this.options.client.search(
            {
              size: query.pageSize + 1,
              query: { range: { timestamp: { gte: query.from, lte: query.to } } },
              sort: [{ timestamp: { order: 'asc' } }, { id: { order: 'asc' } }],
              ...(searchAfter ? { search_after: searchAfter } : {}),
            },
            query.signal,
          );
          break;
        } catch (error) {
          if (!transient(error) || attempt >= (this.options.retryLimit ?? 0)) throw error;
          const cap = Math.min(this.options.maximumBackoffMs ?? 5_000, 100 * 2 ** attempt);
          const wait = retryAfterMs(error) ?? Math.floor(Math.random() * cap);
          await delay(wait, query.signal);
        }
      }
      if (!response) throw new SecurityEventProviderError('PROVIDER_UNAVAILABLE', 'readPage', true);
      if (Buffer.byteLength(JSON.stringify(response)) > this.options.maximumResponseBytes)
        throw new SecurityEventProviderError('PROVIDER_RESPONSE_INVALID', 'readPage', false);
      const hits = response.hits?.hits;
      if (!Array.isArray(hits) || hits.length > query.pageSize + 1)
        throw new SecurityEventProviderError('PROVIDER_RESPONSE_INVALID', 'readPage', false);
      const hasMore = hits.length > query.pageSize;
      const selected = hits.slice(0, query.pageSize);
      const items: ProviderRecord[] = [];
      for (const hit of selected) {
        const raw = jsonObject(hit._source);
        const sort = hit.sort;
        if (
          !raw ||
          typeof hit._id !== 'string' ||
          !Array.isArray(sort) ||
          sort.length !== 2 ||
          typeof sort[0] !== 'string' ||
          typeof sort[1] !== 'string'
        )
          throw new SecurityEventProviderError('PROVIDER_RESPONSE_INVALID', 'readPage', false);
        const timestamp = raw['timestamp'];
        if (
          typeof timestamp !== 'string' ||
          !rfc3339.test(timestamp) ||
          !Number.isFinite(Date.parse(timestamp))
        )
          throw new SecurityEventProviderError('PROVIDER_RESPONSE_INVALID', 'readPage', false);
        items.push({
          sourceRecordId: hit._id,
          dataset: query.dataset,
          occurredAt: timestamp,
          collectedAt: readAt,
          raw,
          metadata: {},
        });
      }
      const lastSort = selected.at(-1)?.sort;
      const nextCursor =
        hasMore && Array.isArray(lastSort)
          ? makeCursor(
              {
                v: 1,
                sourceId: query.sourceId,
                dataset: query.dataset,
                from: query.from,
                to: query.to,
                pageSize: query.pageSize,
                sort: lastSort as readonly JsonValue[],
                exp: this.#now() + (this.options.cursorTtlMs ?? 300_000),
              },
              this.options.cursorSecret,
            )
          : undefined;
      const result = { items, hasMore, readAt, ...(nextCursor ? { nextCursor } : {}) };
      this.options.telemetry?.record({
        connector: 'wazuh',
        operation: 'search_security_events',
        result: 'success',
        durationMs: Math.max(0, this.#now() - Date.parse(readAt)),
      });
      return result;
    } catch (error) {
      const mapped =
        error instanceof SecurityEventProviderError ? error : errorFrom(error, 'readPage');
      this.options.telemetry?.record({
        connector: 'wazuh',
        operation: 'search_security_events',
        result: 'failure',
        errorClass: mapped.code,
        durationMs: Math.max(0, this.#now() - Date.parse(readAt)),
      });
      throw mapped;
    }
  }

  public async close(): Promise<void> {
    await this.options.client.close();
  }
}
