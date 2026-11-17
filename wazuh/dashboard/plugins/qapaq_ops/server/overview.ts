/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentsSummary,
  emptyLevels,
  IntegrationsConfig,
  LEVEL_BAND_RANGES,
  LEVEL_BANDS,
  LevelBand,
  LevelCounts,
  OverviewResponse,
  ServiceAttention,
  ServiceId,
  PROVIDER_IDS,
  ProviderId,
  ProviderStats,
  Readability,
  TopEvent,
  TrendBucket,
} from '../common/integrations';
import { parsePlatformHealth, platformHealthQuery } from '../common/platform_health';

/**
 * `GET /api/qapaq_ops/overview`: cifras del «Resumen del SOC» calculadas en el Indexer.
 *
 * Todas las consultas van con `asCurrentUser`: el Security plugin aplica los permisos de quien
 * mira (proxy auth QAPAQ). Nunca se usa la identidad interna del dashboard ni credenciales de
 * administrador. Un rol sin lectura de un índice ve ese bloque como `forbidden`, no un error.
 *
 * Las consultas son de agregación (`size: 0`) salvo la lista de eventos relevantes (8
 * documentos, campos acotados): el navegador nunca recibe documentos crudos completos.
 */

export const ALERTS_INDEX = 'wazuh-alerts-*';
export const MONITORING_INDEX = 'wazuh-monitoring-*';

/** Bloqueos y desafíos del WAF de Cloudflare (data.cloudflare.firewall.action). */
const WAF_BLOCK_ACTIONS = [
  'block',
  'challenge',
  'jschallenge',
  'js_challenge',
  'managed_challenge',
  'drop',
];

const PROVIDER_GROUP: Readonly<Record<ProviderId, string>> = {
  office365: 'office365',
  sharepoint: 'qapaq_sharepoint',
  bitdefender: 'bitdefender',
  snyk: 'snyk',
  cloudflare: 'cloudflare',
  aws: 'aws',
};

type Json = Record<string, unknown>;

function levelRanges(): Json {
  return {
    range: {
      field: 'rule.level',
      ranges: LEVEL_BANDS.map((band) => ({ key: band, ...LEVEL_BAND_RANGES[band] })),
    },
  };
}

function groupFilter(group: string): Json {
  return { term: { 'rule.groups': group } };
}

/** Una sola búsqueda con todas las agregaciones de alertas (ventana de 30 días). */
export function alertsAggregationQuery(): Json {
  const providerFilters: Json = {};
  for (const id of PROVIDER_IDS) providerFilters[id] = groupFilter(PROVIDER_GROUP[id]);
  return {
    size: 0,
    track_total_hits: false,
    query: { range: { timestamp: { gte: 'now-30d' } } },
    aggs: {
      last24h: {
        filter: { range: { timestamp: { gte: 'now-24h' } } },
        aggs: {
          levels: levelRanges(),
          agents: { cardinality: { field: 'agent.id' } },
          trend: {
            date_histogram: {
              field: 'timestamp',
              fixed_interval: '1h',
              min_doc_count: 0,
              extended_bounds: { min: 'now-24h/h', max: 'now/h' },
            },
            aggs: { levels: levelRanges() },
          },
          providers: {
            filters: { filters: providerFilters },
            aggs: {
              levels: levelRanges(),
              waf_blocks: {
                filter: {
                  bool: {
                    filter: [
                      groupFilter('qapaq_waf'),
                      { terms: { 'data.cloudflare.firewall.action': WAF_BLOCK_ACTIONS } },
                    ],
                  },
                },
              },
              audit: { filter: groupFilter('qapaq_audit') },
            },
          },
        },
      },
      last7d: {
        filter: { range: { timestamp: { gte: 'now-7d/d' } } },
        aggs: {
          trend: {
            date_histogram: {
              field: 'timestamp',
              calendar_interval: '1d',
              min_doc_count: 0,
              extended_bounds: { min: 'now-6d/d', max: 'now/d' },
            },
            aggs: { levels: levelRanges() },
          },
        },
      },
      providers: {
        filters: { filters: providerFilters },
        aggs: {
          last: { max: { field: 'timestamp' } },
          endpoints: { cardinality: { field: 'data.bitdefender.endpoint.id' } },
          infected: {
            filter: { term: { 'data.bitdefender.endpoint.infected': 'true' } },
            aggs: { endpoints: { cardinality: { field: 'data.bitdefender.endpoint.id' } } },
          },
          zones: { cardinality: { field: 'data.cloudflare.zone_name' } },
          projects: { cardinality: { field: 'data.snyk.project.id' } },
          // Estado vigente de cada issue de Snyk: el último evento por issue.
          snyk_issues: {
            terms: { field: 'data.snyk.issue.id', size: 5000 },
            aggs: {
              latest: {
                top_hits: {
                  size: 1,
                  sort: [{ timestamp: { order: 'desc' } }],
                  _source: [
                    'data.snyk.issue.severity',
                    'data.snyk.issue.status',
                    'data.snyk.issue.ignored',
                  ],
                },
              },
            },
          },
        },
      },
    },
  };
}

/** Eventos relevantes (nivel ≥ 8, 7 días), con los campos mínimos para listarlos. */
export function topEventsQuery(): Json {
  return {
    size: 8,
    track_total_hits: false,
    query: {
      bool: {
        filter: [
          { range: { timestamp: { gte: 'now-7d' } } },
          { range: { 'rule.level': { gte: 8 } } },
        ],
      },
    },
    sort: [{ timestamp: { order: 'desc' } }],
    _source: [
      'timestamp',
      'rule.id',
      'rule.level',
      'rule.description',
      'rule.groups',
      'agent.name',
    ],
  };
}

/** Bounded, per-service previews share one request and the caller's Indexer identity. */
export function serviceAttentionQuery(): Json {
  const filters: Json = { wazuh: { match_all: {} } };
  for (const id of PROVIDER_IDS) filters[id] = groupFilter(PROVIDER_GROUP[id]);
  return {
    size: 0,
    query: {
      bool: {
        filter: [
          { range: { timestamp: { gte: 'now-24h', lte: 'now' } } },
          { range: { 'rule.level': { gte: 8 } } },
        ],
      },
    },
    aggs: {
      services: {
        filters: { filters },
        aggs: {
          events: {
            top_hits: {
              size: 100,
              sort: [{ 'rule.level': { order: 'desc' } }, { timestamp: { order: 'desc' } }],
              _source: [
                'timestamp',
                'rule.id',
                'rule.level',
                'rule.description',
                'rule.groups',
                'agent.name',
              ],
            },
          },
        },
      },
    },
  };
}

export function parseServiceAttention(body: unknown): Partial<Record<ServiceId, ServiceAttention>> {
  const root = obj(body);
  const buckets = obj(obj(obj(root.aggregations).services).buckets);
  const partial =
    root.timed_out === true || root.terminated_early === true || num(obj(root._shards).failed) > 0;
  const result: Partial<Record<ServiceId, ServiceAttention>> = {};
  for (const id of ['wazuh', ...PROVIDER_IDS] as ServiceId[]) {
    const bucket = obj(buckets[id]);
    const valid =
      !partial &&
      typeof bucket.doc_count === 'number' &&
      Array.isArray(obj(obj(bucket.events).hits).hits);
    result[id] = valid
      ? { access: 'ok', total: num(bucket.doc_count), events: parseTopEvents(bucket.events) }
      : { access: 'error', total: null, events: [] };
  }
  return result;
}

/** Estado vigente de cada agente según el último muestreo de `wazuh-monitoring-*`. */
export function agentsQuery(): Json {
  return {
    size: 0,
    track_total_hits: false,
    query: { range: { timestamp: { gte: 'now-2h' } } },
    aggs: {
      agents: {
        terms: { field: 'id', size: 2000 },
        aggs: {
          latest: {
            top_hits: {
              size: 1,
              sort: [{ timestamp: { order: 'desc' } }],
              _source: ['status', 'group', 'timestamp', 'name'],
            },
          },
        },
      },
    },
  };
}

/* ------------------------------------------------------------------- Lectura */

function obj(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readLevels(aggregation: unknown): LevelCounts {
  const levels = emptyLevels();
  for (const bucket of list(obj(aggregation).buckets)) {
    const key = obj(bucket).key as LevelBand;
    if (key in levels) levels[key] = num(obj(bucket).doc_count);
  }
  return levels;
}

function readTrend(aggregation: unknown): TrendBucket[] {
  return list(obj(aggregation).buckets).map((bucket) => {
    const item = obj(bucket);
    return {
      at: new Date(num(item.key)).toISOString(),
      levels: readLevels(item.levels),
    };
  });
}

function sourceOf(hit: unknown): Json {
  return obj(obj(hit)._source);
}

function path(source: Json, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((value, key) => obj(value)[key], source);
}

/** Issues de Snyk abiertos (ni resueltos ni ignorados) por severidad. */
export function openSnykIssues(aggregation: unknown): Record<string, number> {
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const bucket of list(obj(aggregation).buckets)) {
    const latest = sourceOf(list(obj(obj(obj(bucket).latest).hits).hits)[0]);
    const status = String(path(latest, 'data.snyk.issue.status') ?? '');
    const ignored = String(path(latest, 'data.snyk.issue.ignored') ?? 'false');
    const severity = String(path(latest, 'data.snyk.issue.severity') ?? '');
    if (status === 'open' && ignored !== 'true' && severity in counts) counts[severity] += 1;
  }
  return counts;
}

export function parseAlertsAggregation(body: unknown): {
  siem: NonNullable<OverviewResponse['siem']>;
  providers: Record<ProviderId, ProviderStats>;
} {
  const aggregations = obj(obj(body).aggregations);
  const last24h = obj(aggregations.last24h);
  const levels24h = readLevels(last24h.levels);
  const providers24h = obj(obj(last24h.providers).buckets);
  const providersAll = obj(obj(aggregations.providers).buckets);
  const providers = {} as Record<ProviderId, ProviderStats>;
  for (const id of PROVIDER_IDS) {
    const recent = obj(providers24h[id]);
    const all = obj(providersAll[id]);
    const lastValue = obj(all.last).value;
    const metrics: Record<string, number> = {};
    if (id === 'bitdefender') {
      metrics.endpoints = num(obj(all.endpoints).value);
      metrics.infected = num(obj(obj(all.infected).endpoints).value);
    }
    if (id === 'snyk') {
      const open = openSnykIssues(all.snyk_issues);
      for (const [severity, count] of Object.entries(open)) metrics[`open_${severity}`] = count;
      metrics.projects = num(obj(all.projects).value);
    }
    if (id === 'cloudflare') {
      metrics.waf_blocks = num(obj(recent.waf_blocks).doc_count);
      metrics.audit = num(obj(recent.audit).doc_count);
      metrics.zones = num(obj(all.zones).value);
    }
    providers[id] = {
      events24h: num(recent.doc_count),
      lastEventAt:
        typeof lastValue === 'number' && Number.isFinite(lastValue)
          ? new Date(lastValue).toISOString()
          : null,
      levels24h: readLevels(recent.levels),
      metrics,
    };
  }
  return {
    siem: {
      levels24h,
      total24h: num(last24h.doc_count),
      agentsWithAlerts24h: num(obj(last24h.agents).value),
      trend24h: readTrend(last24h.trend),
      trend7d: readTrend(obj(obj(aggregations.last7d).trend)),
    },
    providers,
  };
}

/** Wazuh indexa `±HHMM` sin dos puntos; el navegador recibe siempre ISO 8601 en UTC. */
export function isoInstant(value: unknown): string {
  if (typeof value !== 'string') return '';
  const parsed = Date.parse(value.replace(/([+-])(\d{2})(\d{2})$/u, '$1$2:$3'));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function providerOf(groups: unknown): ProviderId | null {
  const values = list(groups).map(String);
  return PROVIDER_IDS.find((id) => values.includes(PROVIDER_GROUP[id])) ?? null;
}

export function parseTopEvents(body: unknown): TopEvent[] {
  return list(obj(obj(body).hits).hits).map((hit) => {
    const source = sourceOf(hit);
    const rule = obj(source.rule);
    return {
      id: String(obj(hit)._id ?? ''),
      at: isoInstant(source.timestamp),
      level: num(rule.level),
      ruleId: String(rule.id ?? ''),
      description: String(rule.description ?? '').slice(0, 300),
      agent: typeof obj(source.agent).name === 'string' ? String(obj(source.agent).name) : null,
      provider: providerOf(rule.groups),
    };
  });
}

export function parseAgents(body: unknown): AgentsSummary {
  let active = 0;
  let disconnected = 0;
  let other = 0;
  let measuredAt: string | null = null;
  const groups: Record<string, number> = {};
  const buckets = list(obj(obj(obj(body).aggregations).agents).buckets);
  for (const bucket of buckets) {
    const latest = sourceOf(list(obj(obj(obj(bucket).latest).hits).hits)[0]);
    // El manager (000) no es un agente enrolado.
    if (String(obj(bucket).key) === '000') continue;
    const status = String(latest.status ?? '');
    if (status === 'active') active += 1;
    else if (status === 'disconnected') disconnected += 1;
    else other += 1;
    for (const group of list(latest.group).map(String)) groups[group] = (groups[group] ?? 0) + 1;
    const at = typeof latest.timestamp === 'string' ? latest.timestamp : null;
    if (at && (!measuredAt || at > measuredAt)) measuredAt = at;
  }
  return { total: active + disconnected + other, active, disconnected, other, groups, measuredAt };
}

/* ----------------------------------------------------------------- Ejecución */

export interface SearchClient {
  search(params: { index?: string; body: Json }): Promise<{ body: unknown }>;
}

export function readabilityOf(error: unknown): Readability {
  const status = num(obj(error).statusCode) || num(obj(obj(error).meta).statusCode);
  return status === 401 || status === 403 ? 'forbidden' : 'error';
}

type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };

/** `Promise.allSettled` sin depender de la lib ES2020 del typecheck de OSD. */
function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
}

export async function buildOverview(
  client: SearchClient,
  integrations: IntegrationsConfig,
  now: Date = new Date(),
): Promise<OverviewResponse> {
  const [alerts, top, agents, platform, attention] = await Promise.all([
    settle(client.search({ index: ALERTS_INDEX, body: alertsAggregationQuery() })),
    settle(client.search({ index: ALERTS_INDEX, body: topEventsQuery() })),
    settle(client.search({ index: MONITORING_INDEX, body: agentsQuery() })),
    settle(client.search({ index: ALERTS_INDEX, body: platformHealthQuery() })),
    settle(client.search({ index: ALERTS_INDEX, body: serviceAttentionQuery() })),
  ]);
  const parsed = alerts.status === 'fulfilled' ? parseAlertsAggregation(alerts.value.body) : null;
  return {
    attention:
      attention.status === 'fulfilled'
        ? parseServiceAttention(attention.value.body)
        : Object.fromEntries(
            ['wazuh', ...PROVIDER_IDS].map((id) => [
              id,
              { access: readabilityOf(attention.reason), total: null, events: [] },
            ]),
          ),
    generatedAt: now.toISOString(),
    alertsAccess: alerts.status === 'fulfilled' ? 'ok' : readabilityOf(alerts.reason),
    monitoringAccess: agents.status === 'fulfilled' ? 'ok' : readabilityOf(agents.reason),
    siem: parsed?.siem ?? null,
    providers: parsed?.providers ?? null,
    topEvents: top.status === 'fulfilled' ? parseTopEvents(top.value.body) : [],
    agents: agents.status === 'fulfilled' ? parseAgents(agents.value.body) : null,
    integrations,
    platformHealth:
      platform.status === 'fulfilled'
        ? parsePlatformHealth(platform.value.body)
        : {
            access: readabilityOf(platform.reason) === 'forbidden' ? 'forbidden' : 'error',
            sources: {},
            problems: [],
          },
  };
}
