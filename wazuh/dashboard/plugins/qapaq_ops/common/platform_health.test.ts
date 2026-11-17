/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import {
  currentSourceState,
  parsePlatformHealth,
  platformHealthQuery,
  serviceSourceState,
} from './platform_health';
import { vendorOfProvider } from './vendors';

const doc = (timestamp: string, health: Record<string, unknown>) => ({
  latest: {
    hits: { hits: [{ _source: { timestamp, data: { qapaq: { health } } } }] },
  },
});

const body = {
  aggregations: {
    status: {
      sources: {
        buckets: [
          {
            key: 'snyk',
            ...doc('2026-11-09T12:00:00.000+0000', {
              check: 'source_status',
              status: 'problem',
              severity: 'warning',
              source: 'snyk',
              source_state: 'silent',
              summary: 'Snyk sin eventos en 26 h',
            }),
          },
          {
            key: 'cloudflare',
            ...doc('2026-11-09T08:00:00.000+0000', {
              check: 'source_status',
              status: 'ok',
              source: 'cloudflare',
              source_state: 'ok',
            }),
          },
        ],
      },
    },
    keys: {
      buckets: [
        {
          key: 'collector_failing:bitdefender',
          ...doc('2026-11-09T11:00:00.000+0000', {
            check: 'collector_failing',
            status: 'problem',
            severity: 'critical',
            source: 'bitdefender',
            key: 'collector_failing:bitdefender',
            summary: 'El collector falla',
          }),
        },
        {
          key: 'source_silent:aws',
          ...doc('2026-11-09T11:30:00.000+0000', {
            check: 'source_silent',
            status: 'ok',
            source: 'aws',
            key: 'source_silent:aws',
          }),
        },
      ],
    },
  },
};

describe('salud de la plataforma (monitor QAPAQ)', () => {
  it('consulta solo los eventos del monitor', () => {
    const query = JSON.stringify(platformHealthQuery());
    expect(query).toContain('"rule.groups":"qapaq_platform_health"');
    expect(query).toContain('"data.qapaq.vendor":"qapaq-platform"');
  });

  it('último source_status por fuente y problemas sin recuperación', () => {
    const health = parsePlatformHealth(body);
    expect(health.sources.snyk.state).toBe('silent');
    expect(health.sources.cloudflare.state).toBe('ok');
    expect(health.problems.map((p) => p.key)).toEqual(['collector_failing:bitdefender']);
  });

  it('más de 2 h sin estado es desconocido', () => {
    const health = parsePlatformHealth(body);
    const now = Date.parse('2026-11-09T12:30:00Z');
    expect(currentSourceState(health, 'snyk', now)?.state).toBe('silent');
    expect(currentSourceState(health, 'cloudflare', now)?.state).toBe('unknown');
    expect(serviceSourceState(health, 'snyk', now)?.state).toBe('silent');
    expect(serviceSourceState(health, 'respond', now)).toBeNull();
  });

  it('SharePoint usa la marca de Microsoft hasta tener la suya', () => {
    expect(vendorOfProvider('sharepoint')).toBe('office365');
    expect(vendorOfProvider('desconocido')).toBe('wazuh');
  });
});
