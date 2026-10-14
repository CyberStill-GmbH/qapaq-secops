import { describe, expect, it, vi } from 'vitest';
import {
  EVENTS_PAGE_CACHE_TTL_SECONDS,
  RedisEventsPageCache,
  eventsPageCacheKey,
  readThroughEventsPage,
  type EventsPageCache,
} from '../src/runtime/events-page-cache.js';
import type { EventsReadResult } from '../src/runtime/events-reader.js';

const page: EventsReadResult = {
  items: [{ event: { id: 'event-1' } as never, raw: { document: 'private' } }],
  unparsedCount: 0,
  nextCursor: null,
};

describe('caché efímera de páginas de eventos', () => {
  it('separa tenant, persona, capacidades y query; normaliza el orden de capacidades', () => {
    const base = {
      tenantId: 'tenant-a',
      subjectId: 'user-a',
      capabilities: new Set(['events.read', 'events.read_raw']),
      from: '2026-10-13T00:00:00.000Z',
      to: '2026-10-14T00:00:00.000Z',
      pageSize: 50,
      filters: { severity: ['critical'] },
    };
    expect(eventsPageCacheKey(base)).toBe(
      eventsPageCacheKey({ ...base, capabilities: new Set([...base.capabilities].reverse()) }),
    );
    expect(eventsPageCacheKey(base)).not.toBe(
      eventsPageCacheKey({ ...base, capabilities: new Set(['events.read']) }),
    );
    expect(eventsPageCacheKey(base)).not.toBe(eventsPageCacheKey({ ...base, subjectId: 'user-b' }));
    expect(eventsPageCacheKey(base)).not.toContain('user-a');
  });

  it('usa la página cacheada y mantiene TTL breve', async () => {
    let saved: EventsReadResult | undefined;
    let ttl = 0;
    const cache: EventsPageCache = {
      get: async () => saved,
      set: async (_key, value, seconds) => {
        saved = value;
        ttl = seconds;
      },
    };
    const read = vi.fn(async () => page);
    const first = await readThroughEventsPage(cache, 'key', read);
    const second = await readThroughEventsPage(cache, 'key', read);
    expect(first.items[0]).toEqual({ event: page.items[0]?.event });
    expect(second).toEqual(first);
    expect(saved?.items[0]).toEqual({ event: page.items[0]?.event });
    expect(saved?.items[0]).not.toHaveProperty('raw');
    expect(read).toHaveBeenCalledTimes(1);
    expect(ttl).toBe(EVENTS_PAGE_CACHE_TTL_SECONDS);
    await Promise.resolve();
  });

  it('la caída de Redis es fail-open y entrega el resultado fresco del Indexer', async () => {
    const cache: EventsPageCache = {
      get: async () => {
        throw new Error('redis offline');
      },
      set: async () => {
        throw new Error('redis offline');
      },
    };
    const read = vi.fn(async () => page);
    await expect(readThroughEventsPage(cache, 'key', read)).resolves.toEqual({
      items: [{ event: page.items[0]!.event }],
      unparsedCount: page.unparsedCount,
      nextCursor: page.nextCursor,
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('no espera la escritura best-effort antes de responder', async () => {
    let completeWrite!: () => void;
    const write = new Promise<void>((resolve) => {
      completeWrite = resolve;
    });
    const cache: EventsPageCache = {
      get: async () => undefined,
      set: async () => write,
    };
    const read = vi.fn(async () => page);
    await expect(readThroughEventsPage(cache, 'key', read)).resolves.toMatchObject({
      unparsedCount: 0,
    });
    expect(read).toHaveBeenCalledOnce();
    completeWrite();
  });

  it('borra el JSON corrupto antes de consultar la fuente', async () => {
    const del = vi.fn(async () => 1);
    const redis = {
      get: async () => '{broken',
      del,
      set: async () => 'OK',
    } as unknown as ConstructorParameters<typeof RedisEventsPageCache>[0];
    const cache = new RedisEventsPageCache(redis);
    await expect(cache.get('key')).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledWith('key');
  });
});
