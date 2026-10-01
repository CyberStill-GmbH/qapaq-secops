import { describe, expect, it } from 'vitest';

import {
  comparePositions,
  decideCheckpointAdvance,
  highWaterMark,
  type CheckpointCandidate,
  type CheckpointState,
} from '../src/checkpoint-advance.js';

function state(overrides: Partial<CheckpointState> = {}): CheckpointState {
  return {
    cursor: '2026-10-01T09:00:00.000Z|evt-100',
    revision: 7n,
    sourceGeneration: 'gen-1',
    lastOccurredAt: new Date('2026-10-01T09:00:00.000Z'),
    lastTieBreaker: 'evt-100',
    ...overrides,
  };
}

function candidate(overrides: Partial<CheckpointCandidate> = {}): CheckpointCandidate {
  return {
    cursor: '2026-10-01T09:05:00.000Z|evt-200',
    expectedRevision: 7n,
    sourceGeneration: 'gen-1',
    lastOccurredAt: new Date('2026-10-01T09:05:00.000Z'),
    lastTieBreaker: 'evt-200',
    ...overrides,
  };
}

describe('C-13 orden de posiciones', () => {
  it('ordena primero por instante y luego por desempate', () => {
    const early = { lastOccurredAt: new Date('2026-10-01T09:00:00Z'), lastTieBreaker: 'b' };
    const late = { lastOccurredAt: new Date('2026-10-01T09:01:00Z'), lastTieBreaker: 'a' };
    const sameTimeLowerTie = {
      lastOccurredAt: new Date('2026-10-01T09:00:00Z'),
      lastTieBreaker: 'a',
    };

    expect(comparePositions(early, late)).toBe(-1);
    expect(comparePositions(late, early)).toBe(1);
    expect(comparePositions(early, sameTimeLowerTie)).toBe(1);
    expect(comparePositions(early, early)).toBe(0);
  });

  it('la marca de agua es la posición máxima de la página', () => {
    const mark = highWaterMark([
      { lastOccurredAt: new Date('2026-10-01T09:00:00Z'), lastTieBreaker: 'a' },
      { lastOccurredAt: new Date('2026-10-01T09:02:00Z'), lastTieBreaker: 'z' },
      { lastOccurredAt: new Date('2026-10-01T09:02:00Z'), lastTieBreaker: 'b' },
    ]);

    expect(mark?.lastTieBreaker).toBe('z');
  });

  it('una página vacía no produce marca de agua', () => {
    expect(highWaterMark([])).toBeUndefined();
  });
});

describe('C-13 avance de cursor', () => {
  it('avanza e incrementa la revisión', () => {
    expect(decideCheckpointAdvance(state(), candidate())).toEqual({
      effect: 'advance',
      cursor: '2026-10-01T09:05:00.000Z|evt-200',
      revision: 8n,
    });
  });

  it('no retrocede ante una posición anterior', () => {
    const decision = decideCheckpointAdvance(
      state(),
      candidate({
        lastOccurredAt: new Date('2026-10-01T08:00:00.000Z'),
        lastTieBreaker: 'evt-001',
      }),
    );

    expect(decision).toEqual({ effect: 'ignore', reason: 'WOULD_REGRESS' });
  });

  it('reaplicar la misma posición no tiene efecto', () => {
    const decision = decideCheckpointAdvance(
      state(),
      candidate({
        lastOccurredAt: new Date('2026-10-01T09:00:00.000Z'),
        lastTieBreaker: 'evt-100',
      }),
    );

    expect(decision).toEqual({ effect: 'ignore', reason: 'ALREADY_AT_POSITION' });
  });

  it('detecta una escritura concurrente por revisión obsoleta', () => {
    const decision = decideCheckpointAdvance(state(), candidate({ expectedRevision: 6n }));
    expect(decision).toEqual({ effect: 'conflict', reason: 'REVISION_STALE' });
  });

  it('escala cuando la fuente cambió de generación en vez de avanzar a ciegas', () => {
    const decision = decideCheckpointAdvance(state(), candidate({ sourceGeneration: 'gen-2' }));
    expect(decision).toEqual({ effect: 'conflict', reason: 'SOURCE_GENERATION_CHANGED' });
  });

  it('un desempate mayor con el mismo instante sí avanza', () => {
    const decision = decideCheckpointAdvance(
      state(),
      candidate({
        lastOccurredAt: new Date('2026-10-01T09:00:00.000Z'),
        lastTieBreaker: 'evt-101',
      }),
    );

    expect(decision.effect).toBe('advance');
  });

  it('la revisión obsoleta se detecta antes que cualquier otra condición', () => {
    // Un candidato que además retrocede: el conflicto de concurrencia manda, porque el
    // llamante debe releer antes de concluir nada sobre la posición.
    const decision = decideCheckpointAdvance(
      state(),
      candidate({
        expectedRevision: 1n,
        lastOccurredAt: new Date('2026-10-01T08:00:00.000Z'),
        lastTieBreaker: 'evt-001',
      }),
    );

    expect(decision).toEqual({ effect: 'conflict', reason: 'REVISION_STALE' });
  });
});
