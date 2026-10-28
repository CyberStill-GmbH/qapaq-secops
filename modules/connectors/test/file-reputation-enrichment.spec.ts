/**
 * Cuota (4/min y 500/día por tenant) y caché de 24 h del enriquecimiento por hash, con un
 * proveedor doble y reloj controlado.
 */

import { describe, expect, it } from 'vitest';

import type { FileHash } from '@qapaq/contracts';

import {
  enrichFileReputation,
  FileReputationProviderError,
  InMemoryFileReputationStore,
  type FileReputationLookup,
  type FileReputationProvider,
} from '../src/public/index.js';

const TENANT = 'tenant-a';

function hash(index: number): FileHash {
  return { algorithm: 'sha256', value: index.toString(16).padStart(64, '0') };
}

function fixture(start = '2026-10-27T10:00:00.000Z') {
  let now = new Date(start);
  const lookups: FileHash[] = [];
  let next: () => FileReputationLookup = () => ({
    status: 'found',
    reputation: {
      detections: 1,
      engines: 70,
      firstSeenAt: null,
      lastAnalysisAt: null,
      threatLabels: [],
      reportUrl: 'https://www.virustotal.com/gui/file/x',
    },
  });
  const provider: FileReputationProvider = {
    providerId: 'reputation-test',
    async lookup(value) {
      lookups.push(value);
      return next();
    },
  };
  const store = new InMemoryFileReputationStore();
  const dependencies = { provider, store, now: () => now };
  return {
    lookups,
    store,
    advance: (milliseconds: number) => {
      now = new Date(now.getTime() + milliseconds);
    },
    unknown: () => {
      next = () => ({ status: 'unknown' });
    },
    fail: (error: Error) => {
      next = () => {
        throw error;
      };
    },
    enrich: (value: FileHash, tenantId = TENANT) =>
      enrichFileReputation(dependencies, { tenantId, hash: value }),
  };
}

describe('cuota por tenant', () => {
  it('admite 4 consultas por minuto y rechaza la quinta sin salir al servicio', async () => {
    const f = fixture();
    const outcomes = [];
    for (let index = 0; index < 5; index += 1) outcomes.push(await f.enrich(hash(index)));

    expect(outcomes.slice(0, 4).every((outcome) => outcome.kind === 'resolved')).toBe(true);
    expect(outcomes[3]).toMatchObject({
      quota: { minute: { remaining: 0 }, day: { remaining: 496 } },
    });
    expect(outcomes[4]).toMatchObject({
      kind: 'quota_exhausted',
      window: 'minute',
      retryAfterMs: 60_000,
    });
    expect(f.lookups).toHaveLength(4);
  });

  it('el minuto es móvil: el cupo vuelve cuando vence el uso más antiguo', async () => {
    const f = fixture();
    await f.enrich(hash(0));
    f.advance(30_000);
    for (let index = 1; index < 4; index += 1) await f.enrich(hash(index));

    f.advance(20_000);
    expect(await f.enrich(hash(10))).toMatchObject({
      kind: 'quota_exhausted',
      retryAfterMs: 10_000,
    });
    f.advance(10_001);
    expect((await f.enrich(hash(11))).kind).toBe('resolved');
  });

  it('corta en 500 por día UTC y libera a medianoche', async () => {
    const f = fixture('2026-10-27T00:00:00.000Z');
    for (let index = 0; index < 500; index += 1) {
      const outcome = await f.enrich(hash(index));
      expect(outcome.kind).toBe('resolved');
      f.advance(15_001);
    }
    const exhausted = await f.enrich(hash(999));

    expect(exhausted).toMatchObject({
      kind: 'quota_exhausted',
      window: 'day',
      quota: { day: { remaining: 0, resetsAt: '2026-10-28T00:00:00.000Z' } },
    });
    f.advance(24 * 60 * 60 * 1_000);
    expect((await f.enrich(hash(1_000))).kind).toBe('resolved');
  });

  it('la cuota de un tenant no consume la de otro', async () => {
    const f = fixture();
    for (let index = 0; index < 4; index += 1) await f.enrich(hash(index), 'tenant-a');

    expect((await f.enrich(hash(5), 'tenant-a')).kind).toBe('quota_exhausted');
    expect((await f.enrich(hash(5), 'tenant-b')).kind).toBe('resolved');
  });

  it('un fallo del servicio consume cuota (el servicio lo cuenta) y no se cachea', async () => {
    const f = fixture();
    f.fail(new FileReputationProviderError('REPUTATION_RATE_LIMITED', true));
    const failed = await f.enrich(hash(1));

    expect(failed).toMatchObject({
      kind: 'provider_failed',
      code: 'REPUTATION_RATE_LIMITED',
      quota: { minute: { remaining: 3 } },
    });
    f.fail(new Error('inesperado'));
    expect(await f.enrich(hash(1))).toMatchObject({ code: 'REPUTATION_UNAVAILABLE' });
    expect(f.lookups).toHaveLength(2);
  });
});

describe('caché de 24 h', () => {
  it('repite el resultado sin consultar ni gastar cuota mientras está vigente', async () => {
    const f = fixture();
    const first = await f.enrich(hash(7));
    f.advance(23 * 60 * 60 * 1_000);
    const second = await f.enrich(hash(7));

    expect(first).toMatchObject({ kind: 'resolved', cached: false });
    expect(second).toMatchObject({ kind: 'resolved', cached: true, status: 'found' });
    expect(f.lookups).toHaveLength(1);
  });

  it('una entrada vencida vuelve a consultar', async () => {
    const f = fixture();
    await f.enrich(hash(7));
    f.advance(24 * 60 * 60 * 1_000 + 1);
    expect(await f.enrich(hash(7))).toMatchObject({ cached: false });
    expect(f.lookups).toHaveLength(2);
  });

  it('con la cuota agotada, lo cacheado se sigue sirviendo', async () => {
    const f = fixture();
    for (let index = 0; index < 4; index += 1) await f.enrich(hash(index));

    expect(await f.enrich(hash(0))).toMatchObject({ kind: 'resolved', cached: true });
    expect(await f.enrich(hash(9))).toMatchObject({ kind: 'quota_exhausted' });
  });

  it('cachea también el hash desconocido, separado por tenant', async () => {
    const f = fixture();
    f.unknown();
    expect(await f.enrich(hash(3))).toMatchObject({ status: 'unknown', reputation: null });
    expect(await f.enrich(hash(3))).toMatchObject({ status: 'unknown', cached: true });
    expect(await f.enrich(hash(3), 'tenant-b')).toMatchObject({ cached: false });
    expect(f.lookups).toHaveLength(2);
  });
});
