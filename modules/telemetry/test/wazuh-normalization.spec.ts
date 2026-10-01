import { describe, expect, it } from 'vitest';

import { SECURITY_EVENT_LIMITS, validateSecurityEvent } from '@qapaq/contracts';

import {
  normalizeWazuhAlert,
  normalizeWazuhPage,
  WAZUH_MAPPING_ID,
  WAZUH_MAPPING_VERSION,
  WAZUH_PARSER_VERSION,
  type WazuhAlertInput,
  type WazuhNormalizationContext,
} from '../src/wazuh-normalization.js';

const context: WazuhNormalizationContext = {
  tenantId: 'tenant-qapaq-001',
  instanceId: 'siem-qapaq-lab',
  connector: 'qapaq-wazuh-indexer',
  connectorVersion: '1.0.0',
  receivedAt: new Date('2026-09-30T12:00:00.000Z'),
};

function rawProof(sizeBytes = 2048, suffix = '01') {
  return {
    ref: `raw:tenant-qapaq-001/2026/09/30/evt-${suffix}`,
    sha256: `${suffix.padStart(2, '0').repeat(32)}`.slice(0, 64),
    mediaType: 'application/json',
    sizeBytes,
  };
}

function alert(overrides: Record<string, unknown> = {}, suffix = '01'): WazuhAlertInput {
  return {
    record: {
      sourceRecordId: `evt-${suffix}`,
      dataset: 'alerts',
      collectedAt: '2026-09-30T11:59:30.000Z',
      raw: {
        timestamp: '2026-09-30T11:59:00.000Z',
        rule: {
          id: 5716,
          level: 10,
          description: 'SSHD authentication failed',
          groups: ['sshd', 'authentication_failed'],
        },
        agent: { id: '003', name: 'workstation.qapaq.local' },
        data: { srcuser: 'jperez@qapaq.pe', srcip: '10.4.21.88' },
        ...overrides,
      },
    },
    raw: rawProof(2048, suffix),
  };
}

describe('C-12 normalización de alertas Wazuh', () => {
  it('convierte una alerta válida en un documento que cumple el contrato', () => {
    const outcome = normalizeWazuhAlert(alert(), context);

    expect(outcome.status).toBe('normalized');
    if (outcome.status !== 'normalized') return;

    expect(validateSecurityEvent(outcome.event).valid).toBe(true);
    expect(outcome.event.kind).toBe('alert');
    expect(outcome.event.source.product).toBe('Wazuh');
    expect(outcome.event.eventUid).toBe('siem-qapaq-lab:alerts:evt-01');
    expect(outcome.event.detection?.rule.id).toBe('5716');
  });

  it('deriva severidad y categoría del catálogo, no del texto del proveedor', () => {
    const outcome = normalizeWazuhAlert(alert(), context);
    if (outcome.status !== 'normalized') throw new Error('se esperaba normalización');

    // Nivel 10 cae en la banda 8–11 de la escala declarada.
    expect(outcome.event.severity.normalized).toBe('high');
    expect(outcome.event.severity.score).toBe(75);
    expect(outcome.event.severity.originalValue).toBe(10);
    expect(outcome.event.severity.originalScale).toBe('provider-level-0-15');
    expect(outcome.event.category).toEqual(['authentication']);
    expect(outcome.event.outcome).toBe('failure');
  });

  it('cae en unclassified cuando ningún grupo del proveedor es conocido', () => {
    const outcome = normalizeWazuhAlert(
      alert({
        rule: { id: 1, level: 3, description: 'Regla desconocida', groups: ['grupo_inventado'] },
      }),
      context,
    );
    if (outcome.status !== 'normalized') throw new Error('se esperaba normalización');

    expect(outcome.event.category).toEqual(['unclassified']);
    expect(outcome.event.severity.normalized).toBe('low');
  });

  it('la versión del mapping viaja dentro del evento', () => {
    const outcome = normalizeWazuhAlert(alert(), context);
    if (outcome.status !== 'normalized') throw new Error('se esperaba normalización');

    expect(outcome.event.provenance.mappingVersion).toBe(WAZUH_MAPPING_VERSION);
    expect(outcome.event.provenance.parserVersion).toBe(WAZUH_PARSER_VERSION);
    expect(outcome.event.severity.mappingVersion).toBe(WAZUH_MAPPING_VERSION);
    expect(outcome.event.provenance.ingestionPath.at(-1)?.product).toBe('QAPAQ SecOps');
  });

  it('no deja pasar al evento ningún campo no declarado por el mapping', () => {
    const outcome = normalizeWazuhAlert(
      alert({
        campo_no_declarado: 'VALOR-FILTRADO',
        data: { srcuser: 'jperez@qapaq.pe', password: 'super-secreta' },
      }),
      context,
    );
    if (outcome.status !== 'normalized') throw new Error('se esperaba normalización');

    const serialized = JSON.stringify(outcome.event);
    expect(serialized).not.toContain('VALOR-FILTRADO');
    expect(serialized).not.toContain('campo_no_declarado');
    expect(serialized).not.toContain('super-secreta');
    expect(outcome.event.extensions).toBeUndefined();
  });

  it('produce identidades estables entre reintentos del mismo registro', () => {
    const first = normalizeWazuhAlert(alert(), context);
    const second = normalizeWazuhAlert(alert(), context);
    if (first.status !== 'normalized' || second.status !== 'normalized') {
      throw new Error('se esperaba normalización');
    }

    expect(first.event.recordId).toBe(second.event.recordId);
    expect(first.event.eventUid).toBe(second.event.eventUid);
  });
});

describe('C-12 rechazo seguro con código estable', () => {
  it('rechaza un documento sobredimensionado antes de construir el evento', () => {
    const oversized: WazuhAlertInput = {
      ...alert(),
      raw: rawProof(SECURITY_EVENT_LIMITS.rawSizeBytes + 1),
    };
    const outcome = normalizeWazuhAlert(oversized, context);

    expect(outcome.status).toBe('quarantined');
    if (outcome.status !== 'quarantined') return;
    expect(outcome.quarantined.reason.code).toBe('RAW_TOO_LARGE');
    expect(outcome.quarantined.reason.path).toBe('/raw/sizeBytes');
  });

  it.each([
    ['sin instante de ocurrencia', { timestamp: undefined }, 'MISSING_TIMESTAMP'],
    ['con instante sin zona horaria', { timestamp: '2026-09-30T11:59:00' }, 'INVALID_TIMESTAMP'],
    ['con instante imposible', { timestamp: '2026-02-31T11:59:00Z' }, 'INVALID_TIMESTAMP'],
    ['sin regla', { rule: undefined }, 'MISSING_RULE'],
    [
      'con nivel fuera de escala',
      { rule: { id: 1, level: 42, description: 'x', groups: [] } },
      'INVALID_RULE_LEVEL',
    ],
    [
      'con nivel no entero',
      { rule: { id: 1, level: 3.5, description: 'x', groups: [] } },
      'INVALID_RULE_LEVEL',
    ],
    [
      'sin descripción de regla',
      { rule: { id: 1, level: 5, groups: [] } },
      'INVALID_RULE_IDENTITY',
    ],
  ])('aísla una alerta %s con código %s', (_label, overrides, expected) => {
    const input = alert();
    const raw = { ...(input.record.raw as Record<string, unknown>) };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete raw[key];
      else raw[key] = value;
    }

    const outcome = normalizeWazuhAlert({ ...input, record: { ...input.record, raw } }, context);

    expect(outcome.status).toBe('quarantined');
    if (outcome.status !== 'quarantined') return;
    expect(outcome.quarantined.reason.code).toBe(expected);
  });

  it('rechaza un documento crudo que no es un objeto JSON plano', () => {
    const input = alert();
    const outcome = normalizeWazuhAlert(
      { ...input, record: { ...input.record, raw: [] as unknown as Record<string, unknown> } },
      context,
    );

    expect(outcome.status).toBe('quarantined');
    if (outcome.status !== 'quarantined') return;
    expect(outcome.quarantined.reason.code).toBe('RAW_NOT_OBJECT');
  });

  it('toda cuarentena conserva el linaje al objeto crudo que la originó', () => {
    const input = alert();
    const outcome = normalizeWazuhAlert(
      { ...input, record: { ...input.record, raw: {} } },
      context,
    );
    if (outcome.status !== 'quarantined') throw new Error('se esperaba cuarentena');

    expect(outcome.quarantined.rawRef).toBe(input.raw.ref);
    expect(outcome.quarantined.rawSha256).toBe(input.raw.sha256);
    expect(outcome.quarantined.sourceRecordId).toBe('evt-01');
    expect(outcome.quarantined.mappingId).toBe(WAZUH_MAPPING_ID);
    expect(outcome.quarantined.mappingVersion).toBe(WAZUH_MAPPING_VERSION);
    expect(outcome.quarantined.quarantinedAt).toBe('2026-09-30T12:00:00.000Z');
  });
});

describe('C-12 failure path: un documento malo no aborta la página', () => {
  it('normaliza el resto de la página y aísla solo lo que no cumple', () => {
    const page: WazuhAlertInput[] = [
      alert({}, '01'),
      alert({ timestamp: 'no-es-una-fecha' }, '02'),
      alert({}, '03'),
      alert({ rule: undefined }, '04'),
      alert({}, '05'),
    ];

    const result = normalizeWazuhPage(page, context);

    expect(result.counts).toEqual({ received: 5, normalized: 3, quarantined: 2 });
    expect(result.normalized).toHaveLength(3);
    expect(result.quarantined.map((item) => item.reason.code)).toEqual([
      'INVALID_TIMESTAMP',
      'MISSING_RULE',
    ]);
    // Nada se pierde: cada registro recibido sale normalizado o en cuarentena.
    expect(result.counts.normalized + result.counts.quarantined).toBe(result.counts.received);
  });

  it('cada documento normalizado de la página cumple el contrato', () => {
    const page = [alert({}, '01'), alert({ rule: undefined }, '02'), alert({}, '03')];
    const result = normalizeWazuhPage(page, context);

    for (const event of result.normalized) {
      expect(validateSecurityEvent(event).valid).toBe(true);
    }
  });

  it('una página sin registros no produce efectos', () => {
    const result = normalizeWazuhPage([], context);
    expect(result.counts).toEqual({ received: 0, normalized: 0, quarantined: 0 });
  });
});
