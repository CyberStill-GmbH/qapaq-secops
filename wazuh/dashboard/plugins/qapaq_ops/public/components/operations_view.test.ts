import { describe, expect, it } from 'vitest';
import {
  CorrelatorFeedbackStatus,
  OperationsStatus,
  SocCorrelatorHealth,
} from '../../common/api_contract';
import {
  describeCorrelatorHealth,
  formatLatencySummary,
  formatOutboxQueueSummary,
} from './operations_view';

describe('operations correlator contract and copy', () => {
  const correlator = (
    feedbackStatus: CorrelatorFeedbackStatus,
    overrides: Partial<SocCorrelatorHealth> = {},
  ): SocCorrelatorHealth => ({
    status: 'OK' as OperationsStatus,
    ready: feedbackStatus === 'ready',
    feedbackStatus,
    feedbackAgeSeconds: null,
    lastFeedbackSuccess: null,
    ...overrides,
  });

  it.each([
    ['ready', 'Listo'],
    ['pending', 'Inicializando'],
    ['failed', 'Refresh fallido'],
    ['unavailable', 'Sin respuesta'],
    ['unconfigured', 'No configurado'],
  ] as const)('labels feedback status %s as %s', (feedbackStatus, label) => {
    expect(describeCorrelatorHealth(correlator(feedbackStatus)).label).toBe(label);
  });

  it('shows stale age and last successful refresh data without internal details', () => {
    const status = describeCorrelatorHealth(
      correlator('stale', {
        status: 'STALE',
        ready: false,
        feedbackAgeSeconds: 125,
        lastFeedbackSuccess: '2026-11-12T10:00:00.000Z',
      }),
    );
    expect(status.label).toBe('Atrasado · 2 min sin refresh');
    expect(status.tone).toBe('warn');
  });

  it('reports a missing correlator response and degraded overall readiness clearly', () => {
    expect(describeCorrelatorHealth(undefined).label).toBe('Sin respuesta');
    expect(
      describeCorrelatorHealth(
        correlator('ready', { status: 'DEGRADED', ready: false }),
      ).label,
    ).toBe('Degradado');
  });
});

describe('operations latency copy', () => {
  it('uses readable separators and Spanish labels for handler latency', () => {
    expect(formatLatencySummary(1.4, 2.6, 3.2, 8)).toBe(
      'p50 1 ms · p95 3 ms · p99 3 ms · 8 muestras',
    );
  });

  it('falls back to p95 when p50 or p99 is unavailable', () => {
    expect(formatLatencySummary(null, 12, null, 1)).toBe(
      'p50 0 ms · p95 12 ms · p99 12 ms · 1 muestra',
    );
  });
});

describe('operations outbox lease copy', () => {
  it('shows expired lease count and age without inventing age when there are none', () => {
    expect(
      formatOutboxQueueSummary({
        pending: 2,
        processing: 3,
        oldestPendingAgeSeconds: 61,
        expiredProcessing: 2,
        oldestExpiredLeaseAgeSeconds: 9,
      }),
    ).toBe(
      '2 pendientes · 3 en curso · más antigua 1 min · 2 leases vencidos · lease más antiguo vencido hace 9 s',
    );
    expect(
      formatOutboxQueueSummary({
        pending: 0,
        processing: 1,
        oldestPendingAgeSeconds: null,
        expiredProcessing: 0,
        oldestExpiredLeaseAgeSeconds: null,
      }),
    ).toBe('0 pendientes · 1 en curso · más antigua Sin dato · 0 leases vencidos');
  });
});
