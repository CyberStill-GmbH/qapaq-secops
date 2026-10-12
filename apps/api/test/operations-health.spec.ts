import { describe, expect, it } from 'vitest';

import {
  HEALTH_THRESHOLDS,
  platformSection,
  socSection,
  summarySection,
  worstStatus,
} from '../src/soc/operations-health.js';

/** Observabilidad operativa: estados derivados de señales, sin adivinar salud. */
const AT = new Date('2026-10-12T12:00:00.000Z');

describe('operations/health · estados', () => {
  it('sin alertas el resumen es NO_DATA y la cobertura de fuentes se declara NO_DATA', () => {
    const summary = summarySection({ lastAlertAt: null }, AT);
    expect(summary).toMatchObject({ status: 'NO_DATA', sourceCoverage: 'NO_DATA' });
  });

  it('calcula la frescura de la última alerta', () => {
    const summary = summarySection({ lastAlertAt: new Date(AT.getTime() - 90_000) }, AT);
    expect(summary).toMatchObject({ status: 'OK', alertFreshnessSeconds: 90 });
  });

  it('degrada el SOC con despacho detenido, backlog viejo o persistencia efímera', () => {
    const base = {
      persistence: 'postgres' as const,
      dispatcherRunning: true,
      outbox: { pending: 0, processing: 0, oldestPendingAt: null },
      notificationsByStatus: {},
    };
    expect(socSection(base, AT).status).toBe('OK');
    expect(socSection({ ...base, dispatcherRunning: false }, AT).degradedReasons).toEqual([
      'DISPATCHER_STOPPED',
    ]);
    const stale = new Date(
      AT.getTime() - (HEALTH_THRESHOLDS.outboxOldestPendingSeconds + 1) * 1000,
    );
    expect(
      socSection({ ...base, outbox: { pending: 1, processing: 0, oldestPendingAt: stale } }, AT)
        .degradedReasons,
    ).toEqual(['OUTBOX_BACKLOG']);
    expect(socSection({ ...base, persistence: 'memory' }, AT).degradedReasons).toEqual([
      'PERSISTENCE_EPHEMERAL',
    ]);
  });

  it('degrada el SOC si en la ventana hubo intentos fallidos, indeterminados o por fallback', () => {
    const section = socSection(
      {
        persistence: 'postgres',
        dispatcherRunning: true,
        outbox: { pending: 0, processing: 0, oldestPendingAt: null },
        notificationsByStatus: { sent: 4, failed: 1, fallback: 1 },
      },
      AT,
    );
    expect(section.degradedReasons).toEqual(['NOTIFICATION_FAILED', 'NOTIFICATION_FALLBACK']);
    expect(section.notifications).toMatchObject({ windowHours: 24, byStatus: { sent: 4 } });
  });

  it('degrada la plataforma si la base no responde o responde lento', () => {
    const base = {
      processMetrics: { uptimeSeconds: 10, memoryRssBytes: 50 * 1024 * 1024, nodeVersion: 'v24' },
    };
    expect(platformSection({ ...base, databaseLatencyMs: 12 }, AT).status).toBe('OK');
    expect(platformSection({ ...base, databaseLatencyMs: null }, AT).degradedReasons).toEqual([
      'DATABASE_UNAVAILABLE',
    ]);
    expect(platformSection({ ...base, databaseLatencyMs: 5_000 }, AT).degradedReasons).toEqual([
      'DATABASE_SLOW',
    ]);
  });

  it('sin proveedor de proceso reporta null en lugar de inventar métricas', () => {
    const section = platformSection({ processMetrics: null, databaseLatencyMs: 3 }, AT);
    expect(section).toMatchObject({ status: 'OK', uptimeSeconds: null, memoryRssMb: null });
  });

  it('el estado global es el peor visible; NO_DATA no degrada', () => {
    expect(worstStatus(['OK', 'NO_DATA'])).toBe('NO_DATA');
    expect(worstStatus(['OK', 'DEGRADED', 'NO_DATA'])).toBe('DEGRADED');
    expect(worstStatus([])).toBe('OK');
  });
});
