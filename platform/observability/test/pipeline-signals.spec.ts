import { describe, expect, it } from 'vitest';

import { CardinalityBudget, checkLabels, MAXIMUM_LABEL_VALUE_LENGTH } from '../src/label-guard.js';
import {
  DEFAULT_HEALTH_THRESHOLDS,
  deriveRates,
  evaluateHealth,
  type PipelineSignals,
} from '../src/pipeline-health.js';

function signals(overrides: Partial<PipelineSignals> = {}): PipelineSignals {
  return {
    dependenciesDown: [],
    lastSuccessAgeSeconds: 30,
    ingestionLagSeconds: 10,
    quarantineRate: 0,
    errorRate: 0,
    ...overrides,
  };
}

describe('C-15 etiquetas: ninguna filtra dato sensible', () => {
  it('acepta un juego de etiquetas acotado y declarado', () => {
    const check = checkLabels({
      component: 'telemetry',
      stage: 'normalization',
      dataset: 'alerts',
      severity: 'high',
      result: 'quarantined',
    });

    if (!check.ok) throw new Error('se esperaba aceptación');
    expect(check.labels).toEqual({
      component: 'telemetry',
      stage: 'normalization',
      dataset: 'alerts',
      severity: 'high',
      result: 'quarantined',
    });
  });

  it('rechaza una clave no declarada', () => {
    const check = checkLabels({ principal: 'jperez' });
    if (check.ok) throw new Error('se esperaba rechazo');
    expect(check.rejections).toEqual([{ key: 'principal', violation: 'KEY_NOT_ALLOWED' }]);
  });

  it.each([
    ['IP v4', '10.4.21.88', 'VALUE_LOOKS_LIKE_IP'],
    ['IP v6', 'fe80::1ff:fe23:4567', 'VALUE_LOOKS_LIKE_IP'],
    ['usuario', 'jperez@qapaq.pe', 'VALUE_LOOKS_LIKE_PRINCIPAL'],
    ['URL', 'https://wazuh.qapaq.local/api', 'VALUE_LOOKS_LIKE_URL'],
    ['query string', 'search?q=secret', 'VALUE_LOOKS_LIKE_URL'],
    ['token JWT', 'eyJhbGciOiJIUzI1NiJ9.payload', 'VALUE_LOOKS_LIKE_SECRET'],
    ['bearer', 'Bearer abc123', 'VALUE_LOOKS_LIKE_SECRET'],
    ['huella larga', 'a'.repeat(40), 'VALUE_LOOKS_LIKE_SECRET'],
  ])('rechaza %s en el valor de una etiqueta permitida', (_label, value, violation) => {
    const check = checkLabels({ dataset: value });
    if (check.ok) throw new Error('se esperaba rechazo');
    expect(check.rejections[0]).toEqual({ key: 'dataset', violation });
  });

  it('rechaza un valor vacío o desmedido', () => {
    const empty = checkLabels({ stage: '' });
    if (empty.ok) throw new Error('se esperaba rechazo');
    expect(empty.rejections[0]?.violation).toBe('VALUE_EMPTY');

    const long = checkLabels({ stage: 'a'.repeat(MAXIMUM_LABEL_VALUE_LENGTH + 1) });
    if (long.ok) throw new Error('se esperaba rechazo');
    expect(long.rejections[0]?.violation).toBe('VALUE_TOO_LONG');
  });

  it('reporta todas las violaciones del juego, no solo la primera', () => {
    const check = checkLabels({
      dataset: '10.4.21.88',
      stage: 'jperez@qapaq.pe',
      usuario: 'x',
    });

    if (check.ok) throw new Error('se esperaba rechazo');
    expect(check.rejections).toHaveLength(3);
  });

  it('un identificador de evento no pasa como etiqueta: sería una serie por evento', () => {
    const check = checkLabels({ status: '01890f47-7abc-7def-8abc-0123456789ab' });
    if (check.ok) throw new Error('se esperaba rechazo');
    expect(check.rejections[0]?.violation).toBe('VALUE_LOOKS_LIKE_IDENTIFIER');
  });
});

describe('C-15 presupuesto de cardinalidad', () => {
  it('admite valores hasta el tope y luego los rechaza', () => {
    const budget = new CardinalityBudget(3);

    expect(budget.admit('dataset', 'alerts')).toBe(true);
    expect(budget.admit('dataset', 'audit')).toBe(true);
    expect(budget.admit('dataset', 'syslog')).toBe(true);
    expect(budget.admit('dataset', 'cuarto')).toBe(false);
    expect(budget.cardinality('dataset')).toBe(3);
  });

  it('un valor repetido no consume presupuesto', () => {
    const budget = new CardinalityBudget(2);
    budget.admit('stage', 'ingest');
    budget.admit('stage', 'ingest');
    budget.admit('stage', 'ingest');
    expect(budget.cardinality('stage')).toBe(1);
  });

  it('lista las claves desbordadas para poder alertarlas', () => {
    const budget = new CardinalityBudget(1);
    budget.admit('dataset', 'alerts');
    budget.admit('dataset', 'audit');
    expect(budget.exceededKeys()).toEqual(['dataset']);
  });

  it('exige un presupuesto positivo', () => {
    expect(() => new CardinalityBudget(0)).toThrow(RangeError);
  });
});

describe('C-15 salud: los tres estados se provocan y se observan', () => {
  it('healthy cuando todas las señales están dentro de umbral', () => {
    expect(evaluateHealth(signals())).toEqual({ state: 'healthy', reasons: [] });
  });

  it('degraded por retraso de ingesta', () => {
    const assessment = evaluateHealth(
      signals({ ingestionLagSeconds: DEFAULT_HEALTH_THRESHOLDS.lagDegradedSeconds }),
    );
    expect(assessment).toEqual({ state: 'degraded', reasons: ['INGESTION_LAG'] });
  });

  it('failed por dependencia caída, con la dependencia nombrada en la señal', () => {
    const assessment = evaluateHealth(signals({ dependenciesDown: ['opensearch'] }));
    expect(assessment).toEqual({ state: 'failed', reasons: ['DEPENDENCY_DOWN'] });
  });

  it('failed por tasa de cuarentena sostenida', () => {
    const assessment = evaluateHealth(
      signals({ quarantineRate: DEFAULT_HEALTH_THRESHOLDS.quarantineFailedRate }),
    );
    expect(assessment.state).toBe('failed');
    expect(assessment.reasons).toContain('QUARANTINE_RATE');
  });

  it('degraded por ausencia de éxito reciente', () => {
    const assessment = evaluateHealth(
      signals({ lastSuccessAgeSeconds: DEFAULT_HEALTH_THRESHOLDS.staleSuccessDegradedSeconds }),
    );
    expect(assessment).toEqual({ state: 'degraded', reasons: ['NO_RECENT_SUCCESS'] });
  });

  it('se queda con el estado más grave y acumula todas las razones', () => {
    const assessment = evaluateHealth(
      signals({
        dependenciesDown: ['postgres'],
        ingestionLagSeconds: DEFAULT_HEALTH_THRESHOLDS.lagDegradedSeconds,
        errorRate: DEFAULT_HEALTH_THRESHOLDS.errorDegradedRate,
      }),
    );

    expect(assessment.state).toBe('failed');
    expect(assessment.reasons).toEqual(['DEPENDENCY_DOWN', 'INGESTION_LAG', 'ERROR_RATE']);
  });

  it('un degradado previo no se pierde al evaluar una señal sana después', () => {
    const assessment = evaluateHealth(
      signals({ ingestionLagSeconds: DEFAULT_HEALTH_THRESHOLDS.lagDegradedSeconds, errorRate: 0 }),
    );
    expect(assessment.state).toBe('degraded');
  });
});

describe('C-15 series derivadas del recorrido', () => {
  it('calcula cobertura, cuarentena y duplicados', () => {
    const rates = deriveRates({ received: 10, normalized: 7, quarantined: 2, duplicates: 1 });

    expect(rates.coverage).toBeCloseTo(0.7);
    expect(rates.quarantineRate).toBeCloseTo(0.2);
    expect(rates.duplicateRate).toBeCloseTo(0.1);
    expect(rates.lossless).toBe(true);
  });

  it('detecta pérdida cuando las salidas no suman la entrada', () => {
    const rates = deriveRates({ received: 10, normalized: 7, quarantined: 1, duplicates: 1 });
    expect(rates.lossless).toBe(false);
  });

  it('una ventana sin tráfico no se reporta como pérdida ni divide por cero', () => {
    expect(deriveRates({ received: 0, normalized: 0, quarantined: 0, duplicates: 0 })).toEqual({
      coverage: 1,
      quarantineRate: 0,
      duplicateRate: 0,
      lossless: true,
    });
  });
});
