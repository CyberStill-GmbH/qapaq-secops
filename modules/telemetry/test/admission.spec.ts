import { describe, expect, it, vi } from 'vitest';
import type { AdmissionCommand, AdmissionReceipt } from '@qapaq/database/admission-contract';
import {
  admitPage,
  TELEMETRY_ADMISSION_LIMITS,
  TelemetryAdmissionError,
  type AdmissionRepository,
  type DurableRawStore,
} from '../src/admission.js';

const uuid = (tail: string) => `01996000-0000-7000-8000-${tail.padStart(12, '0')}`;
const request = () => ({
  sourceId: uuid('1'),
  dataset: 'alerts',
  manifestKey: 'page-1',
  manifestId: uuid('2'),
  receivedAt: new Date('2026-09-28T10:00:00.000Z'),
  records: [
    {
      sourceRecordId: 'p-1',
      dataset: 'alerts',
      collectedAt: '2026-09-28T10:00:00Z',
      raw: { z: 'ñ', a: 1 },
      metadata: {},
    },
    {
      sourceRecordId: 'p-2',
      dataset: 'alerts',
      collectedAt: '2026-09-28T10:00:00Z',
      raw: { a: 2 },
      metadata: {},
    },
  ],
  expectedRevision: 0n,
  cursor: { from: null, to: 'cursor-1', version: '1' },
});

function rawStore(): DurableRawStore {
  const objects = new Map<string, Uint8Array>();
  return {
    async putIfAbsent(ref, bytes) {
      if (!objects.has(ref)) objects.set(ref, Uint8Array.from(bytes));
      return {};
    },
    async get(ref) {
      const value = objects.get(ref);
      if (!value) throw new Error('missing');
      return Uint8Array.from(value);
    },
  };
}

function repository(captured: AdmissionCommand[]): AdmissionRepository {
  return {
    async commit(command) {
      captured.push(command);
      return {
        manifestId: command.manifestId,
        eventCount: command.events.length,
        acceptedCount: command.events.length,
        quarantinedCount: 0,
        duplicateCount: 0,
        checkpointRevision:
          command.expectedRevision === undefined ? null : command.expectedRevision + 1n,
      } satisfies AdmissionReceipt;
    },
  };
}

describe('C-11 durable admission', () => {
  it('writes and verifies every raw before calling the C-04 transaction; identities and hashes are stable on retry', async () => {
    const captured: AdmissionCommand[] = [];
    const store = rawStore();
    const first = await admitPage(request(), store, repository(captured));
    const retry = await admitPage(request(), store, repository(captured));
    expect(first.receipt.checkpointRevision).toBe(1n);
    expect(first.byteCount).toBeGreaterThan(0);
    expect(first.sha256).toEqual(retry.sha256);
    expect(captured[0]).toEqual(captured[1]);
    expect(captured[0]?.events).toHaveLength(2);
    expect(captured[0]?.newRawObjects.every((raw) => raw.objectRef.startsWith('raw:'))).toBe(true);
  });

  it('does not request a database commit when raw persistence fails', async () => {
    const commit = vi.fn();
    const broken: DurableRawStore = {
      async putIfAbsent() {
        throw new Error('object store unavailable');
      },
      async get() {
        throw new Error('not found');
      },
    };
    await expect(admitPage(request(), broken, { commit })).rejects.toMatchObject({
      code: 'RAW_PERSISTENCE_FAILED',
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('leaves a possible partial raw orphan but never commits a partial batch', async () => {
    const commit = vi.fn();
    const delegate = rawStore();
    let writes = 0;
    const partialFailure: DurableRawStore = {
      async putIfAbsent(ref, bytes, hash) {
        writes++;
        if (writes === 2) throw new Error('second object write failed');
        return delegate.putIfAbsent(ref, bytes, hash);
      },
      get: (ref, maximumBytes) => delegate.get(ref, maximumBytes),
    };
    await expect(admitPage(request(), partialFailure, { commit })).rejects.toMatchObject({
      code: 'RAW_PERSISTENCE_FAILED',
    });
    expect(writes).toBe(2);
    expect(commit).not.toHaveBeenCalled();
  });

  it('fails closed on mismatched bytes, before manifest/outbox/checkpoint transaction', async () => {
    const commit = vi.fn();
    const corrupt: DurableRawStore = {
      async putIfAbsent() {
        return {};
      },
      async get() {
        return Buffer.from('tampered');
      },
    };
    await expect(admitPage(request(), corrupt, { commit })).rejects.toMatchObject({
      code: 'RAW_INTEGRITY_FAILED',
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('keeps PostgreSQL commit failures visible for replay; it never reports a receipt', async () => {
    const repo: AdmissionRepository = {
      async commit() {
        throw new Error('transaction rolled back');
      },
    };
    await expect(admitPage(request(), rawStore(), repo)).rejects.toMatchObject({
      code: 'DATABASE_ADMISSION_FAILED',
    });
  });

  it('enforces bounded admission and rejects empty pages', async () => {
    expect(TELEMETRY_ADMISSION_LIMITS).toEqual({
      maxRecords: 500,
      maxRawBytes: 262144,
      maxBatchBytes: 5 * 1024 * 1024,
    });
    const empty = { ...request(), records: [] };
    await expect(admitPage(empty, rawStore(), repository([]))).rejects.toBeInstanceOf(
      TelemetryAdmissionError,
    );
  });

  it('rejects oversized raw before object storage or database I/O', async () => {
    const putIfAbsent = vi.fn();
    const commit = vi.fn();
    const oversized = {
      ...request(),
      records: [
        {
          ...request().records[0]!,
          raw: { body: 'x'.repeat(TELEMETRY_ADMISSION_LIMITS.maxRawBytes + 1) },
        },
      ],
    };
    await expect(
      admitPage(oversized, { putIfAbsent, get: vi.fn() }, { commit }),
    ).rejects.toMatchObject({
      code: 'INVALID_ADMISSION',
    });
    expect(putIfAbsent).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
});
