/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import {
  alertsAggregationQuery,
  buildOverview,
  isoInstant,
  openSnykIssues,
  parseAgents,
  parseAlertsAggregation,
  parseTopEvents,
  SearchClient,
} from './overview';
import { IntegrationsConfig } from '../common/integrations';

const AUTO = { state: 'auto' as const, missingPermissions: [], note: '' };
const INTEGRATIONS: IntegrationsConfig = {
  wazuh: AUTO,
  office365: { state: 'blocked', missingPermissions: ['ActivityFeed.Read'], note: '' },
  sharepoint: { state: 'disabled', missingPermissions: [], note: 'Permisos pendientes de validar.' },
  bitdefender: AUTO,
  snyk: AUTO,
  cloudflare: AUTO,
  aws: AUTO,
  respond: AUTO,
  qapaqzito: AUTO,
  alertMail: { state: 'blocked', missingPermissions: ['Mail.Send'], note: '' },
};

const levels = (low: number, medium: number, high: number, critical: number) => ({
  buckets: [
    { key: 'low', doc_count: low },
    { key: 'medium', doc_count: medium },
    { key: 'high', doc_count: high },
    { key: 'critical', doc_count: critical },
  ],
});

const snykIssue = (id: string, severity: string, status: string, ignored = 'false') => ({
  key: id,
  latest: {
    hits: {
      hits: [{ _source: { data: { snyk: { issue: { severity, status, ignored } } } } }],
    },
  },
});

const AGGREGATION = {
  aggregations: {
    last24h: {
      doc_count: 30,
      levels: levels(20, 6, 3, 1),
      agents: { value: 2 },
      trend: { buckets: [{ key: Date.parse('2026-11-04T10:00:00Z'), levels: levels(1, 0, 0, 0) }] },
      providers: {
        buckets: {
          snyk: { doc_count: 5, levels: levels(1, 2, 2, 0), waf_blocks: { doc_count: 0 } },
          cloudflare: {
            doc_count: 9,
            levels: levels(9, 0, 0, 0),
            waf_blocks: { doc_count: 4 },
            audit: { doc_count: 5 },
          },
        },
      },
    },
    last7d: { trend: { buckets: [] } },
    providers: {
      buckets: {
        snyk: {
          last: { value: Date.parse('2026-11-04T14:40:00Z') },
          projects: { value: 3 },
          snyk_issues: {
            buckets: [
              snykIssue('a', 'high', 'open'),
              snykIssue('b', 'high', 'resolved'),
              snykIssue('c', 'critical', 'open', 'true'),
              snykIssue('d', 'low', 'open'),
            ],
          },
        },
        bitdefender: {
          last: { value: null },
          endpoints: { value: 2 },
          infected: { endpoints: { value: 1 } },
        },
        cloudflare: { last: { value: Date.parse('2026-11-04T15:00:00Z') }, zones: { value: 1 } },
      },
    },
  },
};

describe('overview: consultas', () => {
  it('agrega por grupo de regla de cada proveedor sin traer documentos', () => {
    const query = alertsAggregationQuery() as {
      size: number;
      aggs: { providers: { filters: { filters: Record<string, unknown> } } };
    };
    expect(query.size).toBe(0);
    expect(Object.keys(query.aggs.providers.filters.filters)).toEqual([
      'office365',
      'sharepoint',
      'bitdefender',
      'snyk',
      'cloudflare',
      'aws',
    ]);
  });
});

describe('overview: lectura', () => {
  it('cuenta issues de Snyk abiertos por su último estado (ni resueltos ni ignorados)', () => {
    const counts = openSnykIssues(
      (AGGREGATION.aggregations.providers.buckets.snyk as { snyk_issues: unknown }).snyk_issues,
    );
    expect(counts).toEqual({ critical: 0, high: 1, medium: 0, low: 1 });
  });

  it('arma cifras del SIEM y de cada proveedor; uno sin datos queda en cero', () => {
    const { siem, providers } = parseAlertsAggregation(AGGREGATION);
    expect(siem.total24h).toBe(30);
    expect(siem.levels24h).toEqual({ low: 20, medium: 6, high: 3, critical: 1 });
    expect(siem.trend24h[0]).toEqual({
      at: '2026-11-04T10:00:00.000Z',
      levels: { low: 1, medium: 0, high: 0, critical: 0 },
    });
    expect(providers.snyk.metrics.open_high).toBe(1);
    expect(providers.snyk.lastEventAt).toBe('2026-11-04T14:40:00.000Z');
    expect(providers.cloudflare.metrics).toMatchObject({ waf_blocks: 4, audit: 5, zones: 1 });
    expect(providers.bitdefender).toMatchObject({
      events24h: 0,
      lastEventAt: null,
      metrics: { endpoints: 2, infected: 1 },
    });
    expect(providers.aws.events24h).toBe(0);
  });

  it('eventos relevantes: instante ISO en UTC y proveedor por grupo', () => {
    const [event] = parseTopEvents({
      hits: {
        hits: [
          {
            _id: 'x1',
            _source: {
              timestamp: '2026-11-04T14:40:00.885+0000',
              rule: { id: '101455', level: 10, description: 'QAPAQ Snyk: ALTA', groups: ['snyk'] },
              agent: { name: 'wazuh.manager' },
            },
          },
        ],
      },
    });
    expect(event).toEqual({
      id: 'x1',
      at: '2026-11-04T14:40:00.885Z',
      level: 10,
      ruleId: '101455',
      description: 'QAPAQ Snyk: ALTA',
      agent: 'wazuh.manager',
      provider: 'snyk',
    });
    expect(isoInstant('nada')).toBe('');
  });

  it('agentes: último estado por agente, sin contar el manager, y conteo por grupo', () => {
    const latest = (id: string, status: string, group: string[]) => ({
      key: id,
      latest: {
        hits: { hits: [{ _source: { status, group, timestamp: '2026-11-04T15:15:00Z' } }] },
      },
    });
    const agents = parseAgents({
      aggregations: {
        agents: {
          buckets: [
            latest('000', 'active', []),
            latest('001', 'active', ['linux-servers', 'linux-pilot']),
            latest('002', 'disconnected', ['linux-servers']),
          ],
        },
      },
    });
    expect(agents).toMatchObject({ total: 2, active: 1, disconnected: 1 });
    expect(agents.groups).toEqual({ 'linux-servers': 2, 'linux-pilot': 1 });
  });
});

describe('overview: permisos', () => {
  it('un índice sin permiso queda como forbidden y el resto se responde igual', async () => {
    const client: SearchClient = {
      search: async ({ index }) => {
        if (index === 'wazuh-monitoring-*') {
          throw Object.assign(new Error('no'), { statusCode: 403 });
        }
        return { body: index === 'wazuh-alerts-*' ? AGGREGATION : {} };
      },
    };
    const overview = await buildOverview(client, INTEGRATIONS, new Date('2026-11-04T16:00:00Z'));
    expect(overview.alertsAccess).toBe('ok');
    expect(overview.monitoringAccess).toBe('forbidden');
    expect(overview.agents).toBeNull();
    expect(overview.integrations.office365.missingPermissions).toEqual(['ActivityFeed.Read']);
  });
});
