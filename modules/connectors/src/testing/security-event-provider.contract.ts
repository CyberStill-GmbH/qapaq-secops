import { describe, expect, it } from 'vitest';
import type { EventQuery, SecurityEventProvider } from '../application/security-event-provider.js';

export interface SecurityEventProviderContractHarness {
  readonly createProvider: () => SecurityEventProvider;
  readonly query: EventQuery;
  readonly emptyQuery: EventQuery;
  readonly expiredCursorCase: () => Promise<{
    readonly provider: SecurityEventProvider;
    readonly query: EventQuery;
  }>;
  readonly writesObserved: () => number;
  readonly secretToRedact?: string;
}

/** Portable acceptance suite. Adapter-specific setup supplies deterministic data and an expired cursor. */
export function defineSecurityEventProviderContract(
  harness: SecurityEventProviderContractHarness,
): void {
  describe('SecurityEventProvider contract', () => {
    it('1. exposes coherent capabilities and datasets', async () => {
      const result = await harness.createProvider().capabilities();
      expect(result.providerType.length).toBeGreaterThan(0);
      expect(result.datasets.length).toBeGreaterThan(0);
      expect(result.datasets.every((dataset) => dataset.length > 0)).toBe(true);
      expect(result.maxPageSize).toBeGreaterThan(0);
      expect(result.supportsHealth).toBe(true);
      expect(result.ordering.primaryField).toBeTruthy();
      expect(result.ordering.tieBreaker).toBeTruthy();
    });

    it('2. returns structured health', async () => {
      const result = await harness.createProvider().health();
      expect(['healthy', 'degraded', 'unhealthy']).toContain(result.status);
      expect(Number.isNaN(Date.parse(result.checkedAt))).toBe(false);
      expect(Array.isArray(result.components)).toBe(true);
      expect(result.components.length).toBeGreaterThan(0);
      for (const component of result.components) {
        expect(component.name).toBeTruthy();
        expect(['healthy', 'degraded', 'unhealthy']).toContain(component.status);
        expect(component.code).toBeTruthy();
        expect(component.latencyMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('3. accepts a valid empty page', async () => {
      const result = await harness.createProvider().readPage(harness.emptyQuery);
      expect(result.items).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeUndefined();
    });

    it('4. returns neutral records in stable order', async () => {
      const result = await harness.createProvider().readPage(harness.query);
      expect(result.items.length).toBeGreaterThan(0);
      for (const record of result.items) {
        expect(record.sourceRecordId).toBeTruthy();
        expect(record.dataset).toBe(harness.query.dataset);
        expect(Number.isNaN(Date.parse(record.collectedAt))).toBe(false);
        expect(record.raw).toEqual(expect.any(Object));
        expect(record.metadata).toEqual(expect.any(Object));
        expect(Object.keys(record)).toEqual(
          expect.arrayContaining(['sourceRecordId', 'dataset', 'collectedAt', 'raw', 'metadata']),
        );
      }
      const times = result.items.map((item) => item.occurredAt).filter(Boolean) as string[];
      expect(times).toEqual([...times].sort());
    });

    it('5. gives deterministic results for the same initial query', async () => {
      const provider = harness.createProvider();
      const [first, repeated] = await Promise.all([
        provider.readPage(harness.query),
        provider.readPage(harness.query),
      ]);
      expect(first.items.map((item) => item.sourceRecordId)).toEqual(
        repeated.items.map((item) => item.sourceRecordId),
      );
    });

    it('6. follows nextCursor to a later page without repeating records', async () => {
      const provider = harness.createProvider();
      const first = await provider.readPage(harness.query);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBeTruthy();
      const second = await provider.readPage({ ...harness.query, cursor: first.nextCursor! });
      expect(second.items.length).toBeGreaterThan(0);
      expect(second.items.map((item) => item.sourceRecordId)).not.toEqual(
        first.items.map((item) => item.sourceRecordId),
      );
    });

    it('7. rejects a cursor used with another source', async () => {
      const provider = harness.createProvider();
      const first = await provider.readPage(harness.query);
      await expect(
        provider.readPage({
          ...harness.query,
          sourceId: `${harness.query.sourceId}-other`,
          cursor: first.nextCursor!,
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_CURSOR_INCOMPATIBLE' });
    });

    it('8. rejects a cursor used with another dataset', async () => {
      const provider = harness.createProvider();
      const first = await provider.readPage(harness.query);
      await expect(
        provider.readPage({
          ...harness.query,
          dataset: `${harness.query.dataset}-other`,
          cursor: first.nextCursor!,
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_QUERY_REJECTED' });
    });

    it('9. rejects an altered cursor', async () => {
      const provider = harness.createProvider();
      const first = await provider.readPage(harness.query);
      await expect(
        provider.readPage({ ...harness.query, cursor: `${first.nextCursor}tampered` }),
      ).rejects.toMatchObject({ code: 'PROVIDER_CURSOR_INVALID' });
    });

    it('10. rejects an expired cursor', async () => {
      const expired = await harness.expiredCursorCase();
      await expect(expired.provider.readPage(expired.query)).rejects.toMatchObject({
        code: 'PROVIDER_CURSOR_EXPIRED',
      });
    });

    it('11. rejects page sizes outside provider limits', async () => {
      const provider = harness.createProvider();
      const capabilities = await provider.capabilities();
      await expect(
        provider.readPage({ ...harness.query, pageSize: capabilities.maxPageSize + 1 }),
      ).rejects.toMatchObject({ code: 'PROVIDER_QUERY_REJECTED' });
      await expect(provider.readPage({ ...harness.query, pageSize: 0 })).rejects.toMatchObject({
        code: 'PROVIDER_QUERY_REJECTED',
      });
    });

    it('12. rejects invalid time ranges', async () => {
      await expect(
        harness.createProvider().readPage({
          ...harness.query,
          from: harness.query.to,
          to: harness.query.from,
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_QUERY_REJECTED' });
      await expect(
        harness.createProvider().readPage({ ...harness.query, from: 'yesterday' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_QUERY_REJECTED' });
    });

    it('13. interrupts an already-cancelled operation', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        harness.createProvider().readPage({ ...harness.query, signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    });

    it('14. exposes stable sanitized errors', async () => {
      let error: unknown;
      try {
        await harness.createProvider().readPage({ ...harness.query, pageSize: 0 });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'PROVIDER_QUERY_REJECTED', operation: 'readPage' });
      if (harness.secretToRedact && error instanceof Error)
        expect(error.message).not.toContain(harness.secretToRedact);
    });

    it('15. never exposes provider-specific DTOs as record fields', async () => {
      const result = await harness.createProvider().readPage(harness.query);
      const allowed = ['sourceRecordId', 'dataset', 'occurredAt', 'collectedAt', 'raw', 'metadata'];
      for (const record of result.items)
        expect(Object.keys(record).every((key) => allowed.includes(key))).toBe(true);
    });

    it('16. does not perform writes', async () => {
      const before = harness.writesObserved();
      const provider = harness.createProvider();
      await provider.capabilities();
      await provider.health();
      await provider.readPage(harness.query);
      expect(harness.writesObserved()).toBe(before);
    });

    it('17. reports hasMore and cursor consistently', async () => {
      const result = await harness.createProvider().readPage(harness.query);
      expect(result.hasMore).toBe(Boolean(result.nextCursor));
      expect(result.items.length).toBeLessThanOrEqual(harness.query.pageSize);
    });

    it('18. returns parseable collection timestamps', async () => {
      const result = await harness.createProvider().readPage(harness.query);
      for (const item of result.items) {
        expect(Number.isNaN(Date.parse(item.collectedAt))).toBe(false);
        if (item.occurredAt) expect(Number.isNaN(Date.parse(item.occurredAt))).toBe(false);
      }
      expect(Number.isNaN(Date.parse(result.readAt))).toBe(false);
    });
  });
}
