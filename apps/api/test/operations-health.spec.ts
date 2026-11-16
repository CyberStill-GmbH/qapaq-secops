import { describe, expect, it } from 'vitest';

import {
  correlatorHealth,
  HEALTH_THRESHOLDS,
  platformSection,
  socSection,
  summarySection,
  worstStatus,
} from '../src/soc/operations-health.js';

/** Observabilidad operativa: estados derivados de señales, sin adivinar salud. */
const AT = new Date('2026-10-12T12:00:00.000Z');

describe('operations/health · estados', () => {
  it('expone correlador como NO_DATA si no está configurado y degrada señales no listas', () => {
    const unconfigured = correlatorHealth(undefined);
    expect(unconfigured).toEqual({
      status: 'NO_DATA',
      ready: null,
      feedbackStatus: 'unconfigured',
      feedbackAgeSeconds: null,
      lastFeedbackSuccess: null,
    });
    const section = socSection(
      {
        persistence: 'postgres',
        dispatcherRunning: true,
        outbox: {
          pending: 0,
          processing: 0,
          oldestPendingAt: null,
          expiredProcessing: 0,
          oldestExpiredProcessingLeaseUntil: null,
        },
        notificationsByStatus: {},
        correlator: correlatorHealth({
          status: 503,
          body: {
            ready: false,
            status: 'degraded',
            feedbackReady: false,
            feedbackStatus: 'stale',
            feedbackAgeSeconds: 45,
            lastFeedbackSuccess: '2026-10-12T11:59:15.000Z',
            reason: 'raw detail must be discarded',
          },
        }),
      },
      AT,
    );
    expect(section.status).toBe('DEGRADED');
    expect(section.degradedReasons).toContain('CORRELATOR_NOT_READY');
    expect(section.correlator).toEqual({
      status: 'DEGRADED',
      ready: false,
      feedbackStatus: 'stale',
      feedbackAgeSeconds: 45,
      lastFeedbackSuccess: '2026-10-12T11:59:15.000Z',
    });
    expect(JSON.stringify(section)).not.toContain('raw detail');
  });

  it('solo acepta status HTTP y body coherentes con el contrato de /readyz', () => {
    const readyBody = {
      ready: true,
      status: 'ready',
      feedbackReady: true,
      feedbackStatus: 'ready',
      feedbackAgeSeconds: 0,
      lastFeedbackSuccess: '2026-10-12T12:00:00.000Z',
    };
    expect(correlatorHealth({ status: 200, body: readyBody })).toEqual({
      status: 'OK',
      ready: true,
      feedbackStatus: 'ready',
      feedbackAgeSeconds: 0,
      lastFeedbackSuccess: '2026-10-12T12:00:00.000Z',
    });
    expect(correlatorHealth({ status: 503, body: readyBody })).toMatchObject({
      status: 'DEGRADED',
      ready: null,
      feedbackStatus: 'unavailable',
    });
    expect(
      correlatorHealth({ status: 200, body: { ...readyBody, feedbackAgeSeconds: '0' } }),
    ).toMatchObject({ status: 'DEGRADED', feedbackStatus: 'unavailable' });
    expect(correlatorHealth(null)).toMatchObject({
      status: 'DEGRADED',
      ready: null,
      feedbackStatus: 'unavailable',
      feedbackAgeSeconds: null,
      lastFeedbackSuccess: null,
    });
  });

  it('sin alertas el resumen es NO_DATA y la cobertura de fuentes se declara NO_DATA', () => {
    const summary = summarySection({ lastAlertAt: null }, AT);
    expect(summary).toMatchObject({ status: 'NO_DATA', sourceCoverage: 'NO_DATA' });
  });

  it('calcula la frescura de la última alerta', () => {
    const summary = summarySection({ lastAlertAt: new Date(AT.getTime() - 90_000) }, AT);
    expect(summary).toMatchObject({ status: 'OK', alertFreshnessSeconds: 90 });
  });

  it('usa la salud real de fuente para cobertura y no la antigüedad de una alerta', () => {
    const summary = summarySection(
      { lastAlertAt: new Date(AT.getTime() - 30 * 86_400_000), sourceStatus: 'DEGRADED' },
      AT,
    );
    expect(summary).toMatchObject({ status: 'DEGRADED', sourceCoverage: 'DEGRADED' });
  });

  it('degrada el SOC con despacho detenido, backlog viejo o persistencia efímera', () => {
    const base = {
      persistence: 'postgres' as const,
      dispatcherRunning: true,
      outbox: {
        pending: 0,
        processing: 0,
        oldestPendingAt: null,
        expiredProcessing: 0,
        oldestExpiredProcessingLeaseUntil: null,
      },
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
      socSection(
        {
          ...base,
          outbox: {
            pending: 1,
            processing: 0,
            oldestPendingAt: stale,
            expiredProcessing: 0,
            oldestExpiredProcessingLeaseUntil: null,
          },
        },
        AT,
      ).degradedReasons,
    ).toEqual(['OUTBOX_BACKLOG']);
    expect(socSection({ ...base, persistence: 'memory' }, AT).degradedReasons).toEqual([
      'PERSISTENCE_EPHEMERAL',
    ]);
  });

  it('degrada el SOC si Teams no está configurado o ningún canal puede entregar un P1', () => {
    const base = {
      persistence: 'postgres' as const,
      dispatcherRunning: true,
      outbox: {
        pending: 0,
        processing: 0,
        oldestPendingAt: null,
        expiredProcessing: 0,
        oldestExpiredProcessingLeaseUntil: null,
      },
      notificationsByStatus: {},
    };
    const channel = (id: string, configured: boolean, enabled: boolean) => ({
      id,
      configured,
      enabled,
      setup: !configured ? 'configure' : !enabled ? 'enable' : 'ready',
    });
    // Sin registro de canales no se opina.
    expect(socSection(base, AT).notifications.channels).toBeNull();
    const fresh = socSection(
      {
        ...base,
        notificationChannels: [
          channel('teams', false, false),
          channel('email', false, false),
          channel('push', true, true),
        ],
      },
      AT,
    );
    expect(fresh.status).toBe('DEGRADED');
    // El push a navegadores no cuenta como entrega de un P1.
    expect(fresh.degradedReasons).toEqual([
      'NOTIFICATION_TEAMS_NOT_CONFIGURED',
      'NOTIFICATION_NO_P1_CHANNEL',
    ]);
    expect(fresh.notifications.channels).toHaveLength(3);
    expect(
      socSection(
        {
          ...base,
          notificationChannels: [channel('teams', false, false), channel('email', true, true)],
        },
        AT,
      ).degradedReasons,
    ).toEqual(['NOTIFICATION_TEAMS_NOT_CONFIGURED']);
    // Configurado pero apagado: Teams existe, pero nadie entrega.
    expect(
      socSection(
        {
          ...base,
          notificationChannels: [channel('teams', true, false), channel('email', false, false)],
        },
        AT,
      ).degradedReasons,
    ).toEqual(['NOTIFICATION_NO_P1_CHANNEL']);
    expect(
      socSection(
        {
          ...base,
          notificationChannels: [channel('teams', true, true), channel('email', false, false)],
        },
        AT,
      ).status,
    ).toBe('OK');
  });

  it('degrada el SOC si en la ventana hubo intentos fallidos, indeterminados o por fallback', () => {
    const section = socSection(
      {
        persistence: 'postgres',
        dispatcherRunning: true,
        outbox: {
          pending: 0,
          processing: 0,
          oldestPendingAt: null,
          expiredProcessing: 0,
          oldestExpiredProcessingLeaseUntil: null,
        },
        notificationsByStatus: { sent: 4, failed: 1, fallback: 1 },
      },
      AT,
    );
    expect(section.degradedReasons).toEqual(['NOTIFICATION_FAILED', 'NOTIFICATION_FALLBACK']);
    expect(section.notifications).toMatchObject({ windowHours: 24, byStatus: { sent: 4 } });
  });

  it('expone percentiles de aceptación HTTP y conserva NO_DATA sin muestras', () => {
    const base = {
      persistence: 'postgres' as const,
      dispatcherRunning: true,
      outbox: {
        pending: 0,
        processing: 0,
        oldestPendingAt: null,
        expiredProcessing: 0,
        oldestExpiredProcessingLeaseUntil: null,
      },
      notificationsByStatus: {},
    };
    const measured = socSection(
      {
        ...base,
        providerAcceptanceLatency: {
          windowHours: 24,
          sampleCount: 3,
          excludedClockSkewCount: 1,
          sampleCapReached: false,
          p50: 120,
          p95: 220,
          p99: 230,
        },
      },
      AT,
    );
    expect(measured.outboxToProviderAcceptanceMs).toMatchObject({
      status: 'OK',
      windowHours: 24,
      sampleCount: 3,
      excludedClockSkewCount: 1,
      p50: 120,
      p95: 220,
      p99: 230,
    });
    expect(measured.outboxToProviderAcceptanceMs.acceptanceMeans).toContain('does not mean');

    const noData = socSection({ ...base, persistence: 'memory' }, AT);
    expect(noData.outboxToProviderAcceptanceMs).toMatchObject({
      status: 'NO_DATA',
      sampleCount: 0,
      p50: null,
      p95: null,
      p99: null,
    });
  });

  it('expone antigüedad y fallos de la inbox Wazuh sin exponer hints', () => {
    const section = socSection(
      {
        persistence: 'postgres',
        dispatcherRunning: true,
        outbox: {
          pending: 0,
          processing: 0,
          oldestPendingAt: null,
          expiredProcessing: 0,
          oldestExpiredProcessingLeaseUntil: null,
        },
        notificationsByStatus: {},
        wazuhPushInbox: {
          counts: { pending: 2, processing: 1, processed: 20, 'failed-terminal': 1 },
          oldestPendingAt: new Date(AT.getTime() - 4_000),
          oldestProcessingAt: new Date(AT.getTime() - 8_000),
          oldestUnresolvedAt: new Date(AT.getTime() - 8_000),
          oldestTerminalAt: new Date(AT.getTime() - 60_000),
          lastProcessedAt: new Date(AT.getTime() - 1_000),
          expiredProcessing: 1,
          terminalFailuresRecent: 1,
          terminalWindowHours: 24,
          sourceToReceiptMs: {
            windowHours: 24,
            sampleCount: 10,
            clockSkewSamples: 2,
            sampleCapReached: false,
            p50: 400,
            p95: 900,
            p99: 980,
          },
          receiptToHandlerMs: { windowHours: 24, sampleCount: 12, p50: 250, p95: 800, p99: 950 },
        },
      },
      AT,
    );
    expect(section.status).toBe('DEGRADED');
    expect(section.degradedReasons).toContain('WAZUH_PUSH_TERMINAL_FAILURES');
    expect(section.degradedReasons).toContain('WAZUH_PUSH_LEASE_EXPIRED');
    expect(section.wazuhPushInbox).toMatchObject({
      oldestUnresolvedAgeSeconds: 8,
      oldestTerminalAgeSeconds: 60,
      expiredProcessing: 1,
      terminalFailuresRecent: 1,
      sourceToReceiptMs: {
        windowHours: 24,
        sampleCount: 10,
        clockSkewSamples: 2,
        sampleCapReached: false,
        p50: 400,
        p95: 900,
        p99: 980,
      },
      receiptToHandlerMs: {
        windowHours: 24,
        sampleCount: 12,
        p50: 250,
        p95: 800,
        p99: 950,
      },
    });
    expect(JSON.stringify(section)).not.toContain('alertId');
  });

  it('degrada y expone el número y edad del lease vencido más antiguo del outbox', () => {
    const expiredAt = new Date(AT.getTime() - 9_000);
    const section = socSection(
      {
        persistence: 'postgres',
        dispatcherRunning: true,
        outbox: {
          pending: 0,
          processing: 3,
          oldestPendingAt: null,
          expiredProcessing: 2,
          oldestExpiredProcessingLeaseUntil: expiredAt,
        },
        notificationsByStatus: {},
      },
      AT,
    );

    expect(section.status).toBe('DEGRADED');
    expect(section.degradedReasons).toContain('OUTBOX_LEASE_EXPIRED');
    expect(section.outbox).toMatchObject({
      processing: 3,
      expiredProcessing: 2,
      oldestExpiredLeaseAgeSeconds: 9,
    });
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
