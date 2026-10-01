import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RETRY_POLICY,
  decideInboxTransition,
  planReplay,
  type InboxEntry,
} from '../src/inbox-lifecycle.js';

const AT = new Date('2026-10-01T10:00:00.000Z');

function entry(overrides: Partial<InboxEntry> = {}): InboxEntry {
  return {
    sourceId: 'src-1',
    idempotencyKey: 'key-1',
    recordId: 'rec-1',
    status: 'admitted',
    attemptCount: 0,
    ...overrides,
  };
}

describe('C-13 ciclo de vida de la bandeja', () => {
  it('toma el lease e incrementa el intento', () => {
    const decision = decideInboxTransition(entry(), { type: 'lease', at: AT, leaseMs: 30_000 });

    expect(decision).toEqual({
      effect: 'transition',
      to: 'processing',
      attemptCount: 1,
      availableAt: new Date('2026-10-01T10:00:30.000Z'),
    });
  });

  it('no concede un lease sobre un registro ya tomado', () => {
    const decision = decideInboxTransition(entry({ status: 'processing', attemptCount: 1 }), {
      type: 'lease',
      at: AT,
      leaseMs: 30_000,
    });

    expect(decision).toEqual({ effect: 'noop', reason: 'LEASE_STILL_HELD' });
  });

  it('rechaza un lease sin duración', () => {
    const decision = decideInboxTransition(entry(), { type: 'lease', at: AT, leaseMs: 0 });
    expect(decision).toEqual({ effect: 'reject', reason: 'INVALID_LEASE' });
  });

  it('completa solo lo que está en proceso', () => {
    expect(
      decideInboxTransition(entry({ status: 'processing', attemptCount: 1 }), {
        type: 'complete',
        at: AT,
      }),
    ).toEqual({ effect: 'transition', to: 'processed', attemptCount: 1, availableAt: AT });

    expect(decideInboxTransition(entry(), { type: 'complete', at: AT })).toEqual({
      effect: 'reject',
      reason: 'NOT_LEASED',
    });
  });

  it('un registro procesado absorbe la reentrega sin efecto', () => {
    const processed = entry({ status: 'processed', attemptCount: 1 });

    expect(decideInboxTransition(processed, { type: 'lease', at: AT, leaseMs: 30_000 })).toEqual({
      effect: 'noop',
      reason: 'ALREADY_PROCESSED',
    });
    expect(decideInboxTransition(processed, { type: 'complete', at: AT })).toEqual({
      effect: 'noop',
      reason: 'ALREADY_PROCESSED',
    });
  });
});

describe('C-13 política de reintentos', () => {
  it('un fallo venenoso va a cuarentena sin consumir reintentos', () => {
    const decision = decideInboxTransition(entry({ status: 'processing', attemptCount: 1 }), {
      type: 'fail',
      at: AT,
      failure: { kind: 'poison', code: 'INVALID_TIMESTAMP', path: '/timestamp' },
    });

    expect(decision).toEqual({
      effect: 'quarantine',
      code: 'INVALID_TIMESTAMP',
      path: '/timestamp',
    });
  });

  it('un fallo transitorio reprograma con backoff exponencial acotado', () => {
    const first = decideInboxTransition(entry({ status: 'processing', attemptCount: 1 }), {
      type: 'fail',
      at: AT,
      failure: { kind: 'transient', code: 'DB_UNAVAILABLE' },
    });
    const third = decideInboxTransition(entry({ status: 'processing', attemptCount: 3 }), {
      type: 'fail',
      at: AT,
      failure: { kind: 'transient', code: 'DB_UNAVAILABLE' },
    });

    if (first.effect !== 'transition' || third.effect !== 'transition') {
      throw new Error('se esperaba transición');
    }
    // intento 1 -> 1s; intento 3 -> 4s
    expect(first.availableAt.getTime() - AT.getTime()).toBe(1_000);
    expect(third.availableAt.getTime() - AT.getTime()).toBe(4_000);
    expect(first.to).toBe('admitted');
    expect(first.lastErrorCode).toBe('DB_UNAVAILABLE');
  });

  it('el backoff nunca supera el techo de la política', () => {
    const decision = decideInboxTransition(
      entry({ status: 'processing', attemptCount: 2 }),
      {
        type: 'fail',
        at: AT,
        failure: { kind: 'transient', code: 'DB_UNAVAILABLE' },
      },
      { maximumAttempts: 99, baseDelayMs: 1_000, maximumDelayMs: 1_500 },
    );

    if (decision.effect !== 'transition') throw new Error('se esperaba transición');
    expect(decision.availableAt.getTime() - AT.getTime()).toBe(1_500);
  });

  it('agotado el presupuesto el registro queda visible como fallido, no en bucle', () => {
    const decision = decideInboxTransition(
      entry({ status: 'processing', attemptCount: DEFAULT_RETRY_POLICY.maximumAttempts }),
      { type: 'fail', at: AT, failure: { kind: 'transient', code: 'DB_UNAVAILABLE' } },
    );

    if (decision.effect !== 'transition') throw new Error('se esperaba transición');
    expect(decision.to).toBe('failed');
    expect(decision.availableAt).toEqual(AT);
  });
});

describe('C-13 reproceso desde la bandeja', () => {
  it('reabre un registro en cuarentena conservando el contador de intentos', () => {
    const decision = decideInboxTransition(entry({ status: 'quarantined', attemptCount: 2 }), {
      type: 'reprocess',
      at: AT,
    });

    expect(decision).toEqual({
      effect: 'transition',
      to: 'admitted',
      attemptCount: 2,
      availableAt: AT,
    });
  });

  it('no reabre un registro que nunca falló', () => {
    expect(decideInboxTransition(entry(), { type: 'reprocess', at: AT })).toEqual({
      effect: 'reject',
      reason: 'NOT_QUARANTINED',
    });
  });

  it('no reabre un registro ya procesado', () => {
    expect(
      decideInboxTransition(entry({ status: 'processed' }), { type: 'reprocess', at: AT }),
    ).toEqual({ effect: 'reject', reason: 'TERMINAL_STATUS' });
  });
});

describe('C-13 replay de una ventana', () => {
  it('admite solo lo nuevo cuando se vuelve a entregar una página', () => {
    const plan = planReplay(
      [
        { idempotencyKey: 'a', recordId: 'r1' },
        { idempotencyKey: 'b', recordId: 'r2' },
        { idempotencyKey: 'c', recordId: 'r3' },
      ],
      new Set(['a', 'b']),
    );

    expect(plan.counts).toEqual({ received: 3, admit: 1, duplicates: 2 });
    expect(plan.admit.map((item) => item.idempotencyKey)).toEqual(['c']);
  });

  it('colapsa duplicados dentro de la misma página', () => {
    const plan = planReplay(
      [
        { idempotencyKey: 'a', recordId: 'r1' },
        { idempotencyKey: 'a', recordId: 'r1-bis' },
      ],
      new Set(),
    );

    expect(plan.counts).toEqual({ received: 2, admit: 1, duplicates: 1 });
  });

  it('reprocesar una ventana ya procesada no admite nada', () => {
    const plan = planReplay(
      [
        { idempotencyKey: 'a', recordId: 'r1' },
        { idempotencyKey: 'b', recordId: 'r2' },
      ],
      new Set(['a', 'b']),
    );

    expect(plan.counts).toEqual({ received: 2, admit: 0, duplicates: 2 });
    expect(plan.admit).toHaveLength(0);
  });

  it('nada se pierde: lo admitido más lo duplicado iguala lo recibido', () => {
    const candidates = Array.from({ length: 50 }, (_, index) => ({
      idempotencyKey: `k-${index % 30}`,
      recordId: `r-${index}`,
    }));
    const plan = planReplay(candidates, new Set(['k-0', 'k-1']));

    expect(plan.counts.admit + plan.counts.duplicates).toBe(plan.counts.received);
  });
});
