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
    search: vi.fn(async (options: { body: Readonly<Record<string, unknown>> }) => {
      const range = (options.body['query'] as { range: { timestamp: { gte: string } } }).range;
      if (range.timestamp.gte === '2026-09-24T00:00:00.000Z')
        return { hits: { hits: [] } } as WazuhSearchResponse;
      const after = options.body['search_after'] as readonly unknown[] | undefined;
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
      allowedIndices: ['wazuh-alerts-*'],
      index: 'wazuh-alerts-*',
      maximumPageSize: 10,
      maximumResponseBytes: 1_000_000,
      retryLimit,
      cursorSecret: SECRET,
      managerClient: { health: vi.fn(async () => ({ status: 'healthy' as const })) },
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

  it('builds a read-only bounded search against the configured index', async () => {
    await instance.readPage(QUERY);
    expect(client.search).toHaveBeenCalledWith(
      expect.objectContaining({
        index: 'wazuh-alerts-*',
        body: expect.objectContaining({
          size: 2,
          query: { range: { timestamp: { gte: QUERY.from, lte: QUERY.to } } },
        }),
      }),
    );
    expect(client.search.mock.calls[0]?.[0]).not.toHaveProperty('method');
  });

  it('creates an opaque signed cursor and continues via search_after', async () => {
    const first = await instance.readPage(QUERY);
    expect(first.nextCursor).toBeTruthy();
    expect(first.nextCursor).not.toContain('evt-1');
    client.search.mockResolvedValueOnce({ hits: { hits: [hit('second', QUERY.from, 'evt-2')] } });
    const second = await instance.readPage({ ...QUERY, cursor: first.nextCursor });
    expect(client.search).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ search_after: [QUERY.from, 'evt-1'] }),
      }),
    );
    expect(second.items[0]?.sourceRecordId).toBe('second');
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

  it('rejects unconfigured datasets and indices before network access', async () => {
    await expect(instance.readPage({ ...QUERY, dataset: 'other' })).rejects.toMatchObject({
      code: 'PROVIDER_QUERY_REJECTED',
    });
    expect(
      () =>
        new WazuhSecurityEventProvider({
          sourceId: 'lab',
          allowedDatasets: ['wazuh-alerts'],
          allowedIndices: ['other-*'],
          index: 'wazuh-alerts-*',
          maximumPageSize: 10,
          maximumResponseBytes: 1_000_000,
          cursorSecret: SECRET,
          managerClient: { health: vi.fn(async () => ({ status: 'healthy' as const })) },
          client,
        }),
    ).toThrow(SecurityEventProviderError);
    expect(client.search).not.toHaveBeenCalled();
  });

  it('closes the underlying client', async () => {
    await instance.close();
    expect(client.close).toHaveBeenCalledOnce();
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
});
