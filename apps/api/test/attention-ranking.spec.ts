/**
 * Orden de «Alertas que requieren atención» con riesgo de entidad del correlador y búsqueda de
 * riesgo con degradación.
 */

import { describe, expect, it } from 'vitest';
import type { Alert } from '@qapaq/soc';

import { describeAttention, rankAttention } from '../src/soc/attention-ranking.js';
import {
  entityRiskLookup,
  parseEntityRisk,
  NO_ENTITY_RISK,
  type EntityRiskSnapshot,
} from '../src/runtime/entity-risk.js';

function alert(overrides: Partial<Alert> & { id: string }): Alert {
  return {
    tenantId: 't',
    candidateId: 'c',
    eventRecordId: 'e',
    title: 'QAPAQ M365: algo',
    priority: 'P3',
    score: 50,
    reasons: [],
    status: 'open',
    assigneeId: null,
    verdict: null,
    triageNote: null,
    incidentId: null,
    occurredAt: new Date('2026-11-13T10:00:00Z'),
    createdAt: new Date('2026-11-13T10:00:00Z'),
    updatedAt: new Date('2026-11-13T10:00:00Z'),
    revision: 1,
    entityKeys: [],
    entityRefs: [],
    signal: null,
    ruleId: null,
    relatedAlertIds: [],
    ...overrides,
  } as Alert;
}

const risk: EntityRiskSnapshot = {
  available: true,
  byKey: parseEntityRisk({
    items: [
      {
        key: 'user:Victima@qapaq.pe',
        score: 82.4,
        sources: ['aws', 'm365', 'pam', 'sudo'],
        candidateIds: ['rc_1'],
      },
      { key: 'ip:203.0.113.9', score: 12, sources: ['cloudflare'], candidateIds: [] },
      { key: 'bad', score: 'x' },
    ],
  }),
};

describe('orden por atención', () => {
  it('una P3 sobre una entidad de alto riesgo supera a una P3 sin riesgo y explica el porqué', () => {
    const hot = alert({
      id: 'hot',
      entityKeys: ['user:victima@qapaq.pe'],
      relatedAlertIds: ['a', 'b'],
    });
    const cold = alert({ id: 'cold', occurredAt: new Date('2026-11-13T11:00:00Z') });
    const [first, second] = rankAttention([cold, hot], risk, 6);
    expect(first!.alert.id).toBe('hot');
    expect(first!.attention.why).toBe(
      'Riesgo de entidad 82/100 · en cadena correlada · 4 fuentes · 2 relacionadas',
    );
    expect(second!.attention.why).toBeNull();
  });

  it('la prioridad sigue mandando: P1 sin riesgo supera a P3 con riesgo alto', () => {
    const p1 = alert({ id: 'p1', priority: 'P1' });
    const p3 = alert({ id: 'p3', entityKeys: ['user:victima@qapaq.pe'] });
    expect(rankAttention([p3, p1], risk, 2).map((r) => r.alert.id)).toEqual(['p1', 'p3']);
  });

  it('las alertas del correlador cuentan etapas y suben al principio de su prioridad', () => {
    const chain = alert({
      id: 'chain',
      priority: 'P2',
      ruleId: 'qapaq-correlator:credential-to-privilege',
      entityKeys: ['user:victima@qapaq.pe'],
      reasons: [
        { code: 'ATTACK_CHAIN', detail: 'Etapa 1: fallos de autenticación' },
        { code: 'ATTACK_CHAIN', detail: 'Etapa 2: acceso' },
        { code: 'ATTACK_CHAIN', detail: 'Etapa 3: cambio privilegiado' },
      ] as never,
    });
    const plain = alert({
      id: 'plain',
      priority: 'P2',
      occurredAt: new Date('2026-11-13T12:00:00Z'),
    });
    const ranked = rankAttention([plain, chain], risk, 6);
    expect(ranked[0]!.alert.id).toBe('chain');
    expect(ranked[0]!.attention.why).toContain('cadena 3 etapas');
  });

  it('sin correlador conserva el orden histórico (prioridad y luego más reciente) y no explica nada', () => {
    const older = alert({
      id: 'older',
      priority: 'P2',
      occurredAt: new Date('2026-11-13T08:00:00Z'),
    });
    const newer = alert({
      id: 'newer',
      priority: 'P2',
      occurredAt: new Date('2026-11-13T09:00:00Z'),
    });
    const p1 = alert({ id: 'p1', priority: 'P1', occurredAt: new Date('2026-11-12T00:00:00Z') });
    const ranked = rankAttention([older, newer, p1], NO_ENTITY_RISK, 6);
    expect(ranked.map((r) => r.alert.id)).toEqual(['p1', 'newer', 'older']);
    expect(ranked.every((r) => r.attention.why === null)).toBe(true);
  });

  it('no menciona riesgos bajos', () => {
    const info = describeAttention(alert({ id: 'x', entityKeys: ['ip:203.0.113.9'] }), risk);
    expect(info.why).toBeNull();
    expect(info.entityRisk).toBe(12);
  });

  it('respeta el límite', () => {
    const many = Array.from({ length: 10 }, (_, i) => alert({ id: `a${i}` }));
    expect(rankAttention(many, risk, 3)).toHaveLength(3);
  });
});

describe('búsqueda de riesgo de entidad', () => {
  const link = { baseUrl: 'http://correlator:8080', token: 't' };
  const ok = {
    status: 200,
    body: { items: [{ key: 'user:a@b', score: 50, sources: [], candidateIds: [] }] },
  };

  it('reutiliza la consulta dentro del TTL y no propaga fallos', async () => {
    let clock = 0;
    let calls = 0;
    let fail = false;
    const lookup = entityRiskLookup({
      link,
      now: () => clock,
      get: async () => {
        calls += 1;
        if (fail) throw new Error('down');
        return ok;
      },
    });
    expect((await lookup.snapshot()).byKey.get('user:a@b')?.score).toBe(50);
    await lookup.snapshot();
    expect(calls).toBe(1);
    clock = 31_000;
    fail = true;
    const stale = await lookup.snapshot();
    expect(calls).toBe(2);
    expect(stale.available).toBe(true); // último resultado bueno
    clock = 10 * 60_000;
    const gone = await lookup.snapshot();
    expect(gone.available).toBe(false);
  });

  it('sin enlace o con respuesta no 200 degrada a vacío', async () => {
    expect((await entityRiskLookup({ link: undefined }).snapshot()).available).toBe(false);
    const bad = entityRiskLookup({ link, get: async () => ({ status: 503, body: null }) });
    expect((await bad.snapshot()).available).toBe(false);
  });
});
