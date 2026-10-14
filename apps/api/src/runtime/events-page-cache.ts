import { createHash } from 'node:crypto';
import type { EventsReadResult } from './events-reader.js';

export interface RedisEventsPageClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiryMode: 'EX', ttlSeconds: number): Promise<'OK' | null>;
  del(key: string): Promise<number>;
}

export interface EventsPageCache {
  get(key: string): Promise<EventsReadResult | undefined>;
  set(key: string, value: EventsReadResult, ttlSeconds: number): Promise<void>;
}

/** TTL deliberadamente breve: la caché reduce lecturas repetidas; Wazuh sigue siendo la fuente. */
export const EVENTS_PAGE_CACHE_TTL_SECONDS = 5;

export interface EventsPageCacheKeyInput {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly capabilities: ReadonlySet<string>;
  readonly from: string;
  readonly to: string;
  readonly pageSize: number;
  readonly filters: object;
  readonly cursor?: string;
}

/** Nunca incluye identidad, filtros ni cursores sin hash en la clave visible de Redis. */
export function eventsPageCacheKey(input: EventsPageCacheKeyInput): string {
  const canonical = JSON.stringify({
    tenantId: input.tenantId,
    subjectId: input.subjectId,
    capabilities: [...input.capabilities].sort(),
    from: input.from,
    to: input.to,
    pageSize: input.pageSize,
    filters: input.filters,
    cursor: input.cursor ?? null,
  });
  return `qapaq:events:v1:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * Redis es opcional en el camino de lectura: caída, respuesta corrupta o timeout producen una
 * lectura normal del Indexer y una escritura best-effort, sin cambiar disponibilidad ni datos.
 */
export async function readThroughEventsPage(
  cache: EventsPageCache | undefined,
  key: string,
  read: () => Promise<EventsReadResult>,
): Promise<EventsReadResult> {
  if (cache) {
    try {
      const cached = await cache.get(key);
      if (cached) return cached;
    } catch {
      // El Indexer es la fuente; un fallo de la caché no debe ocultarlo.
    }
  }
  const result = await read();
  if (!cache) return result;

  // Never persist or return provider documents through this adapter. Raw-capable callers bypass
  // it at the controller boundary and read directly from the Indexer.
  const cacheable: EventsReadResult = {
    items: result.items.map(({ event }) => ({ event })),
    unparsedCount: result.unparsedCount,
    nextCursor: result.nextCursor,
  };
  try {
    // Cache writes are best-effort and must not serialize the Indexer response path.
    void cache.set(key, cacheable, EVENTS_PAGE_CACHE_TTL_SECONDS).catch(() => undefined);
  } catch {
    // Best-effort; la siguiente lectura vuelve al Indexer.
  }
  return cacheable;
}

/** Adapter Redis sin acoplar el contrato de lectura al cliente ioredis. */
export class RedisEventsPageCache implements EventsPageCache {
  public constructor(private readonly redis: RedisEventsPageClient) {}

  public async get(key: string): Promise<EventsReadResult | undefined> {
    const encoded = await this.redis.get(key);
    if (!encoded) return undefined;
    try {
      const value = JSON.parse(encoded) as EventsReadResult;
      if (
        !Array.isArray(value.items) ||
        !Number.isInteger(value.unparsedCount) ||
        value.items.some((item) => !item || typeof item !== 'object' || 'raw' in item)
      ) {
        await this.redis.del(key);
        return undefined;
      }
      return value;
    } catch {
      await this.redis.del(key);
      return undefined;
    }
  }

  public async set(key: string, value: EventsReadResult, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }
}
