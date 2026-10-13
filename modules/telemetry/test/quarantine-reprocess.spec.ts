import { describe, expect, it } from 'vitest';

import {
  applyReprocess,
  buildQuarantineEntry,
  decideReprocess,
  fromNormalizationQuarantine,
  resolveQuarantine,
  type QuarantineEntry,
  type QuarantineLineage,
} from '../src/quarantine-reprocess.js';
import { normalizeWazuhAlert, WAZUH_MAPPING_VERSION } from '../src/wazuh-normalization.js';

const AT = new Date('2026-10-01T10:00:00.000Z');

const lineage: QuarantineLineage = {
  sourceId: '00000000-0000-7000-8000-000000000001',
  manifestId: '00000000-0000-7000-8000-000000000002',
  inboxId: '00000000-0000-7000-8000-000000000003',
  rawEventReferenceId: '00000000-0000-7000-8000-000000000004',
  recordId: '00000000-0000-7000-8000-000000000005',
};

function entry(overrides: Partial<QuarantineEntry> = {}): QuarantineEntry {
  return {
    ...buildQuarantineEntry({ lineage, reason: { code: 'MISSING_RULE' }, at: AT }),
    ...overrides,
  };
}

describe('C-13 cuarentena con linaje', () => {
  it('conserva la referencia completa al crudo que la originó', () => {
    const built = buildQuarantineEntry({
      lineage,
      reason: { code: 'INVALID_TIMESTAMP', path: '/timestamp' },
      contractVersion: '1.0.0',
      parserVersion: '1.0.0',
      at: AT,
    });

    expect(built.lineage).toEqual(lineage);
    expect(built.errorCode).toBe('INVALID_TIMESTAMP');
    expect(built.errorPath).toBe('/timestamp');
    expect(built.status).toBe('quarantined');
    expect(built.attemptCount).toBe(0);
    expect(built.lastReprocessedAt).toBeNull();
  });

  it('rechaza construir una cuarentena sin linaje completo', () => {
    expect(() =>
      buildQuarantineEntry({
        lineage: { ...lineage, rawEventReferenceId: '' },
        reason: { code: 'MISSING_RULE' },
        at: AT,
      }),
    ).toThrow(/rawEventReferenceId/u);
  });

  it('traduce la cuarentena del normalizador conservando causa y versión', () => {
    const outcome = normalizeWazuhAlert(
      {
        record: {
          sourceRecordId: 'evt-99',
          dataset: 'alerts',
          collectedAt: '2026-10-01T09:59:00.000Z',
          raw: { timestamp: '2026-10-01T09:58:00.000Z' },
        },
        raw: {
          ref: 'raw:tenant/2026/10/01/evt-99',
          sha256: 'a'.repeat(64),
          mediaType: 'application/json',
          sizeBytes: 64,
        },
      },
      {
        tenantId: 'tenant-1',
        instanceId: 'siem-1',
        connector: 'qapaq-wazuh-indexer',
        connectorVersion: '1.0.0',
        receivedAt: AT,
      },
    );

    if (outcome.status !== 'quarantined') throw new Error('se esperaba cuarentena');
    const translated = fromNormalizationQuarantine(outcome.quarantined, lineage, AT);

    expect(translated.errorCode).toBe('MISSING_RULE');
    expect(translated.lineage).toEqual(lineage);
    // La cuarentena registra la versión del mapping que la produjo, no una fija.
    expect(translated.parserVersion).toBe(WAZUH_MAPPING_VERSION);
  });
});

describe('C-13 reproceso de cuarentena', () => {
  it('permite reprocesar e incrementa el intento', () => {
    expect(decideReprocess(entry())).toEqual({ effect: 'reprocess', attemptCount: 1 });
  });

  it('no reprocesa dos veces en paralelo', () => {
    expect(decideReprocess(entry({ status: 'reprocessing' }))).toEqual({
      effect: 'reject',
      reason: 'ALREADY_REPROCESSING',
    });
  });

  it('no reabre una cuarentena resuelta ni descartada', () => {
    expect(decideReprocess(entry({ status: 'resolved' })).effect).toBe('reject');
    expect(decideReprocess(entry({ status: 'discarded' })).effect).toBe('reject');
  });

  it('agota el presupuesto para que un veneno permanente no consuma la cola', () => {
    expect(decideReprocess(entry({ attemptCount: 3 }))).toEqual({
      effect: 'reject',
      reason: 'ATTEMPT_BUDGET_EXHAUSTED',
    });
  });

  it('el linaje sobrevive al reproceso y a la resolución', () => {
    const reprocessing = applyReprocess(entry(), AT);
    expect(reprocessing.status).toBe('reprocessing');
    expect(reprocessing.attemptCount).toBe(1);
    expect(reprocessing.lastReprocessedAt).toEqual(AT);
    expect(reprocessing.lineage).toEqual(lineage);

    const resolved = resolveQuarantine(reprocessing);
    expect(resolved.status).toBe('resolved');
    expect(resolved.lineage).toEqual(lineage);
    expect(resolved.errorCode).toBe(reprocessing.errorCode);
  });

  it('no resuelve una cuarentena que no está en reproceso', () => {
    expect(() => resolveQuarantine(entry())).toThrow(/reproceso/u);
  });

  it('no aplica un reproceso rechazado', () => {
    expect(() => applyReprocess(entry({ attemptCount: 3 }), AT)).toThrow(
      /ATTEMPT_BUDGET_EXHAUSTED/u,
    );
  });
});
