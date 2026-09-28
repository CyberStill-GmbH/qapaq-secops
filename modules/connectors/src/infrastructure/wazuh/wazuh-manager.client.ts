import { request as httpsRequest, type RequestOptions } from 'node:https';
import { SecurityEventProviderError } from '../../application/security-event-provider.js';

export interface WazuhManagerClientOptions {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly certificateAuthority: string;
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly maximumResponseBytes: number;
  readonly now?: () => number;
}

export interface WazuhManagerHealth {
  readonly status: 'healthy';
  readonly version?: string;
}

interface JsonResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

export class WazuhManagerClient {
  readonly #base: URL;
  readonly #now: () => number;
  #token: string | undefined;
  #tokenExpiresAt = 0;
  #tokenFlight: Promise<string> | undefined;

  public constructor(private readonly options: WazuhManagerClientOptions) {
    try {
      this.#base = new URL(options.baseUrl);
      if (
        this.#base.protocol !== 'https:' ||
        this.#base.username ||
        this.#base.password ||
        !options.certificateAuthority.trim() ||
        options.username === '' ||
        options.password === ''
      )
        throw new Error('invalid');
    } catch {
      throw new SecurityEventProviderError('PROVIDER_CONFIGURATION_INVALID', 'health', false);
    }
    this.#now = options.now ?? Date.now;
  }

  async #request(
    path: string,
    method: 'GET' | 'POST',
    authorization?: string,
    signal?: AbortSignal,
  ): Promise<JsonResponse> {
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const url = new URL(path, this.#base);
    const requestOptions: RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method,
      ca: this.options.certificateAuthority,
      rejectUnauthorized: true,
      headers: {
        accept: 'application/json',
        ...(authorization ? { authorization } : {}),
      },
    };
    return new Promise((resolve, reject) => {
      const request = httpsRequest(requestOptions, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > this.options.maximumResponseBytes) {
            request.destroy(new Error('response limit exceeded'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      });
      const abort = () =>
        request.destroy(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      signal?.addEventListener('abort', abort, { once: true });
      request.on('socket', (socket) => {
        if (!socket.connecting) return;
        const timer = setTimeout(
          () =>
            request.destroy(Object.assign(new Error('connect timeout'), { name: 'TimeoutError' })),
          this.options.connectTimeoutMs,
        );
        socket.once('secureConnect', () => clearTimeout(timer));
        socket.once('error', () => clearTimeout(timer));
      });
      request.setTimeout(this.options.requestTimeoutMs, () =>
        request.destroy(Object.assign(new Error('request timeout'), { name: 'TimeoutError' })),
      );
      request.on('error', reject);
      request.once('close', () => signal?.removeEventListener('abort', abort));
      request.end();
    });
  }

  async #getToken(): Promise<string> {
    if (this.#token && this.#now() < this.#tokenExpiresAt - 30_000) return this.#token;
    if (this.#tokenFlight) return this.#tokenFlight;
    this.#tokenFlight = (async () => {
      let response: JsonResponse;
      try {
        response = await this.#request(
          '/security/user/authenticate?raw=true',
          'POST',
          `Basic ${Buffer.from(`${this.options.username}:${this.options.password}`).toString('base64')}`,
        );
      } catch (error) {
        throw this.#mapError(error, 'health');
      }
      if (response.statusCode === 401)
        throw new SecurityEventProviderError('PROVIDER_AUTHENTICATION_FAILED', 'health', false);
      if (response.statusCode === 403)
        throw new SecurityEventProviderError('PROVIDER_AUTHORIZATION_DENIED', 'health', false);
      if (response.statusCode < 200 || response.statusCode >= 300)
        throw new SecurityEventProviderError(
          'PROVIDER_UNAVAILABLE',
          'health',
          response.statusCode >= 500,
        );
      const token = response.body.trim().replace(/^"|"$/gu, '');
      const parts = token.split('.');
      if (parts.length !== 3 || token.length > 16_384)
        throw new SecurityEventProviderError('PROVIDER_RESPONSE_INVALID', 'health', false);
      try {
        const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
          exp?: unknown;
        };
        if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp))
          throw new Error('invalid');
        this.#tokenExpiresAt = payload.exp * 1_000;
      } catch {
        throw new SecurityEventProviderError('PROVIDER_RESPONSE_INVALID', 'health', false);
      }
      this.#token = token;
      return token;
    })().finally(() => {
      this.#tokenFlight = undefined;
    });
    return this.#tokenFlight;
  }

  #mapError(error: unknown, operation: 'health' | 'readPage'): SecurityEventProviderError {
    const candidate = error as { code?: string; name?: string };
    if (candidate.name === 'AbortError')
      return new SecurityEventProviderError('PROVIDER_TIMEOUT', operation, false);
    if (candidate.name === 'TimeoutError')
      return new SecurityEventProviderError('PROVIDER_TIMEOUT', operation, true);
    if (
      candidate.code?.startsWith('ERR_TLS') ||
      candidate.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      candidate.code === 'CERT_HAS_EXPIRED'
    )
      return new SecurityEventProviderError('PROVIDER_TLS_VALIDATION_FAILED', operation, false);
    return new SecurityEventProviderError('PROVIDER_UNAVAILABLE', operation, true);
  }

  public async health(signal?: AbortSignal): Promise<WazuhManagerHealth> {
    const token = await this.#getToken();
    let response: JsonResponse;
    try {
      response = await this.#request('/manager/status', 'GET', `Bearer ${token}`, signal);
    } catch (error) {
      throw this.#mapError(error, 'health');
    }
    if (response.statusCode === 401) {
      this.#token = undefined;
      this.#tokenExpiresAt = 0;
      throw new SecurityEventProviderError('PROVIDER_AUTHENTICATION_FAILED', 'health', false);
    }
    if (response.statusCode === 403)
      throw new SecurityEventProviderError('PROVIDER_AUTHORIZATION_DENIED', 'health', false);
    if (response.statusCode < 200 || response.statusCode >= 300)
      throw new SecurityEventProviderError(
        'PROVIDER_UNAVAILABLE',
        'health',
        response.statusCode >= 500,
      );
    try {
      const parsed = JSON.parse(response.body) as {
        data?: { affected_items?: readonly { version?: unknown }[] };
      };
      if (!parsed || typeof parsed !== 'object') throw new Error('invalid');
      const version = parsed.data?.affected_items?.[0]?.version;
      return {
        status: 'healthy',
        ...(typeof version === 'string' ? { version: version.slice(0, 64) } : {}),
      };
    } catch {
      throw new SecurityEventProviderError('PROVIDER_RESPONSE_INVALID', 'health', false);
    }
  }
}
