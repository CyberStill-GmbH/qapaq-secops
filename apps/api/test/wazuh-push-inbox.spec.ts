import { describe, expect, it, vi } from 'vitest';

import type {
  ProviderRecord,
  WazuhAlertHintLookupProvider,
  WazuhAlertHintLookup,
} from '@qapaq/connectors';
import type { ClaimedWazuhPushHint, WazuhPushHint, WazuhPushInboxStore } from '@qapaq/soc';
import type { SecurityEvent } from '@qapaq/contracts';

import {
  createWazuhPushInboxPass,
  wazuhPushRetryDelayMs,
} from '../src/runtime/wazuh-push-inbox.js';
import { wazuhRecordToEvent } from '../src/runtime/wazuh-ingestion.js';

const NOW = new Date('2026-11-11T12:00:00.000Z');
const HINT: WazuhPushHint = {
  managerName: 'wazuh-manager',
  alertId: 'alert-123',
  occurredAt: '2026-11-11T11:59:59.000+0000',
  idempotencyKey: 'a'.repeat(64),
};

function claim(overrides: Partial<ClaimedWazuhPushHint> = {}): ClaimedWazuhPushHint {
  return {
    ...HINT,
    id: 'row-1',
    receivedAt: NOW,
    availableAt: NOW,
    attemptCount: 1,
    leaseUntil: new Date(NOW.getTime() + 120_000),
    claimId: 'claim-1',
    ...overrides,
  };
}

function record(): ProviderRecord {
  return {
    sourceRecordId: 'indexer-document-1',
    dataset: 'wazuh-alerts',
    occurredAt: NOW.toISOString(),
    collectedAt: NOW.toISOString(),
    metadata: {},
    raw: {
      timestamp: NOW.toISOString(),
      id: HINT.alertId,
      manager: { name: HINT.managerName },
      agent: { id: '000', name: 'wazuh-manager' },
      rule: { id: '100510', level: 12, description: 'Synthetic alert', groups: ['office365'] },
      data: { integration: 'office365', office365: { Operation: 'SyntheticOperation' } },
    },
  };
}

class FakeInbox implements WazuhPushInboxStore {
  public claims: readonly ClaimedWazuhPushHint[] = [claim()];
  public completed: string[] = [];
  public retries: { id: string; availableAt: Date; code: string }[] = [];
  public terminal: { id: string; code: string }[] = [];
  public async enqueue(): Promise<'inserted'> {
    return 'inserted';
  }
  public async claimBatch(): Promise<readonly ClaimedWazuhPushHint[]> {
    return this.claims;
  }
  public async complete(value: ClaimedWazuhPushHint): Promise<boolean> {
    this.completed.push(value.id);
    return true;
  }
  public async scheduleRetry(
    value: ClaimedWazuhPushHint,
    availableAt: Date,
    code: string,
  ): Promise<boolean> {
    this.retries.push({ id: value.id, availableAt, code });
    return true;
  }
  public async failTerminal(value: ClaimedWazuhPushHint, code: string): Promise<boolean> {
    this.terminal.push({ id: value.id, code });
    return true;
  }
  public async metrics() {
    return {
      counts: { pending: 0, processing: 0, processed: 0, 'failed-terminal': 0 },
      oldestPendingAt: null,
      oldestProcessingAt: null,
      oldestUnresolvedAt: null,
      oldestTerminalAt: null,
      lastProcessedAt: null,
      expiredProcessing: 0,
      terminalFailuresRecent: 0,
      terminalWindowHours: 24,
      receiptToHandlerMs: { windowHours: 24, sampleCount: 0, p50: null, p95: null, p99: null },
    } as const;
  }
}

function setup(result: WazuhAlertHintLookup) {
  const store = new FakeInbox();
  const lookups: unknown[] = [];
  const promoted: SecurityEvent[] = [];
  const provider: WazuhAlertHintLookupProvider = {
    findByAlertHint: async (hint) => {
      lookups.push(hint);
      return result;
    },
  };
  const pass = createWazuhPushInboxPass({
    store,
    provider,
    tenantId: 'tenant-test',
    sourceId: 'wazuh-indexer',
    now: () => NOW,
    promote: async (event) => {
      promoted.push(event);
      return 'promoted';
    },
  });
  return { store, lookups, promoted, pass };
}

describe('Wazuh durable push inbox consumer', () => {
  it('looks up and promotes the original Indexer document before completing the receipt', async () => {
    const { store, lookups, promoted, pass } = setup({ status: 'found', record: record() });

    expect(await pass()).toBe(1);
    expect(lookups).toEqual([
      { managerName: HINT.managerName, alertId: HINT.alertId, occurredAt: HINT.occurredAt },
    ]);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.raw.ref).toBe('raw:wazuh/wazuh-alerts/indexer-document-1');
    const pullConversion = wazuhRecordToEvent(record(), 'tenant-test', 'wazuh-indexer');
    expect(pullConversion.status).toBe('normalized');
    if (pullConversion.status === 'normalized') {
      expect(promoted[0]!.recordId).toBe(pullConversion.event.recordId);
      expect(promoted[0]!.eventUid).toBe(pullConversion.event.eventUid);
    }
    expect(store.completed).toEqual(['row-1']);
    expect(store.retries).toHaveLength(0);
  });

  it('retries an Indexer visibility delay with bounded backoff', async () => {
    const { store, pass } = setup({ status: 'missing' });

    await pass();

    expect(store.retries).toHaveLength(1);
    expect(store.retries[0]).toMatchObject({ code: 'INDEXER_HINT_NOT_VISIBLE' });
    expect(store.retries[0]!.availableAt.getTime()).toBe(
      NOW.getTime() + wazuhPushRetryDelayMs(claim()),
    );
    expect(store.completed).toHaveLength(0);
  });

  it('keeps a missing source pending after more than 18 seconds with deterministic capped backoff', async () => {
    const store = new FakeInbox();
    let currentTime = NOW;
    let currentAttempt = 1;
    store.claimBatch = async () => [
      claim({ attemptCount: currentAttempt, claimId: `claim-${currentAttempt}` }),
    ];
    store.scheduleRetry = async (value, availableAt, code) => {
      store.retries.push({ id: value.id, availableAt, code });
      currentTime = availableAt;
      currentAttempt = value.attemptCount + 1;
      return true;
    };
    const retryPass = createWazuhPushInboxPass({
      store,
      provider: { findByAlertHint: async () => ({ status: 'missing' }) },
      tenantId: 'tenant-test',
      sourceId: 'wazuh-indexer',
      now: () => currentTime,
      promote: async () => 'promoted',
    });

    for (let attempt = 0; attempt < 12; attempt += 1) await retryPass();

    const delays = store.retries.map(
      (retry, index) =>
        retry.availableAt.getTime() -
        (index === 0 ? NOW.getTime() : store.retries[index - 1]!.availableAt.getTime()),
    );
    expect(store.retries).toHaveLength(12);
    expect(delays.slice(0, 7)).toEqual(
      delays.slice(0, 7).map((_, index) => {
        const attempt = claim({ attemptCount: index + 1 });
        return wazuhPushRetryDelayMs(attempt);
      }),
    );
    expect(currentTime.getTime() - NOW.getTime()).toBeGreaterThan(18_000);
    expect(delays.at(-1)).toBeGreaterThanOrEqual(48_000);
    expect(delays.at(-1)).toBeLessThanOrEqual(60_000);
    expect(store.terminal).toEqual([]);
    expect(store.completed).toHaveLength(0);
  });

  it('keeps retryable provider errors pending even after many claims', async () => {
    const store = new FakeInbox();
    store.claims = [claim({ attemptCount: 25 })];
    const pass = createWazuhPushInboxPass({
      store,
      provider: {
        findByAlertHint: async () => {
          throw Object.assign(new Error('Indexer unavailable'), {
            code: 'PROVIDER_UNAVAILABLE',
            retryable: true,
          });
        },
      },
      tenantId: 'tenant-test',
      sourceId: 'wazuh-indexer',
      now: () => NOW,
      promote: async () => 'promoted',
    });

    await pass();

    expect(store.retries).toHaveLength(1);
    expect(store.retries[0]!.availableAt.getTime() - NOW.getTime()).toBeLessThanOrEqual(60_000);
    expect(store.terminal).toEqual([]);
  });

  it('quarantines ambiguous source matches instead of promoting the wrong event', async () => {
    const { store, promoted, pass } = setup({ status: 'ambiguous' });

    await pass();

    expect(store.terminal).toEqual([{ id: 'row-1', code: 'INDEXER_HINT_AMBIGUOUS' }]);
    expect(promoted).toHaveLength(0);
  });

  it('retries a transient promotion failure so pull/push races remain idempotent', async () => {
    const store = new FakeInbox();
    const provider: WazuhAlertHintLookupProvider = {
      findByAlertHint: async () => ({ status: 'found', record: record() }),
    };
    const pass = createWazuhPushInboxPass({
      store,
      provider,
      tenantId: 'tenant-test',
      sourceId: 'wazuh-indexer',
      now: () => NOW,
      promote: async () => {
        throw Object.assign(new Error('database unavailable'), {
          code: 'DB_UNAVAILABLE',
          retryable: true,
        });
      },
    });

    await pass();

    expect(store.retries).toMatchObject([{ id: 'row-1', code: 'DB_UNAVAILABLE' }]);
    expect(store.completed).toHaveLength(0);
  });

  it('replays safely when promotion committed but inbox completion failed', async () => {
    const store = new FakeInbox();
    const firstClaim = claim();
    store.claims = [firstClaim];
    const provider: WazuhAlertHintLookupProvider = {
      findByAlertHint: async () => ({ status: 'found', record: record() }),
    };
    const recordIds = new Set<string>();
    const promote = vi.fn(async (event: SecurityEvent) => {
      if (recordIds.has(event.recordId)) return 'duplicate' as const;
      recordIds.add(event.recordId);
      return 'promoted' as const;
    });
    let completionAttempts = 0;
    store.complete = async (value) => {
      completionAttempts += 1;
      if (completionAttempts === 1) {
        throw Object.assign(new Error('commit response lost'), {
          code: 'DB_UNAVAILABLE',
          retryable: true,
        });
      }
      store.completed.push(value.id);
      return true;
    };
    store.scheduleRetry = async (value, availableAt, code) => {
      store.retries.push({ id: value.id, availableAt, code });
      store.claims = [claim({ attemptCount: 2, claimId: 'claim-2' })];
      return true;
    };
    const pass = createWazuhPushInboxPass({
      store,
      provider,
      tenantId: 'tenant-test',
      sourceId: 'wazuh-indexer',
      now: () => NOW,
      promote,
    });

    await pass();
    await pass();

    expect(promote).toHaveBeenCalledTimes(2);
    expect(recordIds.size).toBe(1);
    expect(store.completed).toEqual(['row-1']);
  });
});
