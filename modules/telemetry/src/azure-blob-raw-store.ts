import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { RawObjectIntegrityError, type DurableRawStore } from './admission.js';
import type { AzureAccessTokenSource } from './azure-managed-identity-token.js';
import { rawObjectKey } from './raw-object-key.js';

/** Audience for Blob Data RBAC tokens (Storage Blob Data Contributor on the raw container). */
export const AZURE_BLOB_TOKEN_RESOURCE = 'https://storage.azure.com/';

const BLOB_API_VERSION = '2024-11-04';
const ACCOUNT_HOST = /^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/u;
const CONTAINER_NAME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export type AzureBlobStorageErrorCode =
  'NOT_FOUND' | 'ACCESS_DENIED' | 'UNAVAILABLE' | 'REQUEST_FAILED';

/** Carries only a code and HTTP status: Blob error bodies and URLs never leave the adapter. */
export class AzureBlobStorageError extends Error {
  constructor(
    readonly code: AzureBlobStorageErrorCode,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(`Azure Blob request failed: ${code}`, options);
    this.name = 'AzureBlobStorageError';
  }
}

export interface AzureBlobRawStoreOptions {
  /** `https://<account>.blob.core.windows.net`; resolved privately through the Blob private endpoint. */
  readonly accountUrl: string;
  readonly container: string;
  /** Managed Identity token for {@link AZURE_BLOB_TOKEN_RESOURCE}; never an account key or SAS. */
  readonly tokenSource: AzureAccessTokenSource;
  readonly requestTimeoutMs?: number;
  /** Total attempts per request, including the first one (1â€“6). */
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly fetch?: typeof fetch;
}

interface BlobHead {
  readonly sha256: string | null;
  readonly size: number | null;
  readonly version: string | null;
}

function statusError(status: number): AzureBlobStorageError {
  if (status === 404) return new AzureBlobStorageError('NOT_FOUND', status);
  if (status === 401 || status === 403) return new AzureBlobStorageError('ACCESS_DENIED', status);
  if (RETRYABLE_STATUS.has(status)) return new AzureBlobStorageError('UNAVAILABLE', status);
  return new AzureBlobStorageError('REQUEST_FAILED', status);
}

function parseSize(value: string | null): number | null {
  return value !== null && /^\d{1,15}$/u.test(value) ? Number(value) : null;
}

/**
 * Azure Blob adapter for the immutable raw-object port. Writes are create-only
 * (`If-None-Match: *`); an existing object is accepted only when its SHA-256 metadata and size
 * match, exactly like {@link S3RawStore}. It never deletes or overwrites: retention comes from
 * account versioning/soft delete provisioned by Terraform, not from this adapter.
 */
export class AzureBlobRawStore implements DurableRawStore {
  readonly #containerUrl: URL;
  readonly #tokenSource: AzureAccessTokenSource;
  readonly #requestTimeoutMs: number;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: AzureBlobRawStoreOptions) {
    let account: URL;
    try {
      account = new URL(options.accountUrl);
    } catch (error) {
      throw new Error('Invalid Azure Blob account URL', { cause: error });
    }
    if (
      account.protocol !== 'https:' ||
      !ACCOUNT_HOST.test(account.hostname) ||
      account.port !== '' ||
      account.username !== '' ||
      account.password !== '' ||
      (account.pathname !== '/' && account.pathname !== '') ||
      account.search !== '' ||
      account.hash !== ''
    )
      throw new Error('Azure Blob requires an HTTPS account URL without path, SAS or credentials');
    if (!CONTAINER_NAME.test(options.container)) throw new Error('Invalid Azure Blob container');
    const maxAttempts = options.maxAttempts ?? 2;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 6)
      throw new Error('Azure Blob maxAttempts must be between 1 and 6');
    this.#containerUrl = new URL(`/${options.container}/`, account);
    this.#tokenSource = options.tokenSource;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#maxAttempts = maxAttempts;
    this.#retryDelayMs = options.retryDelayMs ?? 200;
    this.#fetch = options.fetch ?? fetch;
  }

  async putIfAbsent(
    ref: string,
    bytes: Uint8Array,
    sha256: string,
  ): Promise<{ version?: string | null }> {
    if (!SHA256_HEX.test(sha256)) throw new Error('Invalid raw object digest');
    const key = rawObjectKey(ref);
    const existing = await this.#head(key);
    if (existing) return this.#verify(existing, sha256, bytes.byteLength);

    const response = await this.#send('PUT', key, {
      body: new Uint8Array(bytes),
      headers: {
        'content-type': 'application/json',
        'content-md5': createHash('md5').update(bytes).digest('base64'),
        'if-none-match': '*',
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-meta-sha256': sha256,
      },
      // 409/412 mean another writer created the object first; it is then verified below.
      accept: [201, 409, 412],
    });
    if (response.status === 201) {
      const version = response.headers.get('x-ms-version-id');
      return version === null ? {} : { version };
    }
    const raced = await this.#head(key);
    if (!raced) throw new AzureBlobStorageError('REQUEST_FAILED', response.status);
    return this.#verify(raced, sha256, bytes.byteLength);
  }

  async get(ref: string, maximumBytes: number): Promise<Uint8Array> {
    const response = await this.#send('GET', rawObjectKey(ref), { accept: [200] });
    const size = parseSize(response.headers.get('content-length'));
    if (!response.body || size === null || size > maximumBytes) {
      await response.body?.cancel();
      throw new RawObjectIntegrityError('Raw object missing or exceeds configured limit');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maximumBytes) {
          await reader.cancel();
          throw new RawObjectIntegrityError('Raw object exceeds configured limit');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return new Uint8Array(Buffer.concat(chunks, total));
  }

  async #head(key: string): Promise<BlobHead | null> {
    const response = await this.#send('HEAD', key, { accept: [200, 404] });
    if (response.status === 404) return null;
    return {
      sha256: response.headers.get('x-ms-meta-sha256'),
      size: parseSize(response.headers.get('content-length')),
      version: response.headers.get('x-ms-version-id'),
    };
  }

  #verify(head: BlobHead, sha256: string, size: number): { version?: string | null } {
    if (head.sha256 !== sha256 || head.size !== size)
      throw new RawObjectIntegrityError(
        'Existing raw object metadata does not match expected digest/size',
      );
    return head.version === null ? {} : { version: head.version };
  }

  async #send(
    method: 'GET' | 'HEAD' | 'PUT',
    key: string,
    request: {
      readonly accept: readonly number[];
      readonly body?: Uint8Array<ArrayBuffer>;
      readonly headers?: Readonly<Record<string, string>>;
    },
  ): Promise<Response> {
    const url = new URL(key, this.#containerUrl);
    for (let attempt = 1; ; attempt += 1) {
      const signal = AbortSignal.timeout(this.#requestTimeoutMs);
      let response: Response | undefined;
      try {
        const token = await this.#tokenSource.getToken(signal);
        response = await this.#fetch(url, {
          method,
          headers: {
            ...request.headers,
            authorization: `Bearer ${token}`,
            'x-ms-date': new Date().toUTCString(),
            'x-ms-version': BLOB_API_VERSION,
          },
          ...(request.body === undefined ? {} : { body: request.body }),
          signal,
          cache: 'no-store',
          redirect: 'error',
        });
      } catch (error) {
        if (attempt < this.#maxAttempts) {
          await delay(this.#retryDelayMs * attempt);
          continue;
        }
        throw new AzureBlobStorageError('UNAVAILABLE', undefined, { cause: error });
      }
      if (request.accept.includes(response.status)) return response;
      await response.body?.cancel();
      if (RETRYABLE_STATUS.has(response.status) && attempt < this.#maxAttempts) {
        await delay(this.#retryDelayMs * attempt);
        continue;
      }
      throw statusError(response.status);
    }
  }
}
