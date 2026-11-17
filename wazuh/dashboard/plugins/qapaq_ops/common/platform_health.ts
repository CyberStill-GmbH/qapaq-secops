/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

/**
 * Salud de la plataforma (monitor QAPAQ, docs/20-monitoreo-de-plataforma-y-priorizacion.md).
 *
 * Contrato del agente de monitoreo: eventos en `wazuh-alerts-*` con
 * `rule.groups: qapaq_platform_health` y `data.qapaq.vendor: "qapaq-platform"`; los campos viven en
 * `data.qapaq.health` (check, status, severity, source, source_state, key, summary, last_seen,
 * since, value, threshold, unit, component). El estado vigente de una fuente es el último
 * `check: source_status` de esa fuente; lo que tiene más de 2 h se trata como desconocido.
 */

export const PLATFORM_HEALTH_GROUP = 'qapaq_platform_health';
export const PLATFORM_HEALTH_VENDOR = 'qapaq-platform';
export const PLATFORM_HEALTH_STALE_MS = 2 * 3600000;
export const PLATFORM_HEALTH_DOC =
  'https://github.com/CyberStill-GmbH/qapaq-secops/blob/qapaq/rebrand-serverless/docs/20-monitoreo-de-plataforma-y-priorizacion.md';

export type PlatformSourceState = 'ok' | 'silent' | 'failing' | 'disabled' | 'unknown';
export type PlatformSeverity = 'info' | 'warning' | 'critical';

export interface PlatformSourceHealth {
  readonly source: string;
  readonly state: PlatformSourceState;
  /** Instante del último `source_status` (ISO). */
  readonly at: string;
  readonly severity: PlatformSeverity;
  readonly summary: string;
  readonly lastSeen: string | null;
  readonly since: string | null;
}

export interface PlatformProblem {
  readonly key: string;
  readonly check: string;
  readonly source: string;
  readonly severity: PlatformSeverity;
  readonly summary: string;
  readonly at: string;
  readonly since: string | null;
  readonly component: string | null;
  readonly value: string | null;
  readonly threshold: string | null;
  readonly unit: string | null;
}

export interface PlatformHealth {
  readonly access: 'ok' | 'forbidden' | 'error';
  readonly sources: Readonly<Record<string, PlatformSourceHealth>>;
  /** Problemas abiertos: el último evento de cada `key` sigue en `status: problem`. */
  readonly problems: readonly PlatformProblem[];
}

/** Fuente del monitor que corresponde a cada servicio del catálogo (si tiene). */
export const SERVICE_HEALTH_SOURCE: Readonly<Record<string, readonly string[]>> = {
  wazuh: ['wazuh', 'wazuh-agents'],
  office365: ['office365'],
  bitdefender: ['bitdefender'],
  snyk: ['snyk'],
  cloudflare: ['cloudflare'],
  aws: ['aws'],
};

export const PLATFORM_SOURCE_LABEL: Readonly<Record<string, string>> = {
  snyk: 'Snyk',
  cloudflare: 'Cloudflare',
  bitdefender: 'Bitdefender',
  aws: 'AWS',
  office365: 'Microsoft 365',
  'wazuh-agents': 'Agentes Wazuh',
  wazuh: 'Wazuh',
  qapaq: 'API QAPAQ',
  host: 'Servidor',
  edge: 'Edge (nginx)',
  vulnprio: 'Priorización de vulnerabilidades',
  canary: 'Canarios sintéticos',
};

export const PLATFORM_STATE_LABEL: Readonly<Record<PlatformSourceState, string>> = {
  ok: 'Operativa',
  silent: 'En silencio',
  failing: 'Con fallos',
  disabled: 'Desactivada',
  unknown: 'Sin dato reciente',
};

const STATES: readonly PlatformSourceState[] = ['ok', 'silent', 'failing', 'disabled'];
const SEVERITIES: readonly PlatformSeverity[] = ['info', 'warning', 'critical'];

/** Estado vigente de una fuente: > 2 h sin `source_status` es «unknown». */
export function currentSourceState(
  health: PlatformHealth | null | undefined,
  source: string,
  now: number = Date.now(),
): PlatformSourceHealth | null {
  const item = health?.sources[source];
  if (!item) return null;
  const at = Date.parse(item.at);
  if (!Number.isFinite(at) || now - at > PLATFORM_HEALTH_STALE_MS) {
    return { ...item, state: 'unknown' };
  }
  return item;
}

/** Peor estado entre las fuentes de un servicio (failing > silent > disabled > ok > unknown). */
export function serviceSourceState(
  health: PlatformHealth | null | undefined,
  serviceId: string,
  now: number = Date.now(),
): PlatformSourceHealth | null {
  const rank: Record<PlatformSourceState, number> = {
    failing: 4,
    silent: 3,
    disabled: 2,
    ok: 1,
    unknown: 0,
  };
  let worst: PlatformSourceHealth | null = null;
  for (const source of SERVICE_HEALTH_SOURCE[serviceId] ?? []) {
    const item = currentSourceState(health, source, now);
    if (item && (!worst || rank[item.state] > rank[worst.state])) worst = item;
  }
  return worst;
}

/* --------------------------------------------------- lectura del Indexer (servidor) */

type Json = Record<string, unknown>;
const obj = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | null =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : null;

function latestSource(bucket: unknown): Json {
  return obj(obj(list(obj(obj(obj(bucket).latest).hits).hits)[0])._source);
}

function isoOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  const parsed = Date.parse(value.replace(/([+-])(\d{2})(\d{2})$/u, '$1$2:$3'));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function healthOf(source: Json): Json {
  return obj(obj(obj(source.data).qapaq).health);
}

function severityOf(value: unknown): PlatformSeverity {
  return (SEVERITIES as readonly unknown[]).includes(value) ? (value as PlatformSeverity) : 'info';
}

/** Una búsqueda: último `source_status` por fuente y último evento por `key` (24 h). */
export function platformHealthQuery(): Json {
  const latest = {
    top_hits: {
      size: 1,
      sort: [{ timestamp: { order: 'desc' } }],
      _source: ['data.qapaq.health', 'timestamp'],
    },
  };
  return {
    size: 0,
    track_total_hits: false,
    query: {
      bool: {
        filter: [
          { term: { 'rule.groups': PLATFORM_HEALTH_GROUP } },
          { term: { 'data.qapaq.vendor': PLATFORM_HEALTH_VENDOR } },
          { range: { timestamp: { gte: 'now-24h' } } },
        ],
      },
    },
    aggs: {
      status: {
        filter: { term: { 'data.qapaq.health.check': 'source_status' } },
        aggs: {
          sources: { terms: { field: 'data.qapaq.health.source', size: 50 }, aggs: { latest } },
        },
      },
      keys: { terms: { field: 'data.qapaq.health.key', size: 300 }, aggs: { latest } },
    },
  };
}

export function parsePlatformHealth(body: unknown): PlatformHealth {
  const aggregations = obj(obj(body).aggregations);
  const sources: Record<string, PlatformSourceHealth> = {};
  for (const bucket of list(obj(obj(aggregations.status).sources).buckets)) {
    const doc = latestSource(bucket);
    const health = healthOf(doc);
    const source = text(health.source) ?? text(obj(bucket).key);
    if (!source) continue;
    const state = health.source_state;
    sources[source] = {
      source,
      state: (STATES as readonly unknown[]).includes(state)
        ? (state as PlatformSourceState)
        : health.status === 'ok'
          ? 'ok'
          : 'unknown',
      at: isoOf(doc.timestamp),
      severity: severityOf(health.severity),
      summary: (text(health.summary) ?? '').slice(0, 300),
      lastSeen: text(health.last_seen),
      since: text(health.since),
    };
  }
  const problems: PlatformProblem[] = [];
  for (const bucket of list(obj(aggregations.keys).buckets)) {
    const doc = latestSource(bucket);
    const health = healthOf(doc);
    if (health.status !== 'problem') continue;
    problems.push({
      key: text(health.key) ?? String(obj(bucket).key ?? ''),
      check: text(health.check) ?? '',
      source: text(health.source) ?? '',
      severity: severityOf(health.severity),
      summary: (text(health.summary) ?? '').slice(0, 300),
      at: isoOf(doc.timestamp),
      since: text(health.since),
      component: text(health.component),
      value: text(health.value),
      threshold: text(health.threshold),
      unit: text(health.unit),
    });
  }
  const order: Record<PlatformSeverity, number> = { critical: 0, warning: 1, info: 2 };
  problems.sort((a, b) => order[a.severity] - order[b.severity] || (a.at < b.at ? 1 : -1));
  return { access: 'ok', sources, problems: problems.slice(0, 50) };
}
