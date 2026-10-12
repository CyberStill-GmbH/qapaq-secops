import { describe, expect, it } from 'vitest';

import {
  candidateId,
  decidePromotion,
  promotionKey,
  type DetectionCandidate,
} from '../src/promotion.js';
import type { DetectionCandidateStore } from '../src/ports.js';
import {
  PRIORITIZATION_RULESET_VERSION,
  type PrioritizationContext,
} from '../src/prioritization.js';
import { withSeverity } from './support/events.js';

const NOW = new Date('2026-10-07T15:31:00.000Z');

const CONTEXT: PrioritizationContext = {
  privilegedIdentities: new Set(['jperez@qapaq.pe']),
  criticalAssets: new Set(['host-1']),
};

class MemoryCandidateStore implements DetectionCandidateStore {
  public readonly rows = new Map<string, DetectionCandidate>();

  public byIdempotencyKey(tenantId: string, key: string): Promise<DetectionCandidate | undefined> {
    return Promise.resolve(this.rows.get(`${tenantId}|${key}`));
  }

  public insertIfAbsent(candidate: DetectionCandidate): Promise<boolean> {
    const key = `${candidate.tenantId}|${candidate.idempotencyKey}`;
    if (this.rows.has(key)) return Promise.resolve(false);
    this.rows.set(key, candidate);
    return Promise.resolve(true);
  }
}

async function promote(store: MemoryCandidateStore, event = withSeverity('high')) {
  const key = promotionKey(event.tenant.id, event.recordId, PRIORITIZATION_RULESET_VERSION);
  const existing = await store.byIdempotencyKey(event.tenant.id, key);
  const decision = decidePromotion(event, CONTEXT, existing, NOW);
  if (decision.outcome === 'promoted') await store.insertIfAbsent(decision.candidate);
  return decision;
}

describe('C-16 · promoción', () => {
  it('promueve una alerta Wazuh que supera el umbral', async () => {
    const store = new MemoryCandidateStore();
    const decision = await promote(store);

    expect(decision.outcome).toBe('promoted');
    expect(decision.outcome === 'promoted' && decision.candidate.priority).toBe('P1');
    expect(decision.outcome === 'promoted' && decision.candidate.title).toContain('wazuh');
    expect(store.rows.size).toBe(1);
  });

  it('no promueve por debajo del umbral y declara el motivo', async () => {
    const store = new MemoryCandidateStore();
    const decision = await promote(
      store,
      withSeverity('low', { entities: { identities: [], resources: [] } }),
    );

    expect(decision).toMatchObject({ outcome: 'not_promoted', reasonCode: 'BELOW_THRESHOLD' });
    expect(store.rows.size).toBe(0);
  });

  it('no promueve lo suprimido aunque el puntaje base fuera alto', async () => {
    const event = withSeverity('critical');
    const decision = decidePromotion(
      event,
      { ...CONTEXT, knownBenignRuleIds: new Set(['5716']) },
      undefined,
      NOW,
    );

    expect(decision).toMatchObject({ outcome: 'not_promoted', reasonCode: 'SUPPRESSED' });
  });

  it('repetir la promoción no crea un segundo candidato', async () => {
    const store = new MemoryCandidateStore();
    const first = await promote(store);
    const second = await promote(store);

    expect(first.outcome).toBe('promoted');
    expect(second.outcome).toBe('duplicate');
    expect(second.outcome === 'duplicate' && second.existing.id).toBe(
      first.outcome === 'promoted' && first.candidate.id,
    );
    expect(store.rows.size).toBe(1);
  });

  it('dos workers concurrentes dejan un único candidato', async () => {
    const store = new MemoryCandidateStore();
    const event = withSeverity('high');
    const decisions = [
      decidePromotion(event, CONTEXT, undefined, NOW),
      decidePromotion(event, CONTEXT, undefined, NOW),
    ];
    const inserted = await Promise.all(
      decisions.map((decision) =>
        decision.outcome === 'promoted' ? store.insertIfAbsent(decision.candidate) : false,
      ),
    );

    expect(inserted.filter(Boolean)).toHaveLength(1);
    expect(store.rows.size).toBe(1);
  });

  it('deriva un identificador estable entre reintentos', () => {
    const event = withSeverity('high');
    const key = promotionKey(event.tenant.id, event.recordId, '1.0.0');

    expect(candidateId(key, new Date(event.occurredAt))).toBe(
      candidateId(key, new Date(event.occurredAt)),
    );
    expect(candidateId(key, new Date(event.occurredAt))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it('separa la clave por tenant, evento y versión del ruleset', () => {
    const key = promotionKey('tenant-1', 'record-1', '1.0.0');

    expect(promotionKey('tenant-2', 'record-1', '1.0.0')).not.toBe(key);
    expect(promotionKey('tenant-1', 'record-2', '1.0.0')).not.toBe(key);
    expect(promotionKey('tenant-1', 'record-1', '1.1.0')).not.toBe(key);
  });

  it('conserva el candidato existente aunque el contexto cambie entre pasadas', async () => {
    const store = new MemoryCandidateStore();
    const first = await promote(store);
    const event = withSeverity('high');
    const existing = await store.byIdempotencyKey(
      event.tenant.id,
      promotionKey(event.tenant.id, event.recordId, PRIORITIZATION_RULESET_VERSION),
    );
    const second = decidePromotion(
      event,
      { ...CONTEXT, knownBenignRuleIds: new Set(['5716']) },
      existing,
      NOW,
    );

    expect(second.outcome).toBe('duplicate');
    expect(first.outcome === 'promoted' && store.rows.size).toBe(1);
  });

  it('conserva las razones dentro del candidato promovido', async () => {
    const decision = await promote(new MemoryCandidateStore());
    const codes =
      decision.outcome === 'promoted' ? decision.candidate.reasons.map((r) => r.code) : [];

    expect(codes).toEqual(
      expect.arrayContaining(['BASE_SEVERITY', 'PRIVILEGED_IDENTITY', 'CRITICAL_ASSET']),
    );
  });
});
