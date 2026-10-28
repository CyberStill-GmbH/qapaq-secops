import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { RawObjectIntegrityError } from '../src/admission.js';
import {
  AZURE_BLOB_TOKEN_RESOURCE,
  AzureBlobRawStore,
  AzureBlobStorageError,
} from '../src/azure-blob-raw-store.js';
import {
  AzureManagedIdentityError,
  createManagedIdentityTokenSource,
} from '../src/azure-managed-identity-token.js';

const REF = 'raw:01890a5d-ac96-774b-bcce-b302099a8057';
const KEY_PATH = '/security-event-raw/raw/v1/01890a5d-ac96-774b-bcce-b302099a8057';
const TOKEN = 'synthetic-mi-token';
const bytes = new TextEncoder().encode('{"event":"synthetic"}');
const sha256 = createHash('sha256').update(bytes).digest('hex');

interface StoredBlob {
  readonly body: Uint8Array;
  readonly sha256: string;
  readonly version: string;
}

/** Minimal Blob service double: create-only PUT, HEAD and GET over an in-memory map. */
function blobService(options: { failures?: number[]; raceOnPut?: StoredBlob } = {}) {
  const blobs = new Map<string, StoredBlob>();
  const failures = [...(options.failures ?? [])];
  const requests: { method: string; path: string; headers: Headers }[] = [];
  let versions = 0;
  const fetchDouble = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    requests.push({ method, path: url.pathname, headers });
    const failure = failures.shift();
    if (failure !== undefined)
      return new Response('<Error>internal detail</Error>', { status: failure });
    const existing = blobs.get(url.pathname);
    if (method === 'HEAD') {
      if (!existing) return new Response(null, { status: 404 });
      return new Response(null, {
        status: 200,
        headers: {
          'content-length': String(existing.body.byteLength),
          'x-ms-meta-sha256': existing.sha256,
          'x-ms-version-id': existing.version,
        },
      });
    }
    if (method === 'PUT') {
      if (options.raceOnPut) blobs.set(url.pathname, options.raceOnPut);
      if (blobs.has(url.pathname) && headers.get('if-none-match') === '*')
        return new Response('<Error>BlobAlreadyExists</Error>', { status: 409 });
      const body = new Uint8Array(init?.body as Uint8Array);
      const md5 = createHash('md5').update(body).digest('base64');
      if (headers.get('content-md5') !== md5) return new Response(null, { status: 400 });
      versions += 1;
      const version = `2026-10-27T00:00:0${versions}.0000000Z`;
      blobs.set(url.pathname, { body, sha256: headers.get('x-ms-meta-sha256') ?? '', version });
      return new Response(null, { status: 201, headers: { 'x-ms-version-id': version } });
    }
    if (!existing) return new Response(null, { status: 404 });
    return new Response(existing.body, {
      status: 200,
      headers: { 'content-length': String(existing.body.byteLength) },
    });
  });
  return { blobs, requests, fetch: fetchDouble as unknown as typeof fetch };
}

function store(service: ReturnType<typeof blobService>, maxAttempts = 2) {
  return new AzureBlobRawStore({
    accountUrl: 'https://stqapaqevidence.blob.core.windows.net',
    container: 'security-event-raw',
    tokenSource: { getToken: async () => TOKEN },
    fetch: service.fetch,
    maxAttempts,
    retryDelayMs: 1,
  });
}

describe('AzureBlobRawStore', () => {
  it('creates once with Managed Identity bearer auth and create-only semantics', async () => {
    const service = blobService();
    const result = await store(service).putIfAbsent(REF, bytes, sha256);

    expect(result.version).toMatch(/^2026-10-27T/u);
    const put = service.requests.find((request) => request.method === 'PUT');
    expect(put?.path).toBe(KEY_PATH);
    expect(put?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(put?.headers.get('if-none-match')).toBe('*');
    expect(put?.headers.get('x-ms-blob-type')).toBe('BlockBlob');
    expect(put?.headers.get('x-ms-version')).toBeTruthy();
    expect(put?.headers.get('x-ms-date')).toBeTruthy();
    expect(service.requests.some((request) => request.method === 'DELETE')).toBe(false);
  });

  it('is idempotent: a repeated put verifies the stored digest and does not write again', async () => {
    const service = blobService();
    const adapter = store(service);
    const first = await adapter.putIfAbsent(REF, bytes, sha256);
    const second = await adapter.putIfAbsent(REF, bytes, sha256);

    expect(second).toEqual(first);
    expect(service.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  });

  it('rejects an existing object whose digest or size differs instead of overwriting it', async () => {
    const service = blobService();
    service.blobs.set(KEY_PATH, { body: new Uint8Array([1, 2]), sha256, version: 'v1' });
    await expect(store(service).putIfAbsent(REF, bytes, sha256)).rejects.toBeInstanceOf(
      RawObjectIntegrityError,
    );
    expect(service.requests.some((request) => request.method === 'PUT')).toBe(false);
  });

  it('resolves a concurrent writer race by verifying the winner', async () => {
    const winner = { body: bytes, sha256, version: 'winner' };
    const service = blobService({ raceOnPut: winner });
    await expect(store(service).putIfAbsent(REF, bytes, sha256)).resolves.toEqual({
      version: 'winner',
    });

    const corrupt = blobService({ raceOnPut: { ...winner, sha256: '0'.repeat(64) } });
    await expect(store(corrupt).putIfAbsent(REF, bytes, sha256)).rejects.toBeInstanceOf(
      RawObjectIntegrityError,
    );
  });

  it('retries transient failures within the attempt budget and hides service bodies', async () => {
    const recovered = blobService({ failures: [503] });
    await expect(store(recovered).putIfAbsent(REF, bytes, sha256)).resolves.toBeDefined();

    const exhausted = blobService({ failures: [503, 503] });
    const error = await store(exhausted)
      .putIfAbsent(REF, bytes, sha256)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AzureBlobStorageError);
    expect(error).toMatchObject({ code: 'UNAVAILABLE', status: 503 });
    expect(String((error as Error).message)).not.toContain('internal detail');
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it('maps RBAC denials without retrying', async () => {
    const service = blobService({ failures: [403] });
    await expect(store(service, 3).putIfAbsent(REF, bytes, sha256)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
      status: 403,
    });
    expect(service.requests).toHaveLength(1);
  });

  it('reads stored bytes within the configured bound', async () => {
    const service = blobService();
    const adapter = store(service);
    await adapter.putIfAbsent(REF, bytes, sha256);

    await expect(adapter.get(REF, 1024)).resolves.toEqual(bytes);
    await expect(adapter.get(REF, bytes.byteLength - 1)).rejects.toBeInstanceOf(
      RawObjectIntegrityError,
    );
    await expect(
      adapter.get('raw:01890a5d-ac96-774b-bcce-b302099a8058', 1024),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects invalid references, digests, cleartext endpoints, SAS URLs and containers', async () => {
    const service = blobService();
    await expect(store(service).putIfAbsent('raw:../../etc', bytes, sha256)).rejects.toThrow(
      /Invalid raw reference/u,
    );
    await expect(store(service).putIfAbsent(REF, bytes, 'not-a-digest')).rejects.toThrow(/digest/u);
    const base = { container: 'security-event-raw', tokenSource: { getToken: async () => TOKEN } };
    for (const accountUrl of [
      'http://stqapaqevidence.blob.core.windows.net',
      'https://stqapaqevidence.blob.core.windows.net/?sv=2024&sig=x',
      'https://objects.example.test',
      'https://user:pass@stqapaqevidence.blob.core.windows.net',
    ])
      expect(() => new AzureBlobRawStore({ ...base, accountUrl })).toThrow();
    expect(
      () =>
        new AzureBlobRawStore({
          ...base,
          accountUrl: 'https://stqapaqevidence.blob.core.windows.net',
          container: '../raw',
        }),
    ).toThrow(/container/u);
  });
});

describe('createManagedIdentityTokenSource', () => {
  const clientId = '00000000-0000-4000-8000-000000000001';

  function imds(body: unknown, status = 200) {
    return vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );
  }

  it('requests the storage audience from IMDS for the user-assigned identity and caches it', async () => {
    const now = 1_800_000_000_000;
    const fetchDouble = imds({
      access_token: TOKEN,
      expires_on: String(now / 1_000 + 3_600),
      token_type: 'Bearer',
    });
    const source = createManagedIdentityTokenSource({
      clientId,
      resource: AZURE_BLOB_TOKEN_RESOURCE,
      fetch: fetchDouble as unknown as typeof fetch,
      now: () => now,
    });
    const signal = AbortSignal.timeout(1_000);
    const [first, second] = await Promise.all([source.getToken(signal), source.getToken(signal)]);
    await source.getToken(signal);

    expect([first, second]).toEqual([TOKEN, TOKEN]);
    expect(fetchDouble).toHaveBeenCalledTimes(1);
    const [url, init] = fetchDouble.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.hostname).toBe('169.254.169.254');
    expect(url.searchParams.get('resource')).toBe(AZURE_BLOB_TOKEN_RESOURCE);
    expect(url.searchParams.get('client_id')).toBe(clientId);
    expect(new Headers(init.headers).get('metadata')).toBe('true');
  });

  it('fails closed on IMDS errors and malformed or expired tokens', async () => {
    const now = 1_800_000_000_000;
    for (const [body, status, code] of [
      [{}, 500, 'TOKEN_UNAVAILABLE'],
      [{ access_token: TOKEN, expires_on: 'soon', token_type: 'Bearer' }, 200, 'TOKEN_INVALID'],
      [
        { access_token: TOKEN, expires_on: String(now / 1_000 - 1), token_type: 'Bearer' },
        200,
        'TOKEN_INVALID',
      ],
      [
        { access_token: TOKEN, expires_on: String(now / 1_000 + 60), token_type: 'MAC' },
        200,
        'TOKEN_INVALID',
      ],
    ] as const) {
      const source = createManagedIdentityTokenSource({
        clientId,
        resource: AZURE_BLOB_TOKEN_RESOURCE,
        fetch: imds(body, status) as unknown as typeof fetch,
        now: () => now,
      });
      const error = await source.getToken(AbortSignal.timeout(1_000)).catch((caught) => caught);
      expect(error).toBeInstanceOf(AzureManagedIdentityError);
      expect(error).toMatchObject({ code });
    }
    expect(() =>
      createManagedIdentityTokenSource({
        clientId: 'not-a-guid',
        resource: AZURE_BLOB_TOKEN_RESOURCE,
      }),
    ).toThrow(/GUID/u);
  });
});
