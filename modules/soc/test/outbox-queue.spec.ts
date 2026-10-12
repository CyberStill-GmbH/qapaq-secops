import { describe, expect, it } from 'vitest';

import { InMemorySoc } from '../src/memory-unit-of-work.js';
import type { OutboxMessageDraft } from '../src/events.js';

/**
 * C-20 / D-7 — contrato de la cola durable del outbox: claim con lease y fencing token.
 * El adapter PostgreSQL cumple el mismo contrato en `postgres-soc.integration.spec.ts`.
 */

const AT = new Date('2026-10-12T10:00:00.000Z');
const LEASE_MS = 60_000;
const after = (ms: number) => new Date(AT.getTime() + ms);

function message(id: string, availableAt = AT): OutboxMessageDraft {
  return {
    messageId: id,
    tenantId: 'tenant-1',
    aggregateType: 'alert',
    aggregateId: `0199c200-0000-7000-8000-${id.padStart(12, '0')}`,
    messageType: 'soc.alert.escalated',
    schemaVersion: '1.0.0',
    idempotencyKey: `key-${id}`,
    payload: { priority: 'P1' },
    availableAt,
  };
}

function queueWith(...messages: OutboxMessageDraft[]): InMemorySoc {
  const soc = new InMemorySoc();
  for (const draft of messages) soc.outboxRows.set(draft.idempotencyKey, draft);
  return soc;
}

describe('C-20 · cola del outbox con lease', () => {
  it('no entrega lo que aún no está disponible', async () => {
    const soc = queueWith(message('1', after(5_000)));

    expect(await soc.claimOutbox(AT, 10, LEASE_MS)).toHaveLength(0);
    expect(await soc.claimOutbox(after(5_000), 10, LEASE_MS)).toHaveLength(1);
  });

  it('mientras dura el lease nadie más reclama; al vencer, se reclama con token nuevo', async () => {
    const soc = queueWith(message('1'));

    const [first] = await soc.claimOutbox(AT, 10, LEASE_MS);
    expect(await soc.claimOutbox(after(30_000), 10, LEASE_MS)).toHaveLength(0);
    const [second] = await soc.claimOutbox(after(LEASE_MS + 1), 10, LEASE_MS);

    expect(second?.messageId).toBe(first?.messageId);
    expect(second?.claimToken).not.toBe(first?.claimToken);
    expect(soc.outboxState.get('1')?.attemptCount).toBe(2);
  });

  it('fencing: el dueño anterior no puede publicar ni reprogramar con su token viejo', async () => {
    const soc = queueWith(message('1'));
    const [stale] = await soc.claimOutbox(AT, 10, LEASE_MS);
    const [current] = await soc.claimOutbox(after(LEASE_MS + 1), 10, LEASE_MS);

    expect(await soc.markOutboxPublished('1', stale!.claimToken, AT)).toBe(false);
    expect(await soc.scheduleOutboxRetry('1', stale!.claimToken, after(1), 'X')).toBe(false);
    expect(soc.outboxState.get('1')?.status).toBe('processing');

    expect(await soc.markOutboxPublished('1', current!.claimToken, AT)).toBe(true);
    expect(soc.outboxState.get('1')?.status).toBe('published');
  });

  it('publicado es definitivo: no se vuelve a reclamar ni a cerrar', async () => {
    const soc = queueWith(message('1'));
    const [claimed] = await soc.claimOutbox(AT, 10, LEASE_MS);
    await soc.markOutboxPublished('1', claimed!.claimToken, AT);

    expect(await soc.markOutboxPublished('1', claimed!.claimToken, AT)).toBe(false);
    expect(await soc.claimOutbox(after(10 * LEASE_MS), 10, LEASE_MS)).toHaveLength(0);
  });

  it('reprogramar devuelve el mensaje a la cola desde la nueva disponibilidad', async () => {
    const soc = queueWith(message('1'));
    const [claimed] = await soc.claimOutbox(AT, 10, LEASE_MS);

    expect(await soc.scheduleOutboxRetry('1', claimed!.claimToken, after(30_000), 'TIMEOUT')).toBe(
      true,
    );
    expect(await soc.claimOutbox(after(10_000), 10, LEASE_MS)).toHaveLength(0);
    expect(await soc.claimOutbox(after(30_000), 10, LEASE_MS)).toHaveLength(1);
    expect(soc.outboxState.get('1')?.lastErrorCode).toBe('TIMEOUT');
  });

  it('respeta el tamaño del lote y el orden por disponibilidad', async () => {
    const soc = queueWith(message('3', after(3)), message('1', after(1)), message('2', after(2)));

    const batch = await soc.claimOutbox(after(10), 2, LEASE_MS);

    expect(batch.map((claimed) => claimed.messageId)).toEqual(['1', '2']);
  });
});
