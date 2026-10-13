import { describe, expect, it, vi } from 'vitest';
import {
  WazuhGatewayClient,
  WAZUH_GATEWAY_ROUTES,
} from '../src/infrastructure/wazuh/wazuh-gateway.client.js';
import {
  WazuhSecurityEventProvider,
  type WazuhReadClient,
} from '../src/infrastructure/wazuh/wazuh-security-event.provider.js';

const TOKEN = 'synthetic-gateway-token-not-a-secret';
const QUERY = {
  sourceId: 'lab',
  dataset: 'wazuh-alerts',
  from: '2026-09-25T00:00:00.000Z',
  to: '2026-09-25T01:00:00.000Z',
  pageSize: 1,
} as const;

function gateway(fetchImplementation: typeof fetch, requestTimeoutMs = 100) {
  return new WazuhGatewayClient({
    baseUrl: 'http://127.0.0.1:18080',
    accessToken: TOKEN,
    requestTimeoutMs,
    maximumResponseBytes: 10_000,
    allowInsecureLocalhost: true,
    fetch: fetchImplementation,
  });
}

function providerWithSearchFailure(error: unknown) {
  const client: WazuhReadClient = {
    health: async () => ({ status: 'green' }),
    search: async () => Promise.reject(error),
    close: async () => undefined,
  };
  return new WazuhSecurityEventProvider({
    sourceId: 'lab',
    allowedDatasets: ['wazuh-alerts'],
    maximumPageSize: 10,
    maximumResponseBytes: 10_000,
    retryLimit: 0,
    cursorSecret: 'cursor-signing-secret-for-tests-0123456789',
    client,
  });
}

describe('WazuhGatewayClient', () => {
  it('uses only the C-28 allowlisted method and routes with bearer authentication', async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname === WAZUH_GATEWAY_ROUTES.health)
        return new Response('{"status":"green"}', { status: 200 });
      return new Response('{"hits":{"hits":[]}}', { status: 200 });
    });
    const client = gateway(request);
    await client.health();
    await client.search({ size: 1 });
    expect(request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ pathname: '/wazuh/_cluster/health' }),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }),
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pathname: '/wazuh/_search' }),
      expect.objectContaining({ method: 'POST', body: '{"size":1}' }),
    );
  });

  it.each([
    [400, 'PROVIDER_QUERY_REJECTED'],
    [401, 'PROVIDER_AUTHENTICATION_FAILED'],
    [403, 'PROVIDER_AUTHORIZATION_DENIED'],
    [500, 'PROVIDER_UPSTREAM_SERVER_ERROR'],
    [502, 'PROVIDER_UPSTREAM_UNAVAILABLE'],
    [503, 'PROVIDER_UPSTREAM_UNAVAILABLE'],
    [504, 'PROVIDER_UPSTREAM_UNAVAILABLE'],
  ])('preserves HTTP %i as %s', async (status, code) => {
    await expect(
      providerWithSearchFailure({ statusCode: status }).readPage(QUERY),
    ).rejects.toMatchObject({ code });
  });

  it('preserves Retry-After on HTTP 429 without an automatic retry storm', async () => {
    const instance = providerWithSearchFailure({ statusCode: 429, retryAfter: '7' });
    await expect(instance.readPage(QUERY)).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
      retryAfterMs: 7_000,
    });
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND'])(
    'maps %s to gateway unavailable',
    async (networkCode) => {
      await expect(
        providerWithSearchFailure({ code: networkCode }).readPage(QUERY),
      ).rejects.toMatchObject({
        code: 'PROVIDER_GATEWAY_UNAVAILABLE',
      });
    },
  );

  it('times out a slow gateway request and can recover on the next request', async () => {
    let calls = 0;
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        });
      }
      return new Response('{"hits":{"hits":[]}}', { status: 200 });
    });
    const client = gateway(request, 10);
    const instance = new WazuhSecurityEventProvider({
      sourceId: 'lab',
      allowedDatasets: ['wazuh-alerts'],
      maximumPageSize: 10,
      maximumResponseBytes: 10_000,
      cursorSecret: 'cursor-signing-secret-for-tests-0123456789',
      client,
    });
    await expect(instance.readPage(QUERY)).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    await expect(instance.readPage(QUERY)).resolves.toMatchObject({ items: [], hasMore: false });
  });

  it('cancels an in-flight request through the caller signal', async () => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
      return new Response('{}');
    });
    const controller = new AbortController();
    const pending = gateway(request, 5_000).search({}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });

  it.each([
    ['not-json', 'PROVIDER_RESPONSE_INVALID'],
    [
      '{"hits":{"hits":[{"_id":"1","_source":{"timestamp":7},"sort":["2026-09-25T00:00:00.000Z","1"]}]}}',
      'PROVIDER_RESPONSE_INVALID',
    ],
  ])('rejects malformed or contract-invalid upstream content', async (body, code) => {
    const request = vi.fn<typeof fetch>(async () => new Response(body, { status: 200 }));
    const client = gateway(request);
    const instance = new WazuhSecurityEventProvider({
      sourceId: 'lab',
      allowedDatasets: ['wazuh-alerts'],
      maximumPageSize: 10,
      maximumResponseBytes: 10_000,
      cursorSecret: 'cursor-signing-secret-for-tests-0123456789',
      client,
    });
    await expect(instance.readPage(QUERY)).rejects.toMatchObject({ code });
  });

  it('rejects a response above the configured byte limit', async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ padding: 'x'.repeat(2_000) }), { status: 200 }),
    );
    const client = new WazuhGatewayClient({
      baseUrl: 'http://127.0.0.1:18080',
      accessToken: TOKEN,
      requestTimeoutMs: 100,
      maximumResponseBytes: 1_024,
      allowInsecureLocalhost: true,
      fetch: request,
    });
    const instance = new WazuhSecurityEventProvider({
      sourceId: 'lab',
      allowedDatasets: ['wazuh-alerts'],
      maximumPageSize: 10,
      maximumResponseBytes: 1_024,
      cursorSecret: 'cursor-signing-secret-for-tests-0123456789',
      client,
    });
    await expect(instance.readPage(QUERY)).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE_INVALID',
    });
  });

  it('rejects unsafe gateway configuration and URL credentials', () => {
    expect(
      () =>
        new WazuhGatewayClient({
          baseUrl: 'https://user:password@gateway.example.test',
          accessToken: TOKEN,
          requestTimeoutMs: 100,
          maximumResponseBytes: 10_000,
        }),
    ).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
    expect(
      () =>
        new WazuhGatewayClient({
          baseUrl: 'http://gateway.example.test',
          accessToken: TOKEN,
          requestTimeoutMs: 100,
          maximumResponseBytes: 10_000,
        }),
    ).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
  });

  it('HTTP privado solo hacia *.qapaq.internal y con opción explícita', () => {
    const base = { accessToken: TOKEN, requestTimeoutMs: 100, maximumResponseBytes: 10_000 };
    expect(
      () =>
        new WazuhGatewayClient({
          ...base,
          baseUrl: 'http://krakend.demo.qapaq.internal:8080',
          allowPrivateServiceHttp: true,
        }),
    ).not.toThrow();
    expect(
      () => new WazuhGatewayClient({ ...base, baseUrl: 'http://krakend.demo.qapaq.internal:8080' }),
    ).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
    expect(
      () =>
        new WazuhGatewayClient({
          ...base,
          baseUrl: 'http://qapaq.internal.example.test',
          allowPrivateServiceHttp: true,
        }),
    ).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
  });

  it('pide el token en cada petición cuando recibe un proveedor', async () => {
    let issued = 0;
    const seen: string[] = [];
    const client = new WazuhGatewayClient({
      baseUrl: 'http://127.0.0.1:18080',
      accessToken: async () => `token-${++issued}`,
      requestTimeoutMs: 100,
      maximumResponseBytes: 10_000,
      allowInsecureLocalhost: true,
      fetch: (async (_url: URL, init: RequestInit) => {
        seen.push((init.headers as Record<string, string>)['authorization']!);
        return new Response(JSON.stringify({ status: 'green' }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await client.health();
    await client.health();
    expect(seen).toEqual(['Bearer token-1', 'Bearer token-2']);
  });
});
