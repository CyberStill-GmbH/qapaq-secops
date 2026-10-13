import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecurityEventProviderError } from '../src/application/security-event-provider.js';
import {
  WazuhSecurityEventProvider,
  type WazuhReadClient,
  type WazuhSearchResponse,
} from '../src/infrastructure/wazuh/wazuh-security-event.provider.js';
import { defineSecurityEventProviderContract } from '../src/testing/security-event-provider.contract.js';

const SECRET = 'cursor-signing-secret-for-tests-0123456789';
const QUERY = {
  sourceId: 'lab',
  dataset: 'wazuh-alerts',
  from: '2026-09-25T00:00:00.000Z',
  to: '2026-09-25T01:00:00.000Z',
  pageSize: 1,
} as const;
const hit = (id: string, timestamp: string, sortId: string) => ({
  _id: id,
  _source: { timestamp, id: sortId, rule: { id: '1001' } },
  sort: [timestamp, sortId],
});

function createClient(): WazuhReadClient & {
  search: ReturnType<typeof vi.fn>;
  health: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    health: vi.fn(async () => ({ status: 'green' })),
    search: vi.fn(async (body: Readonly<Record<string, unknown>>) => {
      // Con filtros la consulta es un `bool`; sin ellos, el `range` directo.
      const query = body['query'] as {
        range?: { timestamp: { gte: string } };
        bool?: { filter: { range?: { timestamp: { gte: string } } }[] };
      };
      const range = query.range ?? query.bool?.filter[0]?.range;
      if (range?.timestamp.gte === '2026-09-24T00:00:00.000Z')
        return { hits: { hits: [] } } as WazuhSearchResponse;
      const after = body['search_after'] as readonly unknown[] | undefined;
      return {
        hits: {
          hits: after
            ? [hit('second', QUERY.from, 'evt-2')]
            : [hit('first', QUERY.from, 'evt-1'), hit('second', QUERY.from, 'evt-2')],
        },
      } as WazuhSearchResponse;
    }),
    close: vi.fn(async () => undefined),
  };
}

function provider(
  client = createClient(),
  now = () => Date.parse('2026-09-25T02:00:00.000Z'),
  retryLimit = 0,
) {
  return {
    client,
    instance: new WazuhSecurityEventProvider({
      sourceId: 'lab',
      allowedDatasets: ['wazuh-alerts'],
      maximumPageSize: 10,
      maximumResponseBytes: 1_000_000,
      retryLimit,
      cursorSecret: SECRET,
      client,
      now,
    }),
  };
}

describe('WazuhSecurityEventProvider', () => {
  let client: ReturnType<typeof createClient>;
  let instance: WazuhSecurityEventProvider;

  beforeEach(() => {
    ({ client, instance } = provider());
  });

  it('builds a read-only bounded search for the gateway route', async () => {
    await instance.readPage(QUERY);
    expect(client.search).toHaveBeenCalledWith(
      expect.objectContaining({
        size: 2,
        query: { range: { timestamp: { gte: QUERY.from, lte: QUERY.to } } },
      }),
      undefined,
    );
    expect(client.search.mock.calls[0]?.[0]).not.toHaveProperty('script');
  });

  it('creates an opaque signed cursor and continues via search_after', async () => {
    const first = await instance.readPage(QUERY);
    expect(first.nextCursor).toBeTruthy();
    expect(first.nextCursor).not.toContain('evt-1');
    client.search.mockResolvedValueOnce({ hits: { hits: [hit('second', QUERY.from, 'evt-2')] } });
    const second = await instance.readPage({ ...QUERY, cursor: first.nextCursor });
    expect(client.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ search_after: [QUERY.from, 'evt-1'] }),
      undefined,
    );
    expect(second.items[0]?.sourceRecordId).toBe('second');
  });

  it('acepta el orden numérico (epoch ms) que OpenSearch devuelve para campos fecha', async () => {
    const epoch = Date.parse(QUERY.from);
    const numeric = (id: string, sortId: string) => ({
      ...hit(id, QUERY.from, sortId),
      sort: [epoch, sortId],
    });
    client.search.mockResolvedValueOnce({
      hits: { hits: [numeric('first', 'evt-1'), numeric('second', 'evt-2')] },
    });
    const first = await instance.readPage(QUERY);
    expect(first.items[0]?.sourceRecordId).toBe('first');
    client.search.mockResolvedValueOnce({ hits: { hits: [numeric('second', 'evt-2')] } });
    await instance.readPage({ ...QUERY, cursor: first.nextCursor });
    expect(client.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ search_after: [epoch, 'evt-1'] }),
      undefined,
    );
  });

  it('expires cursors and does not treat them as durable checkpoints', async () => {
    const first = await instance.readPage(QUERY);
    const later = provider(client, () => Date.parse('2026-09-25T03:00:00.000Z')).instance;
    await expect(later.readPage({ ...QUERY, cursor: first.nextCursor })).rejects.toMatchObject({
      code: 'PROVIDER_CURSOR_EXPIRED',
    });
  });

  it('retries a transient 503 once according to configured policy', async () => {
    const retryClient = createClient();
    retryClient.search.mockRejectedValueOnce({
      statusCode: 503,
      meta: { statusCode: 503, headers: { 'retry-after': '0' } },
    });
    const retrying = provider(retryClient, undefined, 1).instance;
    await retrying.readPage(QUERY);
    expect(retryClient.search).toHaveBeenCalledTimes(2);
  });

  it('rejects altered cursors without making a request', async () => {
    const first = await instance.readPage(QUERY);
    const cursor = `${first.nextCursor}x`;
    await expect(instance.readPage({ ...QUERY, cursor })).rejects.toMatchObject({
      code: 'PROVIDER_CURSOR_INVALID',
    });
    expect(client.search).toHaveBeenCalledTimes(1);
  });

  it('classifies unauthorized requests without disclosing upstream details', async () => {
    client.search.mockRejectedValueOnce({ statusCode: 403, message: 'secret=do-not-leak' });
    try {
      await instance.readPage(QUERY);
      expect.fail('expected authorization failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'PROVIDER_AUTHORIZATION_DENIED' });
      expect((error as Error).message).not.toContain('do-not-leak');
    }
  });

  it('rejects unconfigured datasets before network access', async () => {
    await expect(instance.readPage({ ...QUERY, dataset: 'other' })).rejects.toMatchObject({
      code: 'PROVIDER_QUERY_REJECTED',
    });
    expect(
      () =>
        new WazuhSecurityEventProvider({
          sourceId: 'lab',
          allowedDatasets: ['wazuh-alerts'],
          maximumPageSize: 10,
          maximumResponseBytes: 1_000_000,
          cursorSecret: 'short',
          client,
        }),
    ).toThrow(SecurityEventProviderError);
    expect(client.search).not.toHaveBeenCalled();
  });

  it('closes the underlying client', async () => {
    await instance.close();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('emits low-cardinality success and failure telemetry without query or token data', async () => {
    const record = vi.fn();
    const observed = new WazuhSecurityEventProvider({
      sourceId: 'lab',
      allowedDatasets: ['wazuh-alerts'],
      maximumPageSize: 10,
      maximumResponseBytes: 1_000_000,
      cursorSecret: SECRET,
      client,
      telemetry: { record },
    });
    await observed.readPage(QUERY);
    client.search.mockRejectedValueOnce({ statusCode: 401 });
    await expect(observed.readPage(QUERY)).rejects.toMatchObject({
      code: 'PROVIDER_AUTHENTICATION_FAILED',
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        connector: 'wazuh',
        operation: 'search_security_events',
        result: 'success',
      }),
    );
    expect(record).toHaveBeenLastCalledWith(
      expect.objectContaining({ result: 'failure', errorClass: 'PROVIDER_AUTHENTICATION_FAILED' }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(record.mock.calls)).not.toContain(QUERY.from);
  });

  describe('portable contract', () => {
    defineSecurityEventProviderContract({
      createProvider: () => provider().instance,
      query: QUERY,
      emptyQuery: { ...QUERY, from: '2026-09-24T00:00:00.000Z', to: '2026-09-24T01:00:00.000Z' },
      expiredCursorCase: async () => {
        const initial = provider();
        const page = await initial.instance.readPage(QUERY);
        return {
          provider: provider(initial.client, () => Date.parse('2026-09-25T03:00:00.000Z')).instance,
          query: { ...QUERY, cursor: page.nextCursor },
        };
      },
      writesObserved: () => 0,
      secretToRedact: SECRET,
    });
  });

  it('compila filtros a bool.filter y ordena descendente cuando se pide', async () => {
    const compile = vi.fn(() => [{ terms: { 'rule.groups': ['office365'] } }]);
    const filtered = new WazuhSecurityEventProvider({
      sourceId: 'lab',
      allowedDatasets: ['wazuh-alerts'],
      maximumPageSize: 10,
      maximumResponseBytes: 1_000_000,
      cursorSecret: SECRET,
      client,
      now: () => Date.parse('2026-09-25T02:00:00.000Z'),
      compileFilters: compile,
    });
    await filtered.readPage({ ...QUERY, filters: { category: ['iam'] }, order: 'desc' });
    expect(client.search).toHaveBeenLastCalledWith(
      expect.objectContaining({
        query: {
          bool: {
            filter: [
              { range: { timestamp: { gte: QUERY.from, lte: QUERY.to } } },
              { terms: { 'rule.groups': ['office365'] } },
            ],
          },
        },
        sort: [{ timestamp: { order: 'desc' } }, { id: { order: 'desc' } }],
      }),
      undefined,
    );
  });

  it('un cursor no sirve con otros filtros u otro orden', async () => {
    const filtered = new WazuhSecurityEventProvider({
      sourceId: 'lab',
      allowedDatasets: ['wazuh-alerts'],
      maximumPageSize: 10,
      maximumResponseBytes: 1_000_000,
      cursorSecret: SECRET,
      client,
      now: () => Date.parse('2026-09-25T02:00:00.000Z'),
      compileFilters: () => [],
    });
    const first = await filtered.readPage({ ...QUERY, filters: { severity: ['high'] } });
    expect(first.nextCursor).toBeTruthy();
    await expect(
      filtered.readPage({ ...QUERY, filters: { severity: ['low'] }, cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CURSOR_INCOMPATIBLE' });
    await expect(
      filtered.readPage({
        ...QUERY,
        filters: { severity: ['high'] },
        order: 'desc',
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CURSOR_INCOMPATIBLE' });
    // Mismos filtros en otro orden de lista: misma huella, el cursor sirve.
    await expect(
      filtered.readPage({ ...QUERY, filters: { severity: ['high'] }, cursor: first.nextCursor }),
    ).resolves.toBeDefined();
  });

  it('sin compilador, o con un filtro que no se puede empujar, rechaza antes de la red', async () => {
    const calls = client.search.mock.calls.length;
    await expect(
      instance.readPage({ ...QUERY, filters: { category: ['iam'] } }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_QUERY_REJECTED',
    });
    expect(client.search.mock.calls.length).toBe(calls);
  });

  it('actividad por stream: agregación acotada sin documentos y respuesta validada', async () => {
    const withField = new WazuhSecurityEventProvider({
      sourceId: 'lab',
      allowedDatasets: ['wazuh-alerts'],
      maximumPageSize: 10,
      maximumResponseBytes: 1_000_000,
      cursorSecret: SECRET,
      client,
      activityField: 'data.office365.Subscription',
    });
    client.search.mockResolvedValueOnce({
      hits: { hits: [] },
      aggregations: {
        streams: {
          buckets: [
            { key: 'Audit.Exchange', doc_count: 7, last: { value: Date.parse(QUERY.to) } },
            { key: 'Audit.General', doc_count: 1, last: { value: null } },
          ],
        },
      },
    });
    const activity = await withField.readActivity({
      sourceId: 'lab',
      dataset: 'wazuh-alerts',
      from: QUERY.from,
      to: QUERY.to,
    });
    expect(activity).toEqual([
      { stream: 'Audit.Exchange', count: 7, lastEventAt: QUERY.to },
      { stream: 'Audit.General', count: 1, lastEventAt: null },
    ]);
    expect(client.search).toHaveBeenLastCalledWith(
      expect.objectContaining({
        size: 0,
        aggs: {
          streams: {
            terms: { field: 'data.office365.Subscription', size: 10 },
            aggs: { last: { max: { field: 'timestamp' } } },
          },
        },
      }),
      undefined,
    );
    client.search.mockResolvedValueOnce({ hits: { hits: [] }, aggregations: { streams: {} } });
    await expect(
      withField.readActivity({
        sourceId: 'lab',
        dataset: 'wazuh-alerts',
        from: QUERY.from,
        to: QUERY.to,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' });
    // Sin campo configurado la actividad no está disponible.
    await expect(
      instance.readActivity({
        sourceId: 'lab',
        dataset: 'wazuh-alerts',
        from: QUERY.from,
        to: QUERY.to,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_QUERY_REJECTED' });
  });
});
