import { randomUUID } from 'node:crypto';
import type { WazuhSearchResponse } from './wazuh-security-event.provider.js';

export const WAZUH_GATEWAY_ROUTES = Object.freeze({
  health: '/wazuh/_cluster/health',
  search: '/wazuh/_search',
} as const);

export interface WazuhGatewayClientOptions {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly requestTimeoutMs: number;
  readonly maximumResponseBytes: number;
  readonly allowInsecureLocalhost?: boolean;
  readonly fetch?: typeof globalThis.fetch;
}

export interface WazuhGatewayErrorShape {
  readonly statusCode?: number;
  readonly code?: string;
  readonly retryAfter?: string;
}

export class WazuhGatewayError extends Error {
  public constructor(
    public readonly statusCode?: number,
    public readonly code?: string,
    public readonly retryAfter?: string,
  ) {
    super('Wazuh gateway request failed');
    this.name = 'WazuhGatewayError';
  }
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes)
    throw new WazuhGatewayError(undefined, 'RESPONSE_TOO_LARGE');
  if (!response.body) throw new WazuhGatewayError(undefined, 'MALFORMED_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new WazuhGatewayError(undefined, 'RESPONSE_TOO_LARGE');
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
    throw new WazuhGatewayError(undefined, 'MALFORMED_RESPONSE');
  }
}

/** HTTP-only client for the two read-only routes allowlisted by C-28. */
export class WazuhGatewayClient {
  readonly #baseUrl: URL;
  readonly #fetch: typeof globalThis.fetch;

  public constructor(private readonly options: WazuhGatewayClientOptions) {
    try {
      this.#baseUrl = new URL(options.baseUrl);
      const localHttp =
        options.allowInsecureLocalhost === true &&
        this.#baseUrl.protocol === 'http:' &&
        isLoopback(this.#baseUrl.hostname);
      if (
        (this.#baseUrl.protocol !== 'https:' && !localHttp) ||
        this.#baseUrl.username !== '' ||
        this.#baseUrl.password !== '' ||
        this.#baseUrl.pathname !== '/' ||
        this.#baseUrl.search !== '' ||
        this.#baseUrl.hash !== '' ||
        !options.accessToken.trim() ||
        !Number.isInteger(options.requestTimeoutMs) ||
        options.requestTimeoutMs < 1 ||
        !Number.isInteger(options.maximumResponseBytes) ||
        options.maximumResponseBytes < 1_024
      ) {
        throw new Error('invalid');
      }
    } catch {
      throw new WazuhGatewayError(undefined, 'CONFIGURATION_INVALID');
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public async health(signal?: AbortSignal): Promise<{ readonly status: string }> {
    return (await this.#request(WAZUH_GATEWAY_ROUTES.health, 'GET', undefined, signal)) as {
      readonly status: string;
    };
  }

  public async search(
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<WazuhSearchResponse> {
    return (await this.#request(
      WAZUH_GATEWAY_ROUTES.search,
      'POST',
      body,
      signal,
    )) as WazuhSearchResponse;
  }

  public async close(): Promise<void> {
    // fetch owns connection pooling; the adapter has no direct backend resource to close.
  }

  async #request(
    route: string,
    method: 'GET' | 'POST',
    body?: Readonly<Record<string, unknown>>,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DOMException('Timed out', 'TimeoutError')),
      this.options.requestTimeoutMs,
    );
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout.signal]) : timeout.signal;
    try {
      const response = await this.#fetch(new URL(route, this.#baseUrl), {
        method,
        headers: {
          authorization: `Bearer ${this.options.accessToken}`,
          'x-request-id': randomUUID(),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
      });
      if (!response.ok) {
        throw new WazuhGatewayError(
          response.status,
          'HTTP_ERROR',
          response.headers.get('retry-after') ?? undefined,
        );
      }
      return await readBoundedJson(response, this.options.maximumResponseBytes);
    } catch (error) {
      if (error instanceof WazuhGatewayError) throw error;
      if (signal.aborted) {
        const code = callerSignal?.aborted ? 'REQUEST_CANCELLED' : 'REQUEST_TIMEOUT';
        throw new WazuhGatewayError(undefined, code);
      }
      const code =
        (error as { code?: string; cause?: { code?: string } }).code ??
        (error as { cause?: { code?: string } }).cause?.code;
      throw new WazuhGatewayError(undefined, code ?? 'NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
    }
  }
}
