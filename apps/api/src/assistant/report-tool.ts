/**
 * Herramienta `generate_report` de Qapaqzito: arma un informe (PDF, Excel o CSV) y lo guarda como
 * artefacto descargable de la persona.
 *
 * Quién hace qué:
 * - **La API obtiene todos los datos** (alertas, KPIs, gráficos, tablas, eventos relacionados,
 *   cronologías) con `GET` internos hechos con la sesión de la persona (`InternalGet`): hereda
 *   autorización, proyección de campos y redacciones. El modelo no aporta cifras: solo el título
 *   y la narrativa (resumen, hallazgos, recomendaciones) en markdown, acotada y sin HTML.
 * - El informe lleva **valores reales** (es la descarga de la propia persona, con sus permisos).
 * - Al modelo vuelve un resultado corto (`artifactId`, nombre de archivo, filas, páginas); no
 *   incluye títulos, nombres de entidades ni contenido, y el bucle lo seudonimiza igualmente.
 * - Auditoría (en el controlador, vía `onStored`): quién, tipo, formato, tamaño y hash; nunca el
 *   contenido del archivo.
 */

import type { AssistantTool, Citation, ToolInput, ToolOutcome } from '@qapaq/assistant';
import {
  ArtifactError,
  artifactRefOf,
  type ArtifactFormat,
  type ArtifactOwner,
  type ArtifactRef,
  type ArtifactVault,
} from '@qapaq/assistant';
import { incidentLink, investigationLink } from '@qapaq/soar';

import { providerOf } from './investigation-tools.js';
import {
  ReportsError,
  type ReportCell,
  type ReportChartSection,
  type ReportColumn,
  type ReportKind,
  type ReportKpi,
  type ReportSection,
  type ReportSpec,
  type ReportsClient,
} from './reports-client.js';
import type { InternalGet, InternalResponse } from './soc-tools.js';

type Row = Record<string, unknown>;

const ID = /^[A-Za-z0-9_-]{1,64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LIMA_OFFSET_MS = 5 * HOUR;
const CLASSIFICATION = 'Confidencial · uso interno QAPAQ';
const TIME_ZONE = 'America/Lima';

export const REPORT_LIMITS = Object.freeze({
  /** Páginas de 200 alertas que se recorren como máximo (2000 alertas). */
  maxAlertPages: 10,
  maxEventPages: 3,
  maxPeriodMs: 92 * DAY,
  defaultPeriodMs: 7 * DAY,
  /** Filas por tabla en PDF (legible) y en Excel/CSV (datos). */
  maxRowsPdf: 500,
  maxRowsData: 5_000,
  maxRelatedAlerts: 10,
  maxTimelineItems: 80,
  title: 160,
  summary: 4_000,
  findings: 8_000,
  recommendations: 6_000,
  cell: 4_000,
});

export const REPORT_FORMATS = ['pdf', 'xlsx', 'csv'] as const;
export const REPORT_KINDS = ['alerts', 'investigation', 'incident'] as const;
const WINDOWS: Readonly<Record<string, number>> = { '1h': HOUR, '24h': DAY, '7d': 7 * DAY };
const LABELS: Readonly<Record<ArtifactFormat, string>> = {
  pdf: 'Generando informe PDF',
  xlsx: 'Generando informe Excel',
  csv: 'Generando informe CSV',
};
const KIND_FILE: Readonly<Record<string, string>> = {
  alerts: 'alertas',
  investigation: 'investigacion',
  incident: 'incidente',
};
const DEFAULT_TITLES: Readonly<Record<string, string>> = {
  alerts: 'Informe de alertas',
  investigation: 'Informe de investigación de alerta',
  incident: 'Informe de incidente',
};

class InputError extends Error {}
/** El servicio de lectura respondió 401/403/404: permiso insuficiente o recurso inexistente. */
class ForbiddenError extends Error {}
class DegradedError extends Error {}

function isRecord(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rowsOf(body: unknown): Row[] {
  const items = isRecord(body) ? body['items'] : undefined;
  return Array.isArray(items) ? (items as Row[]) : [];
}

function nextCursorOf(body: unknown): string | undefined {
  const next = isRecord(body) ? body['nextCursor'] : undefined;
  return typeof next === 'string' && next !== '' ? next : undefined;
}

function str(value: unknown, max: number = REPORT_LIMITS.cell): string {
  if (value === null || value === undefined) return '';
  const text =
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : String(value);
  const clean = [...text].filter((char) => {
    const code = char.charCodeAt(0);
    return code >= 0x20 || code === 0x0a || code === 0x09;
  });
  const joined = clean.join('');
  return joined.length > max ? `${joined.slice(0, max - 1)}…` : joined;
}

/** Markdown del modelo: sin etiquetas HTML ni caracteres de control, con tope de longitud. */
export function clampNarrative(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = str(value, max * 2)
    .replace(/<[^>\n]*>/gu, '')
    .replace(/</gu, '‹')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function guardStatus(response: InternalResponse): void {
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new ForbiddenError();
  }
  if (response.status >= 500) throw new DegradedError();
  if (response.status >= 400) throw new InputError('La consulta no es válida.');
}

function limaDay(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'desconocido';
  return new Date(at.getTime() - LIMA_OFFSET_MS).toISOString().slice(0, 10);
}

function isoOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function countBy<T>(items: readonly T[], key: (item: T) => unknown): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = str(key(item), 120) || 'desconocido';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function topEntries(counts: Map<string, number>, limit: number): [string, number][] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function entitiesOf(alert: Row): Row[] {
  return Array.isArray(alert['entities']) ? (alert['entities'] as Row[]) : [];
}

const COLUMNS = {
  at: { key: 'occurredAt', label: 'Ocurrió', kind: 'datetime' },
  priority: { key: 'priority', label: 'Prioridad', kind: 'priority' },
  title: { key: 'title', label: 'Alerta', kind: 'text' },
  score: { key: 'score', label: 'Puntuación', kind: 'number' },
  status: { key: 'status', label: 'Estado', kind: 'text' },
  provider: { key: 'provider', label: 'Fuente', kind: 'text' },
  link: { key: 'link', label: 'Abrir', kind: 'link' },
} as const satisfies Record<string, ReportColumn>;

const ALERT_COLUMNS: readonly ReportColumn[] = [
  COLUMNS.at,
  COLUMNS.priority,
  COLUMNS.title,
  COLUMNS.score,
  COLUMNS.status,
  COLUMNS.provider,
  COLUMNS.link,
];

function alertRow(alert: Row, consoleBaseUrl: string): Record<string, ReportCell> {
  const id = str(alert['id'], 64);
  return {
    occurredAt: isoOf(alert['occurredAt']),
    priority: str(alert['priority'], 4),
    title: str(alert['title']),
    score: typeof alert['score'] === 'number' ? alert['score'] : null,
    status: str(alert['status'], 40),
    provider: providerOf(alert['title']),
    link: id && ID.test(id) ? investigationLink(consoleBaseUrl, id) : null,
  };
}

interface ToolContext {
  readonly get: InternalGet;
  readonly capabilities: ReadonlySet<string>;
  readonly consoleBaseUrl: string;
  readonly now: Date;
  readonly rowCap: number;
}

interface Gathered {
  readonly kpis: ReportKpi[];
  readonly sections: ReportSection[];
  readonly sources: string[];
  readonly period?: { readonly from: string; readonly to: string };
  readonly subtitle?: string;
  readonly rows: number;
  readonly citations: Citation[];
}

function stamp(now: Date): string {
  return `${limaDay(now.toISOString())} ${new Date(now.getTime() - LIMA_OFFSET_MS).toISOString().slice(11, 16)}`;
}

// ── kind = alerts ──────────────────────────────────────────────────────────────────────────

interface AlertScope {
  readonly from: Date;
  readonly to: Date;
  readonly priorities: readonly string[];
  readonly open: boolean;
  readonly source: string | undefined;
}

function parseAlertScope(scope: Row, now: Date): AlertScope {
  const to = scope['to'] === undefined || scope['to'] === '' ? now : new Date(String(scope['to']));
  if (scope['to'] !== undefined && scope['to'] !== '' && !ISO.test(String(scope['to']))) {
    throw new InputError('«scope.to» debe ser ISO 8601 en UTC (…Z).');
  }
  const from =
    scope['from'] === undefined || scope['from'] === ''
      ? new Date(to.getTime() - REPORT_LIMITS.defaultPeriodMs)
      : new Date(String(scope['from']));
  if (scope['from'] !== undefined && scope['from'] !== '' && !ISO.test(String(scope['from']))) {
    throw new InputError('«scope.from» debe ser ISO 8601 en UTC (…Z).');
  }
  if (
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime()) ||
    from > to ||
    to.getTime() - from.getTime() > REPORT_LIMITS.maxPeriodMs
  ) {
    throw new InputError('El periodo no es válido (máximo 92 días, «from» antes de «to»).');
  }
  const rawPriorities = scope['priorities'];
  const priorities =
    rawPriorities === undefined || rawPriorities === null
      ? []
      : Array.isArray(rawPriorities)
        ? rawPriorities.map(String)
        : [String(rawPriorities)];
  if (!priorities.every((priority) => ['P1', 'P2', 'P3', 'P4'].includes(priority))) {
    throw new InputError('«scope.priorities» solo admite P1, P2, P3 y P4.');
  }
  const status = scope['status'];
  if (
    status !== undefined &&
    status !== null &&
    status !== '' &&
    status !== 'open' &&
    status !== 'all'
  ) {
    throw new InputError('«scope.status» debe ser open o all.');
  }
  const source = scope['source'];
  if (source !== undefined && source !== null && source !== '' && typeof source !== 'string') {
    throw new InputError('«scope.source» no es válido.');
  }
  return {
    from,
    to,
    priorities: [...new Set(priorities)],
    open: status === 'open',
    source:
      typeof source === 'string' && source.trim() !== '' ? source.trim().toLowerCase() : undefined,
  };
}

async function gatherAlerts(context: ToolContext, scope: Row): Promise<Gathered> {
  if (!context.capabilities.has('alerts.read')) throw new ForbiddenError();
  const parsed = parseAlertScope(scope, context.now);
  const matched: Row[] = [];
  let complete = true;
  // Una pasada por prioridad pedida, filtrada en la API. Sin esto, pedir «P1 y P2» recorría la
  // lista completa (ordenada por hora) y miles de P3 recientes agotaban el tope antes de llegar a
  // las P1/P2 del periodo: el informe del 2026-11-13 mostró 2 alertas en vez de 133.
  const passes: readonly (string | undefined)[] =
    parsed.priorities.length > 0 ? parsed.priorities : [undefined];
  for (const priority of passes) {
    let cursor: string | undefined;
    let passComplete = false;
    for (let page = 0; page < REPORT_LIMITS.maxAlertPages; page += 1) {
      const params = new URLSearchParams({ pageSize: '200' });
      if (parsed.open) params.set('status', 'open');
      if (priority) params.set('priority', priority);
      if (cursor) params.set('cursor', cursor);
      const response = await context.get(`/api/alerts?${params.toString()}`);
      guardStatus(response);
      let older = false;
      for (const alert of rowsOf(response.body)) {
        const at = new Date(String(alert['occurredAt'] ?? ''));
        if (Number.isNaN(at.getTime())) continue;
        if (at > parsed.to) continue;
        if (at < parsed.from) {
          older = true;
          continue;
        }
        if (parsed.source && providerOf(alert['title']) !== parsed.source) continue;
        matched.push(alert);
      }
      cursor = nextCursorOf(response.body);
      if (older || !cursor) {
        passComplete = true;
        break;
      }
    }
    if (!passComplete) complete = false;
  }
  matched.sort((left, right) =>
    String(right['occurredAt'] ?? '').localeCompare(String(left['occurredAt'] ?? '')),
  );

  const byPriority = countBy(matched, (alert) => alert['priority']);
  const byStatus = countBy(matched, (alert) => alert['status']);
  const open = matched.filter((alert) => alert['status'] !== 'closed').length;
  const unassigned = matched.filter(
    (alert) => alert['status'] !== 'closed' && !alert['assigneeId'],
  ).length;
  const kpis: ReportKpi[] = [
    { label: 'Alertas', value: String(matched.length) },
    ...(parsed.priorities.length > 0
      ? parsed.priorities
      : (['P1', 'P2', 'P3', 'P4'] as const)
    ).map((priority) => ({
      label: `Alertas ${priority}`,
      value: String(byPriority.get(priority) ?? 0),
    })),
    { label: 'Abiertas', value: String(open) },
    { label: 'Sin responsable', value: String(unassigned), hint: 'abiertas sin asignar' },
  ];

  // Alertas por día (hora de Lima) y prioridad.
  const days = new Map<string, Map<string, number>>();
  for (const alert of matched) {
    const day = limaDay(String(alert['occurredAt']));
    const perPriority = days.get(day) ?? new Map<string, number>();
    const priority = str(alert['priority'], 4) || '—';
    perPriority.set(priority, (perPriority.get(priority) ?? 0) + 1);
    days.set(day, perPriority);
  }
  const orderedDays = [...days.keys()].sort();
  const perDay: ReportChartSection = {
    type: 'chart',
    heading: 'Alertas por día y prioridad',
    chart: 'bar',
    series: (['P1', 'P2', 'P3', 'P4'] as const)
      .filter((priority) => (byPriority.get(priority) ?? 0) > 0)
      .map((priority) => ({
        label: priority,
        points: orderedDays.map((day) => ({ x: day, y: days.get(day)?.get(priority) ?? 0 })),
      })),
  };
  const statusDonut: ReportChartSection = {
    type: 'chart',
    heading: 'Alertas por estado',
    chart: 'donut',
    series: [
      {
        label: 'Estado',
        points: topEntries(byStatus, 8).map(([x, y]) => ({ x, y })),
      },
    ],
  };

  const topRules = topEntries(
    countBy(matched, (alert) => alert['title']),
    10,
  );
  const topSources = topEntries(
    countBy(matched, (alert) => providerOf(alert['title'])),
    10,
  );
  const entityCounts = new Map<string, number>();
  for (const alert of matched) {
    for (const entity of entitiesOf(alert)) {
      const label = str(entity['label'], 120);
      if (label) entityCounts.set(label, (entityCounts.get(label) ?? 0) + 1);
    }
  }
  const topEntities = topEntries(entityCounts, 10);

  const sections: ReportSection[] = [];
  if (matched.length > 0) {
    if (perDay.series.length > 0) sections.push(perDay);
    sections.push(statusDonut);
    sections.push({
      type: 'table',
      heading: 'Reglas más frecuentes',
      columns: [
        { key: 'rule', label: 'Alerta / regla', kind: 'text' },
        { key: 'count', label: 'Cantidad', kind: 'number' },
      ],
      rows: topRules.map(([rule, count]) => ({ rule, count })),
    });
    sections.push({
      type: 'table',
      heading: 'Fuentes con más alertas',
      columns: [
        { key: 'source', label: 'Fuente', kind: 'text' },
        { key: 'count', label: 'Cantidad', kind: 'number' },
      ],
      rows: topSources.map(([source, count]) => ({ source, count })),
    });
    if (topEntities.length > 0) {
      sections.push({
        type: 'table',
        heading: 'Entidades más frecuentes',
        columns: [
          { key: 'entity', label: 'Entidad', kind: 'text' },
          { key: 'count', label: 'Cantidad', kind: 'number' },
        ],
        rows: topEntities.map(([entity, count]) => ({ entity, count })),
      });
    }
  }
  const shown = matched.slice(0, context.rowCap);
  sections.push({
    type: 'table',
    heading: 'Alertas',
    columns: ALERT_COLUMNS,
    rows: shown.map((alert) => alertRow(alert, context.consoleBaseUrl)),
    primary: true,
    ...(matched.length > shown.length || !complete
      ? {
          note: `${matched.length > shown.length ? `Se muestran ${shown.length} de ${matched.length} alertas. ` : ''}${complete ? '' : 'La búsqueda alcanzó el tope de 2000 alertas recientes: acota el periodo para ver el resto.'}`.trim(),
        }
      : {}),
  });

  const filters = [
    parsed.priorities.length > 0 ? `prioridades ${parsed.priorities.join(', ')}` : undefined,
    parsed.open ? 'solo abiertas' : undefined,
    parsed.source ? `fuente ${parsed.source}` : undefined,
  ].filter((filter): filter is string => filter !== undefined);
  return {
    kpis,
    sections,
    sources: [`QAPAQ SOC API · alertas (consulta ${stamp(context.now)} hora de Lima)`],
    period: { from: parsed.from.toISOString(), to: parsed.to.toISOString() },
    ...(filters.length > 0 ? { subtitle: `Filtros: ${filters.join(' · ')}` } : {}),
    rows: shown.length,
    citations: [],
  };
}

// ── kind = investigation ───────────────────────────────────────────────────────────────────

function eventLabel(event: Row): string {
  const identities = Array.isArray(event['identities']) ? (event['identities'] as Row[]) : [];
  const resources = Array.isArray(event['resources']) ? (event['resources'] as Row[]) : [];
  const parts = [
    ...identities.map((identity) => str(identity['principal'] ?? identity['id'], 120)),
    ...resources.map((resource) => str(resource['name'] ?? resource['id'], 120)),
  ].filter((part) => part !== '');
  return parts.slice(0, 3).join(' · ');
}

function eventMatches(event: Row, needles: readonly string[]): boolean {
  if (needles.length === 0) return false;
  const haystack = JSON.stringify([
    event['identities'],
    event['resources'],
    event['title'],
  ]).toLowerCase();
  return needles.some((needle) => haystack.includes(needle));
}

async function gatherInvestigation(context: ToolContext, scope: Row): Promise<Gathered> {
  if (!context.capabilities.has('alerts.read')) throw new ForbiddenError();
  const alertId = typeof scope['alertId'] === 'string' ? scope['alertId'].trim() : '';
  if (!ID.test(alertId)) throw new InputError('Falta «scope.alertId» o no es válido.');
  const windowKey =
    scope['window'] === undefined || scope['window'] === '' ? '24h' : String(scope['window']);
  const windowMs = WINDOWS[windowKey];
  if (windowMs === undefined) throw new InputError('«scope.window» debe ser 1h, 24h o 7d.');

  const detail = await context.get(`/api/alerts/${alertId}`);
  guardStatus(detail);
  const alert =
    isRecord(detail.body) && isRecord(detail.body['alert']) ? detail.body['alert'] : undefined;
  if (!alert) throw new ForbiddenError();
  const at = new Date(String(alert['occurredAt'] ?? ''));
  const reasons = Array.isArray(alert['reasons']) ? (alert['reasons'] as Row[]) : [];
  const entities = entitiesOf(alert);
  const relatedIds = (
    Array.isArray(alert['relatedAlertIds']) ? (alert['relatedAlertIds'] as unknown[]) : []
  )
    .filter((id): id is string => typeof id === 'string' && ID.test(id))
    .slice(0, REPORT_LIMITS.maxRelatedAlerts);

  const related: Row[] = [];
  await Promise.all(
    relatedIds.map(async (id) => {
      try {
        const response = await context.get(`/api/alerts/${id}`);
        if (
          response.status === 200 &&
          isRecord(response.body) &&
          isRecord(response.body['alert'])
        ) {
          related.push(response.body['alert']);
        }
      } catch {
        // Una relacionada que no se pudo leer no invalida el informe.
      }
    }),
  );
  related.sort((a, b) => String(a['occurredAt']).localeCompare(String(b['occurredAt'])));

  // Eventos relacionados de la ventana (si la persona puede leer eventos).
  const sources = [`QAPAQ SOC API · alerta ${alertId}`];
  let events: Row[] = [];
  let eventsNote: string | undefined;
  let eventsRead = false;
  if (!context.capabilities.has('events.read')) {
    eventsNote =
      'Tu rol no tiene permiso de lectura de eventos: no se incluyen eventos relacionados.';
  } else if (Number.isNaN(at.getTime())) {
    eventsNote = 'La alerta no tiene hora de origen válida: no se buscaron eventos relacionados.';
  } else {
    const from = new Date(at.getTime() - windowMs);
    const to = new Date(Math.min(at.getTime() + windowMs, context.now.getTime()));
    let cursor: string | undefined;
    try {
      for (let page = 0; page < REPORT_LIMITS.maxEventPages; page += 1) {
        const params = new URLSearchParams({
          from: from.toISOString(),
          to: to.toISOString(),
          pageSize: '200',
        });
        if (cursor) params.set('cursor', cursor);
        const response = await context.get(`/api/events?${params.toString()}`);
        if (response.status !== 200) {
          eventsNote = 'El explorador de eventos no respondió: sin eventos relacionados.';
          break;
        }
        if (isRecord(response.body) && response.body['status'] === 'disabled') {
          eventsNote = 'El explorador de eventos no está configurado en este entorno.';
          break;
        }
        eventsRead = true;
        events.push(...rowsOf(response.body));
        cursor = nextCursorOf(response.body);
        if (!cursor) break;
      }
    } catch {
      eventsNote = 'El explorador de eventos no respondió: sin eventos relacionados.';
    }
    if (eventsRead) {
      const needles = entities
        .map((entity) => str(entity['label'], 254).toLowerCase())
        .filter((label) => label.length >= 3);
      events = events.filter((event) => eventMatches(event, needles));
      eventsNote =
        needles.length === 0
          ? 'La alerta no tiene entidades para correlacionar eventos.'
          : `Eventos que mencionan alguna entidad de la alerta, de ${from.toISOString()} a ${to.toISOString()} (UTC).`;
      sources.push(
        `Wazuh Indexer · eventos normalizados (ventana ${windowKey}, consulta ${stamp(context.now)})`,
      );
    }
  }
  events.sort((a, b) => String(a['occurredAt']).localeCompare(String(b['occurredAt'])));
  const shownEvents = events.slice(0, context.rowCap);

  const sections: ReportSection[] = [
    {
      type: 'table',
      heading: 'Detalle de la alerta',
      columns: [
        { key: 'field', label: 'Campo', kind: 'text' },
        { key: 'value', label: 'Valor', kind: 'text' },
      ],
      rows: [
        { field: 'Identificador', value: str(alert['id'], 64) },
        { field: 'Título', value: str(alert['title']) },
        { field: 'Prioridad', value: str(alert['priority'], 4) },
        { field: 'Puntuación', value: str(alert['score'], 20) },
        { field: 'Estado', value: str(alert['status'], 40) },
        { field: 'Veredicto', value: str(alert['verdict'], 60) || 'sin veredicto' },
        { field: 'Fuente', value: providerOf(alert['title']) },
        { field: 'Ocurrió', value: isoOf(alert['occurredAt']) ?? '' },
        { field: 'Incidente', value: str(alert['incidentId'], 64) || 'sin incidente' },
        { field: 'Abrir en QAPAQ', value: investigationLink(context.consoleBaseUrl, alertId) },
      ],
    },
  ];
  if (reasons.length > 0) {
    sections.push({
      type: 'table',
      heading: 'Razones de la prioridad',
      columns: [
        { key: 'code', label: 'Código', kind: 'text' },
        { key: 'detail', label: 'Detalle', kind: 'text' },
      ],
      rows: reasons.slice(0, 40).map((reason) => ({
        code: str(reason['code'], 80),
        detail: str(reason['detail']),
      })),
    });
  }
  if (entities.length > 0) {
    sections.push({
      type: 'table',
      heading: 'Entidades involucradas',
      columns: [
        { key: 'kind', label: 'Tipo', kind: 'text' },
        { key: 'label', label: 'Entidad', kind: 'text' },
      ],
      rows: entities.slice(0, 40).map((entity) => ({
        kind: str(entity['kind'], 40),
        label: str(entity['label'], 254),
      })),
    });
  }
  if (related.length > 0) {
    sections.push({
      type: 'table',
      heading: 'Alertas relacionadas',
      columns: ALERT_COLUMNS,
      rows: related.map((entry) => alertRow(entry, context.consoleBaseUrl)),
    });
  }
  sections.push({
    type: 'table',
    heading: 'Eventos relacionados',
    columns: [
      { key: 'occurredAt', label: 'Ocurrió', kind: 'datetime' },
      { key: 'severity', label: 'Severidad', kind: 'text' },
      { key: 'category', label: 'Categoría', kind: 'text' },
      { key: 'outcome', label: 'Resultado', kind: 'text' },
      { key: 'title', label: 'Evento / regla', kind: 'text' },
      { key: 'entity', label: 'Entidades', kind: 'text' },
    ],
    rows: shownEvents.map((event) => ({
      occurredAt: isoOf(event['occurredAt']),
      severity: str(event['severity'], 40),
      category: str(event['category'], 60),
      outcome: str(event['outcome'], 40),
      title: str(event['title'] ?? event['action']),
      entity: eventLabel(event),
    })),
    primary: true,
    ...(eventsNote
      ? {
          note: `${eventsNote}${events.length > shownEvents.length ? ` Se muestran ${shownEvents.length} de ${events.length}.` : ''}`,
        }
      : {}),
  });

  // Cronología: la alerta, las relacionadas y los eventos, en orden.
  const timeline = [
    ...[alert, ...related].map((entry) => ({
      at: isoOf(entry['occurredAt']),
      title: `Alerta: ${str(entry['title'], 200)}`,
      detail: `${str(entry['status'], 40)} · puntuación ${str(entry['score'], 10)}`,
      priority: str(entry['priority'], 4),
    })),
    ...shownEvents.map((event) => ({
      at: isoOf(event['occurredAt']),
      title: `Evento: ${str(event['title'] ?? event['action'], 200)}`,
      detail: [str(event['category'], 60), str(event['outcome'], 40), eventLabel(event)]
        .filter((part) => part !== '')
        .join(' · '),
      priority: '',
    })),
  ]
    .filter((item): item is typeof item & { at: string } => item.at !== null)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, REPORT_LIMITS.maxTimelineItems);
  sections.push({
    type: 'timeline',
    heading: 'Cronología',
    items: timeline.map((item) => ({
      at: item.at,
      title: item.title,
      ...(item.detail ? { detail: item.detail } : {}),
      ...(item.priority ? { priority: item.priority } : {}),
    })),
  });

  return {
    kpis: [
      { label: 'Prioridad', value: str(alert['priority'], 4) || '—' },
      { label: 'Puntuación', value: str(alert['score'], 10) || '—' },
      { label: 'Estado', value: str(alert['status'], 40) || '—' },
      { label: 'Entidades', value: String(entities.length) },
      { label: 'Alertas relacionadas', value: String(related.length) },
      { label: 'Eventos relacionados', value: eventsRead ? String(events.length) : 'n/d' },
    ],
    sections,
    sources,
    subtitle: str(alert['title'], 200),
    ...(Number.isNaN(at.getTime())
      ? {}
      : {
          period: {
            from: new Date(at.getTime() - windowMs).toISOString(),
            to: new Date(Math.min(at.getTime() + windowMs, context.now.getTime())).toISOString(),
          },
        }),
    rows: shownEvents.length + related.length + 1,
    citations: [{ kind: 'alert', id: alertId, label: str(alert['title'], 120) || alertId }],
  };
}

// ── kind = incident ────────────────────────────────────────────────────────────────────────

async function readAll(context: ToolContext, path: string, pages = 5): Promise<Row[]> {
  const items: Row[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < pages; page += 1) {
    const params = new URLSearchParams({ pageSize: '200' });
    if (cursor) params.set('cursor', cursor);
    const response = await context.get(`${path}?${params.toString()}`);
    guardStatus(response);
    items.push(...rowsOf(response.body));
    cursor = nextCursorOf(response.body);
    if (!cursor) break;
  }
  return items;
}

async function gatherIncident(context: ToolContext, scope: Row): Promise<Gathered> {
  if (!context.capabilities.has('incidents.read')) throw new ForbiddenError();
  const incidentId = typeof scope['incidentId'] === 'string' ? scope['incidentId'].trim() : '';
  if (!ID.test(incidentId)) throw new InputError('Falta «scope.incidentId» o no es válido.');
  const detail = await context.get(`/api/incidents/${incidentId}`);
  guardStatus(detail);
  const incident =
    isRecord(detail.body) && isRecord(detail.body['incident'])
      ? detail.body['incident']
      : undefined;
  if (!incident) throw new ForbiddenError();

  const notes: string[] = [];
  const safe = async (label: string, run: () => Promise<Row[]>): Promise<Row[]> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ForbiddenError || error instanceof DegradedError) {
        notes.push(`No se pudo leer: ${label}.`);
        return [];
      }
      throw error;
    }
  };
  const canAlerts = context.capabilities.has('alerts.read');
  if (!canAlerts) notes.push('Tu rol no tiene alerts.read: no se incluyen las alertas vinculadas.');
  const [alerts, timeline, tasks, incidentNotes] = await Promise.all([
    canAlerts
      ? safe('alertas vinculadas', () => readAll(context, `/api/incidents/${incidentId}/alerts`))
      : [],
    safe('cronología', () => readAll(context, `/api/incidents/${incidentId}/timeline`)),
    safe('tareas', () => readAll(context, `/api/incidents/${incidentId}/tasks`)),
    safe('notas', () => readAll(context, `/api/incidents/${incidentId}/notes`)),
  ]);
  const openTasks = tasks.filter(
    (task) => task['status'] === 'open' || task['status'] === 'in_progress',
  ).length;
  const shownAlerts = alerts.slice(0, context.rowCap);

  const sections: ReportSection[] = [
    {
      type: 'table',
      heading: 'Detalle del incidente',
      columns: [
        { key: 'field', label: 'Campo', kind: 'text' },
        { key: 'value', label: 'Valor', kind: 'text' },
      ],
      rows: [
        { field: 'Identificador', value: str(incident['id'], 64) },
        { field: 'Título', value: str(incident['title']) },
        { field: 'Severidad', value: str(incident['severity'], 40) },
        { field: 'Estado', value: str(incident['status'], 40) },
        { field: 'Resumen', value: str(incident['summary']) },
        { field: 'Apertura', value: isoOf(incident['openedAt']) ?? '' },
        { field: 'Cierre', value: isoOf(incident['closedAt']) ?? 'abierto' },
        { field: 'Abrir en QAPAQ', value: incidentLink(context.consoleBaseUrl, incidentId) },
      ],
    },
    {
      type: 'table',
      heading: 'Alertas vinculadas',
      columns: ALERT_COLUMNS,
      rows: shownAlerts.map((alert) => alertRow(alert, context.consoleBaseUrl)),
      primary: true,
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    },
    {
      type: 'table',
      heading: 'Tareas',
      columns: [
        { key: 'title', label: 'Tarea', kind: 'text' },
        { key: 'status', label: 'Estado', kind: 'text' },
        { key: 'required', label: 'Obligatoria', kind: 'text' },
        { key: 'dueAt', label: 'Vence', kind: 'datetime' },
        { key: 'completedAt', label: 'Completada', kind: 'datetime' },
      ],
      rows: tasks.slice(0, 200).map((task) => ({
        title: str(task['title']),
        status: str(task['status'], 40),
        required: task['required'] ? 'sí' : 'no',
        dueAt: isoOf(task['dueAt']),
        completedAt: isoOf(task['completedAt']),
      })),
    },
    {
      type: 'table',
      heading: 'Notas de investigación',
      columns: [
        { key: 'createdAt', label: 'Fecha', kind: 'datetime' },
        { key: 'body', label: 'Nota', kind: 'text' },
      ],
      rows: incidentNotes.slice(0, 200).map((note) => ({
        createdAt: isoOf(note['createdAt']),
        body: str(note['body']),
      })),
    },
    {
      type: 'timeline',
      heading: 'Cronología',
      items: timeline
        .map((entry) => ({
          at: isoOf(entry['at']),
          title: str(entry['summary'], 200) || str(entry['kind'], 60),
          detail: str(entry['kind'], 60),
        }))
        .filter((item): item is typeof item & { at: string } => item.at !== null)
        .sort((a, b) => a.at.localeCompare(b.at))
        .slice(0, REPORT_LIMITS.maxTimelineItems),
    },
  ];

  return {
    kpis: [
      { label: 'Severidad', value: str(incident['severity'], 40) || '—' },
      { label: 'Estado', value: str(incident['status'], 40) || '—' },
      { label: 'Alertas vinculadas', value: String(alerts.length) },
      { label: 'Tareas abiertas', value: String(openTasks), hint: `de ${tasks.length}` },
      { label: 'Notas', value: String(incidentNotes.length) },
    ],
    sections,
    sources: [
      `QAPAQ SOC API · incidente ${incidentId} (consulta ${stamp(context.now)} hora de Lima)`,
    ],
    subtitle: str(incident['title'], 200),
    rows: shownAlerts.length + tasks.length + incidentNotes.length,
    citations: [
      { kind: 'incident', id: incidentId, label: str(incident['title'], 120) || incidentId },
    ],
  };
}

// ── herramienta ────────────────────────────────────────────────────────────────────────────

export interface StoredReport {
  readonly artifact: ArtifactRef;
  readonly kind: ReportKind;
  readonly format: ArtifactFormat;
  readonly size: number;
  readonly sha256: string;
  readonly rows: number;
  readonly pages: number | undefined;
}

export interface ReportToolDependencies {
  readonly get: InternalGet;
  readonly capabilities: ReadonlySet<string>;
  readonly displayName: string;
  readonly consoleBaseUrl: string;
  readonly now: () => Date;
  /** Sin cliente, la herramienta responde `unavailable`. */
  readonly reports: ReportsClient | undefined;
  readonly vault: ArtifactVault;
  readonly owner: ArtifactOwner;
  readonly conversationId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Se invoca en cuanto el archivo está guardado (SSE, auditoría); no debe lanzar. */
  readonly onStored?: (stored: StoredReport) => void | Promise<void>;
}

function narrativeSections(input: ToolInput): ReportSection[] {
  const narrative = isRecord(input['narrative']) ? input['narrative'] : {};
  const out: ReportSection[] = [];
  const add = (heading: string, value: unknown, max: number) => {
    const body = clampNarrative(value, max);
    if (body !== '') out.push({ type: 'markdown', heading, body });
  };
  add('Resumen ejecutivo', narrative['executiveSummary'], REPORT_LIMITS.summary);
  add('Hallazgos', narrative['findings'], REPORT_LIMITS.findings);
  add('Recomendaciones', narrative['recommendations'], REPORT_LIMITS.recommendations);
  return out;
}

export function buildReportTool(deps: ReportToolDependencies): AssistantTool {
  return {
    name: 'generate_report',
    label: 'Generando informe',
    labelFor: (input) => reportActivityLabel(input['format']),
    description:
      'Genera un informe descargable (PDF, Excel o CSV) con datos reales del SOC y lo adjunta a la conversación. ÚSALA cuando la persona pida un informe, reporte, PDF, Excel o CSV. La API obtiene las tablas, KPIs, gráficos y cronologías con los permisos de la persona; tú solo eliges formato, tipo y alcance, y redactas un título y una narrativa breve en markdown (sin HTML, sin cifras inventadas: solo lo que consultaste). Tipos: `alerts` (alertas de un periodo; scope: from/to ISO UTC —por defecto los últimos 7 días—, priorities, status open|all, source), `investigation` (una alerta con sus entidades, alertas y eventos relacionados; scope: alertId obligatorio y window 1h|24h|7d), `incident` (un incidente con sus alertas, tareas, notas y cronología; scope: incidentId obligatorio). Devuelve solo el id y el nombre del archivo; no pegues tablas en el chat.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['format', 'kind'],
      properties: {
        format: { type: 'string', enum: [...REPORT_FORMATS], description: 'pdf por defecto.' },
        kind: { type: 'string', enum: [...REPORT_KINDS] },
        title: { type: 'string', maxLength: REPORT_LIMITS.title },
        scope: {
          type: 'object',
          additionalProperties: false,
          properties: {
            from: { type: 'string', description: 'Inicio ISO 8601 UTC (…Z).' },
            to: { type: 'string', description: 'Fin ISO 8601 UTC (…Z).' },
            priorities: {
              type: 'array',
              items: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'] },
            },
            status: { type: 'string', enum: ['open', 'all'] },
            source: {
              type: 'string',
              description: 'Fuente: snyk, bitdefender, cloudflare, aws, m365 o wazuh.',
            },
            alertId: { type: 'string' },
            window: { type: 'string', enum: ['1h', '24h', '7d'] },
            incidentId: { type: 'string' },
          },
        },
        narrative: {
          type: 'object',
          additionalProperties: false,
          properties: {
            executiveSummary: { type: 'string', maxLength: REPORT_LIMITS.summary },
            findings: { type: 'string', maxLength: REPORT_LIMITS.findings },
            recommendations: { type: 'string', maxLength: REPORT_LIMITS.recommendations },
          },
        },
      },
    },
    async run(input): Promise<ToolOutcome> {
      try {
        const format = input['format'];
        const kind = input['kind'];
        if (!(REPORT_FORMATS as readonly unknown[]).includes(format)) {
          throw new InputError('«format» debe ser pdf, xlsx o csv.');
        }
        if (!(REPORT_KINDS as readonly unknown[]).includes(kind)) {
          throw new InputError('«kind» debe ser alerts, investigation o incident.');
        }
        const reportFormat = format as ArtifactFormat;
        const reportKind = kind as (typeof REPORT_KINDS)[number];
        if (!deps.reports) {
          return {
            ok: false,
            error:
              'unavailable: el servicio de informes no está configurado en este entorno. Ofrece un resumen en el chat.',
          };
        }
        const now = deps.now();
        const context: ToolContext = {
          get: deps.get,
          capabilities: deps.capabilities,
          consoleBaseUrl: deps.consoleBaseUrl,
          now,
          rowCap: reportFormat === 'pdf' ? REPORT_LIMITS.maxRowsPdf : REPORT_LIMITS.maxRowsData,
        };
        const scope = isRecord(input['scope']) ? input['scope'] : {};
        const gathered =
          reportKind === 'alerts'
            ? await gatherAlerts(context, scope)
            : reportKind === 'investigation'
              ? await gatherInvestigation(context, scope)
              : await gatherIncident(context, scope);

        const title =
          str(input['title'], REPORT_LIMITS.title).trim() ||
          DEFAULT_TITLES[reportKind] ||
          'Informe';
        const sections = [...narrativeSections(input), ...gathered.sections];
        const spec: ReportSpec = {
          version: 1,
          format: reportFormat,
          kind: reportKind,
          title,
          ...(gathered.subtitle ? { subtitle: str(gathered.subtitle, 240) } : {}),
          generatedAt: now.toISOString(),
          generatedBy: str(deps.displayName, 120) || 'Usuario QAPAQ',
          timeZone: TIME_ZONE,
          classification: CLASSIFICATION,
          ...(gathered.period ? { period: gathered.period } : {}),
          kpis: gathered.kpis.slice(0, 8),
          sections: sections.slice(0, 40),
          sources: [...gathered.sources, 'Informe generado por Qapaqzito (narrativa revisable)'],
        };
        const rendered = await deps.reports.render(spec, deps.signal);
        const stampName = stamp(now).replace(' ', '-').replace(':', '');
        const meta = await deps.vault.create(deps.owner, {
          filename: `QAPAQ-informe-${KIND_FILE[reportKind]}-${stampName}`,
          format: reportFormat,
          title,
          content: rendered.bytes,
          conversationId: deps.conversationId,
        });
        const artifact = artifactRefOf(meta);
        const stored: StoredReport = {
          artifact,
          kind: reportKind,
          format: reportFormat,
          size: meta.size,
          sha256: meta.sha256,
          rows: gathered.rows,
          pages: rendered.pages,
        };
        try {
          await deps.onStored?.(stored);
        } catch {
          // La entrega del evento o la auditoría no deben perder un archivo ya guardado.
        }
        return {
          ok: true,
          data: {
            artifactId: meta.id,
            filename: meta.filename,
            format: reportFormat,
            rows: gathered.rows,
            ...(rendered.pages ? { pages: rendered.pages } : {}),
            expiresInHours: 24,
            attached: true,
          },
          ...(gathered.citations.length > 0 ? { citations: gathered.citations } : {}),
        };
      } catch (error) {
        return failureOf(error);
      }
    },
  };
}

/** Etiqueta de actividad según el formato pedido («Generando informe PDF»). */
function reportActivityLabel(format: unknown): string {
  return LABELS[format as ArtifactFormat] ?? 'Generando informe';
}

function failureOf(error: unknown): ToolOutcome {
  if (error instanceof InputError) return { ok: false, error: error.message };
  if (error instanceof ForbiddenError) {
    return {
      ok: false,
      error: 'forbidden: el recurso no existe o tu rol no tiene permiso para generar este informe.',
    };
  }
  if (error instanceof DegradedError) {
    return { ok: false, error: 'La fuente de datos está degradada ahora mismo; reintenta luego.' };
  }
  if (error instanceof ArtifactError) {
    return {
      ok: false,
      error:
        error.code === 'QUOTA'
          ? 'Alcanzaste el límite de 20 informes por día. Intenta de nuevo más tarde.'
          : error.code === 'TOO_LARGE'
            ? 'El archivo supera los 25 MB; acota el periodo o el alcance.'
            : 'No se pudo guardar el informe.',
    };
  }
  if (error instanceof ReportsError) {
    return {
      ok: false,
      error:
        error.code === 'TIMEOUT'
          ? 'unavailable: el servicio de informes tardó demasiado; reintenta con un alcance menor.'
          : error.code === 'TOO_LARGE'
            ? 'El informe es demasiado grande; acota el periodo o el alcance.'
            : error.code === 'SPEC_INVALID' || error.code === 'RENDER_FAILED'
              ? 'El servicio de informes no pudo generar este informe.'
              : 'unavailable: el servicio de informes no responde ahora mismo.',
    };
  }
  return { ok: false, error: 'No se pudo generar el informe.' };
}
