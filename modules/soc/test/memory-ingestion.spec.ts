import { describe, expect, it } from 'vitest';

import { InMemoryIngestionState } from '../src/memory-ingestion.js';

describe('InMemoryIngestionState continuation checkpoints', () => {
  it('resumes and clears a fixed provider window only for the active fenced claim', async () => {
    const state = new InMemoryIngestionState();
    const key = { tenantId: 'tenant-test', sourceId: 'wazuh-indexer', dataset: 'alerts' };
    const now = new Date('2026-11-13T12:00:00.000Z');
    const continuation = {
      from: new Date('2026-11-13T11:58:00.000Z'),
      to: new Date('2026-11-13T12:00:00.000Z'),
      cursor: '["2026-11-13T11:59:00.000Z","event-7"]',
    };
    const first = await state.claimCursor(key, now, 60_000);
    expect(first).toBeDefined();
    expect(first?.continuation).toBeNull();
    await expect(
      state.saveContinuation(first!, { ...continuation, to: continuation.from, cursor: '' }, now),
    ).rejects.toThrow('INGESTION_CURSOR_CONTINUATION_INVALID');
    expect(await state.saveContinuation(first!, continuation, now)).toBe(true);
    await state.releaseCursor(first!);

    const resumed = await state.claimCursor(key, now, 60_000);
    expect(resumed?.continuation).toEqual(continuation);
    expect(await state.saveContinuation(first!, null, now)).toBe(false);
    expect(await state.saveContinuation(resumed!, null, now)).toBe(true);
    await state.releaseCursor(resumed!);

    const cleared = await state.claimCursor(key, now, 60_000);
    expect(cleared?.continuation).toBeNull();
    await state.releaseCursor(cleared!);
  });
});
