/**
 * Sprint 5 · fase 2 — máquina de estados de la salud por fuente, por tabla.
 *
 * Fija las reglas de source-health.md: nunca verde por omisión, «sin eventos» no es caída, y
 * la edad del último éxito decide degradado/caído con la política de la fuente.
 */

import { describe, expect, it } from 'vitest';

import { evaluateSourceHealth, type SourcePollObservation } from '../src/index.js';

const NOW = new Date('2026-10-12T20:00:00.000Z');
const POLICY = { intervalMs: 60_000, degradeAfterIntervals: 2, failAfterIntervals: 3 };

function observation(
  minutesAgo: number,
  outcome: SourcePollObservation['outcome'] = 'success',
  overrides: Partial<SourcePollObservation> = {},
): SourcePollObservation {
  const at = new Date(NOW.getTime() - minutesAgo * 60_000);
  return {
    id: `obs-${minutesAgo}-${outcome}`,
    tenantId: 't',
    sourceId: 'wazuh-indexer',
    dataset: 'wazuh-alerts',
    attemptedAt: at,
    completedAt: at,
    outcome,
    recordsSeen: 0,
    promoted: 0,
    quarantined: 0,
    newestEventAt: null,
    errorClass: outcome === 'success' ? null : 'PROVIDER_TIMEOUT',
    ...overrides,
  };
}

const cases: [string, SourcePollObservation[], boolean, string, string][] = [
  ['deshabilitada', [observation(0)], false, 'disabled', 'DISABLED'],
  ['sin observaciones', [], true, 'unknown', 'NO_OBSERVATIONS'],
  ['éxito reciente vacío', [observation(1)], true, 'healthy', 'RECENT_SUCCESS'],
  [
    'error permanente reciente',
    [observation(0, 'permanent_error'), observation(1)],
    true,
    'failed',
    'PERMANENT_ERROR',
  ],
  [
    'dos fallos transitorios seguidos',
    [observation(0, 'retryable_error'), observation(0.5, 'retryable_error'), observation(1)],
    true,
    'degraded',
    'CONSECUTIVE_FAILURES',
  ],
  ['último éxito hace 2,5 intervalos', [observation(2.5)], true, 'degraded', 'NO_RECENT_SUCCESS'],
  ['último éxito hace 4 intervalos', [observation(4)], true, 'failed', 'NO_RECENT_SUCCESS'],
  [
    'solo un fallo, reciente',
    [observation(0.5, 'retryable_error')],
    true,
    'unknown',
    'NEVER_SUCCEEDED',
  ],
  [
    'nunca hubo éxito y pasó la ventana de falla',
    [observation(0, 'retryable_error'), observation(5, 'retryable_error')],
    true,
    'failed',
    'NO_RECENT_SUCCESS',
  ],
];

describe('evaluateSourceHealth', () => {
  it.each(cases)('%s', (_name, observations, enabled, state, reason) => {
    expect(evaluateSourceHealth(observations, POLICY, NOW, enabled)).toMatchObject({
      state,
      reason,
    });
  });

  it('un éxito con cero filas avanza el último éxito y no el último evento', () => {
    const result = evaluateSourceHealth(
      [
        observation(1),
        observation(2, 'success', { newestEventAt: new Date('2026-10-12T19:10:00.000Z') }),
      ],
      POLICY,
      NOW,
      true,
    );
    expect(result.lastSuccessAt?.toISOString()).toBe('2026-10-12T19:59:00.000Z');
    expect(result.lastEventAt?.toISOString()).toBe('2026-10-12T19:10:00.000Z');
    expect(result.lastErrorClass).toBeNull();
  });

  it('reporta fallos consecutivos y el código del último error', () => {
    const result = evaluateSourceHealth(
      [observation(0, 'retryable_error'), observation(1)],
      POLICY,
      NOW,
      true,
    );
    expect(result).toMatchObject({ consecutiveFailures: 1, lastErrorClass: 'PROVIDER_TIMEOUT' });
  });
});
