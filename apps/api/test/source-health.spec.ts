/**
 * Sprint 5 · fase 2 — registro de transiciones de salud al terminar cada pasada.
 *
 * Solo un cambio de estado escribe: repetir el mismo estado no llena la bitácora ni la
 * auditoría. Cada transición deja un AuditEvent `source.health.changed` sin datos sensibles.
 */

import { describe, expect, it } from 'vitest';

import { InMemoryAuditStore } from '@qapaq/audit';
import { InMemoryIngestionState } from '@qapaq/soc';

import {
  measureSourceActivity,
  recordSourceHealth,
  sourceHealthMonitor,
} from '../src/runtime/source-health.js';

const KEY = { tenantId: 'tenant-sh', sourceId: 'wazuh-indexer', dataset: 'wazuh-alerts' };

describe('registro de la salud por fuente', () => {
  it('escribe una transición y un AuditEvent solo cuando cambia el estado', async () => {
    const state = new InMemoryIngestionState();
    const audit = new InMemoryAuditStore();
    const monitor = sourceHealthMonitor({
      key: KEY,
      displayName: 'Wazuh Indexer · alertas',
      enabled: true,
      intervalMs: 60_000,
    });
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 12, 20, minute));
    const observe = (minute: number, outcome: 'success' | 'permanent_error') =>
      state.recordObservation({
        id: `obs-${minute}`,
        ...KEY,
        attemptedAt: at(minute),
        completedAt: at(minute),
        outcome,
        recordsSeen: 0,
        promoted: 0,
        quarantined: 0,
        newestEventAt: null,
        errorClass: outcome === 'success' ? null : 'PROVIDER_AUTHENTICATION_FAILED',
      });

    await recordSourceHealth(monitor, state, audit, at(0));
    await observe(1, 'success');
    await recordSourceHealth(monitor, state, audit, at(1));
    await observe(2, 'success');
    await recordSourceHealth(monitor, state, audit, at(2));
    await observe(3, 'permanent_error');
    await recordSourceHealth(monitor, state, audit, at(3));

    const transitions = (await state.recentTransitions(KEY, 10)).map(
      (item) => `${item.fromState ?? '·'}→${item.toState}`,
    );
    expect(transitions).toEqual(['healthy→failed', 'unknown→healthy', '·→unknown']);
    const events = await audit.range('tenant-sh', 1n, 10);
    expect(events.map((event) => event.action)).toEqual([
      'source.health.changed',
      'source.health.changed',
      'source.health.changed',
    ]);
    expect(events.at(-1)).toMatchObject({
      reason: 'PERMANENT_ERROR',
      resource: { type: 'source', id: 'wazuh-indexer/wazuh-alerts' },
    });
  });
});

describe('actividad por suscripción', () => {
  it('mide como máximo cada 5 minutos, muestra streams callados y conserva su último evento', async () => {
    const state = new InMemoryIngestionState();
    const monitor = sourceHealthMonitor({
      key: KEY,
      displayName: 'Wazuh Indexer · alertas',
      enabled: true,
      intervalMs: 60_000,
    });
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 12, 20, minute));
    let response = [
      { stream: 'Audit.Exchange', count: 3, lastEventAt: '2026-10-12T19:50:00.000Z' },
    ];
    const queries: { from: string; to: string }[] = [];
    const measure = (minute: number) =>
      measureSourceActivity({
        monitor,
        state,
        readActivity: async (query) => {
          queries.push(query);
          return response;
        },
        expectedStreams: ['Audit.Exchange', 'Audit.SharePoint'],
        now: at(minute),
      });

    expect(await measure(0)).toBe(true);
    expect(queries[0]).toMatchObject({
      from: '2026-10-11T20:00:00.000Z',
      to: '2026-10-12T20:00:00.000Z',
    });
    expect(await measure(3)).toBe(false);

    response = [];
    expect(await measure(6)).toBe(true);
    const activity = await state.activity(KEY);
    expect(
      activity.map((record) => [
        record.stream,
        record.eventsInWindow,
        record.lastEventAt?.toISOString() ?? null,
      ]),
    ).toEqual([
      ['Audit.Exchange', 0, '2026-10-12T19:50:00.000Z'],
      ['Audit.SharePoint', 0, null],
    ]);
  });
});
