/**
 * Herramientas compuestas de investigación de Qapaqzito. Como las demás, solo hacen `GET` por la API
 * **con la sesión de la persona** (`InternalGet`): heredan la autorización, la proyección de campos
 * (p. ej. `raw` solo con `events.read_raw`) y las redacciones. Lo que añaden es filtrado y resumen
 * del lado del servidor para que el modelo reciba datos compactos y citables:
 *
 * - `find_alerts`: proveedor, entidad (IP, usuario, host) y rango de tiempo sobre `/api/alerts`.
 * - `get_alert_context`: alerta + regla QAPAQ con MITRE y runbook + evento de origen (+ crudo).
 * - `entity_activity`: alertas y eventos de una entidad en una ventana.
 * - `get_entity_risk`: riesgo de entidad del motor de correlación, si está desplegado.
 *
 * Los recorridos están acotados (páginas y tamaño de resultado) para no degradar la API.
 */

import type { AssistantTool, Citation, ToolInput, ToolOutcome } from '@qapaq/assistant';

import { ruleForAlert, ruleView, type SocKnowledge } from './soc-knowledge.js';

/** Id de regla de una alerta del API (`ruleId`), si viene como texto. */
const ruleIdOf = (alert: Record<string, unknown>): string | null =>
  typeof alert['ruleId'] === 'string' ? alert['ruleId'] : null;
import { SOC_KNOWLEDGE } from './soc-knowledge.generated.js';
import type { InternalGet, InternalResponse } from './soc-tools.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const ID = /^[A-Za-z0-9_-]{1,64}$/u;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LIMA_OFFSET_MS = 5 * HOUR;
/** Páginas de 200 alertas que se recorren como máximo en una búsqueda. */
const MAX_ALERT_PAGES = 5;
/** Páginas de 200 eventos que se recorren como máximo en una búsqueda por entidad. */
const MAX_EVENT_PAGES = 3;
const RAW_MAX_CHARS = 4_000;

export const PROVIDERS = ['snyk', 'bitdefender', 'cloudflare', 'aws', 'm365', 'wazuh'] as const;
export type Provider = (typeof PROVIDERS)[number];

class InputError extends Error {}

/** `2026-11-05 09:12 Lima (14:12 UTC)`. */
export function limaLabel(iso: unknown): string | null {
  if (typeof iso !== 'string') return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const lima = new Date(at.getTime() - LIMA_OFFSET_MS).toISOString();
  return `${lima.slice(0, 10)} ${lima.slice(11, 16)} Lima (${iso.slice(11, 16)} UTC)`;
}

/** Proveedor de origen según el prefijo «QAPAQ <Fuente>:» del título (o palabras clave). */
export function providerOf(title: unknown): Provider {
  const text = typeof title === 'string' ? title.toLocaleLowerCase('es') : '';
  if (text.includes('snyk')) return 'snyk';
  if (text.includes('bitdefender') || text.includes('gravityzone')) return 'bitdefender';
  if (text.includes('cloudflare')) return 'cloudflare';
  if (/\baws\b|cloudtrail|guardduty|\biam\b/u.test(text)) return 'aws';
  if (/\bm365\b|office 365|office365|\bentra\b|exchange|sharepoint/u.test(text)) return 'm365';
  return 'wazuh';
}

function str(input: ToolInput, key: string, max: number): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw new InputError(`El parámetro «${key}» no es válido.`);
  }
  if ([...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) {
    throw new InputError(`El parámetro «${key}» no es válido.`);
  }
  return value.trim();
}

function iso(input: ToolInput, key: string): Date | undefined {
  const value = str(input, key, 30);
  if (value === undefined) return undefined;
  if (!ISO.test(value)) throw new InputError(`«${key}» debe ser ISO 8601 en UTC (…Z).`);
  return new Date(value);
}

function oneOf<T extends string>(
  input: ToolInput,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new InputError(`«${key}» debe ser uno de: ${allowed.join(', ')}.`);
  }
  return value as T;
}

function int(input: ToolInput, key: string, min: number, max: number, fallback: number): number {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new InputError(`«${key}» debe ser un entero entre ${min} y ${max}.`);
  }
  return value;
}

function failure(response: InternalResponse): ToolOutcome {
  if (response.status === 401) return { ok: false, error: 'La sesión de la persona expiró.' };
  if (response.status === 403 || response.status === 404) {
    return { ok: false, error: 'No disponible: el recurso no existe o tu rol no tiene acceso.' };
  }
  if (response.status >= 500)
    return { ok: false, error: 'La fuente de datos está degradada ahora mismo.' };
  return { ok: false, error: 'La consulta no es válida.' };
}

type Row = Record<string, unknown>;

/** Añade `<campo>Lima` junto a cada marca de tiempo ISO (`…At`, `firstSeen`, `lastSeen`). */
function withLima(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => withLima(item, depth + 1));
  const out: Row = {};
  for (const [key, field] of Object.entries(value as Row)) {
    out[key] = withLima(field, depth + 1);
    if ((key.endsWith('At') || key.endsWith('Seen')) && typeof field === 'string') {
      const label = limaLabel(field);
      if (label) out[`${key}Lima`] = label;
    }
  }
  return out;
}

function rowsOf(body: unknown): Row[] {
  const items = (body as Row | null)?.['items'];
  return Array.isArray(items) ? (items as Row[]) : [];
}

function entitiesOf(alert: Row): Row[] {
  return Array.isArray(alert['entities']) ? (alert['entities'] as Row[]) : [];
}

/** Proyección compacta y citable de una alerta. */
export function compactAlert(alert: Row) {
  const reasons = Array.isArray(alert['reasons']) ? (alert['reasons'] as Row[]) : [];
  const related = Array.isArray(alert['relatedAlertIds'])
    ? (alert['relatedAlertIds'] as string[])
    : [];
  const rule =
    typeof alert['title'] === 'string'
      ? ruleForAlert(SOC_KNOWLEDGE, { ruleId: ruleIdOf(alert), title: alert['title'] })
      : undefined;
  return {
    id: alert['id'],
    title: alert['title'],
    provider: providerOf(alert['title']),
    priority: alert['priority'],
    score: alert['score'],
    status: alert['status'],
    verdict: alert['verdict'] ?? null,
    assigned: Boolean(alert['assigneeId']),
    incidentId: alert['incidentId'] ?? null,
    occurredAt: alert['occurredAt'],
    occurredAtLima: limaLabel(alert['occurredAt']),
    signal: alert['signal'] ?? null,
    ...(rule ? { ruleId: rule.id, mitre: rule.mitre } : {}),
    reasons: reasons.slice(0, 4).map((reason) => reason['detail'] ?? reason['code']),
    entities: entitiesOf(alert).map((entity) => ({
      kind: entity['kind'],
      label: entity['label'],
      ref: entity['ref'],
    })),
    relatedAlertIds: related.slice(0, 5),
  };
}

function matchesEntity(alert: Row, needle: string): boolean {
  const target = needle.toLocaleLowerCase('es');
  return (
    entitiesOf(alert).some(
      (entity) =>
        String(entity['label'] ?? '')
          .toLocaleLowerCase('es')
          .includes(target) || String(entity['ref'] ?? '') === needle,
    ) ||
    String(alert['title'] ?? '')
      .toLocaleLowerCase('es')
      .includes(target)
  );
}

function countBy<T>(items: readonly T[], key: (item: T) => unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const name = String(key(item) ?? 'desconocido');
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

interface AlertScan {
  readonly matched: Row[];
  readonly scanned: number;
  readonly complete: boolean;
}

/** Recorre `/api/alerts` (más recientes primero) aplicando filtros que la API no tiene. */
async function scanAlerts(
  get: InternalGet,
  filters: {
    status?: string | undefined;
    priority?: string | undefined;
    text?: string | undefined;
    provider?: Provider | undefined;
    entity?: string | undefined;
    from?: Date | undefined;
    to?: Date | undefined;
  },
): Promise<AlertScan | InternalResponse> {
  const matched: Row[] = [];
  let scanned = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_ALERT_PAGES; page += 1) {
    const params = new URLSearchParams({ pageSize: '200' });
    if (filters.status) params.set('status', filters.status);
    if (filters.priority) params.set('priority', filters.priority);
    if (filters.text) params.set('q', filters.text);
    if (cursor) params.set('cursor', cursor);
    const response = await get(`/api/alerts?${params.toString()}`);
    if (response.status !== 200) return response;
    const items = rowsOf(response.body);
    scanned += items.length;
    let older = false;
    for (const alert of items) {
      const at = new Date(String(alert['occurredAt'] ?? ''));
      if (filters.to && at > filters.to) continue;
      if (filters.from && at < filters.from) {
        older = true;
        continue;
      }
      if (filters.provider && providerOf(alert['title']) !== filters.provider) continue;
      if (filters.entity && !matchesEntity(alert, filters.entity)) continue;
      matched.push(alert);
    }
    const next = (response.body as Row | null)?.['nextCursor'];
    if (older || typeof next !== 'string' || next === '')
      return { matched, scanned, complete: true };
    cursor = next;
  }
  return { matched, scanned, complete: false };
}

function citeAlerts(alerts: readonly Row[]): Citation[] {
  return alerts
    .filter((alert) => typeof alert['id'] === 'string')
    .slice(0, 20)
    .map((alert) => ({
      kind: 'alert',
      id: String(alert['id']),
      label: String(alert['title'] ?? alert['id']),
    }));
}

function isScan(value: AlertScan | InternalResponse): value is AlertScan {
  return 'matched' in value;
}

function guarded(run: (input: ToolInput) => Promise<ToolOutcome>) {
  return async (input: ToolInput): Promise<ToolOutcome> => {
    try {
      return await run(input);
    } catch (error) {
      if (error instanceof InputError) return { ok: false, error: error.message };
      return { ok: false, error: 'El servicio del SOC no respondió.' };
    }
  };
}

/** Evento compacto; `raw` (solo con events.read_raw) truncado. */
function compactEvent(event: Row, withRaw: boolean) {
  const raw = event['raw'];
  const rawText = raw === undefined || raw === null ? undefined : JSON.stringify(raw);
  return {
    recordId: event['recordId'],
    occurredAt: event['occurredAt'],
    occurredAtLima: limaLabel(event['occurredAt']),
    title: event['title'],
    severity: event['severity'],
    category: event['category'],
    outcome: event['outcome'],
    action: event['action'],
    rule: event['rule'],
    identities: event['identities'],
    resources: event['resources'],
    source: event['source'],
    ...(withRaw && rawText
      ? {
          raw:
            rawText.length > RAW_MAX_CHARS
              ? `${rawText.slice(0, RAW_MAX_CHARS)}…[crudo truncado]`
              : raw,
        }
      : {}),
  };
}

async function readEvents(
  get: InternalGet,
  from: Date,
  to: Date,
  pages: number,
): Promise<{ events: Row[]; complete: boolean; status?: string } | InternalResponse> {
  const events: Row[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < pages; page += 1) {
    const params = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      pageSize: '200',
    });
    if (cursor) params.set('cursor', cursor);
    const response = await get(`/api/events?${params.toString()}`);
    if (response.status !== 200) return response;
    const body = response.body as Row | null;
    if (body?.['status'] === 'disabled') return { events, complete: true, status: 'disabled' };
    events.push(...rowsOf(body));
    const next = body?.['nextCursor'];
    if (typeof next !== 'string' || next === '') return { events, complete: true };
    cursor = next;
  }
  return { events, complete: false };
}

export function buildInvestigationTools(
  get: InternalGet,
  capabilities: ReadonlySet<string>,
  knowledge: SocKnowledge = SOC_KNOWLEDGE,
): AssistantTool[] {
  const tools: AssistantTool[] = [];
  const canEvents = capabilities.has('events.read');
  const canRaw = capabilities.has('events.read_raw');

  if (capabilities.has('alerts.read')) {
    tools.push({
      name: 'find_alerts',
      label: 'Buscando alertas',
      description:
        'Busca alertas del SOC combinando filtros que la consola no ofrece juntos: proveedor de origen, entidad (IP, usuario/UPN, host o referencia ent_…), rango de tiempo, prioridad, estado y texto. Devuelve conteos por prioridad, proveedor y estado, y hasta `limit` alertas compactas (id, título, prioridad, estado, hora Lima/UTC, entidades, regla y MITRE si se conoce). Úsala para colas («P1 abiertas»), panoramas por proveedor («alertas de Snyk de la semana»), resúmenes semanales y para saber qué alertas tocan una entidad. Recorre como máximo 1000 alertas recientes; si `complete` es false, acota con fechas. `provider=wazuh` son las detecciones propias de Wazuh (Linux, Windows, AD, FIM); `m365` hoy no tiene datos (fuente bloqueada).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', enum: [...PROVIDERS], description: 'Proveedor de origen.' },
          entity: {
            type: 'string',
            maxLength: 254,
            description:
              'IP, usuario (UPN/correo), host o referencia `ent_…`. Coincidencia parcial sin distinguir mayúsculas.',
          },
          priority: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'] },
          status: {
            type: 'string',
            enum: ['open', 'new', 'acknowledged', 'triaged', 'escalated', 'closed'],
            description: '`open` = todo lo pendiente de trabajo. Sin estado: todas.',
          },
          text: { type: 'string', maxLength: 120, description: 'Texto en título y razones.' },
          from: { type: 'string', description: 'Inicio ISO 8601 UTC (…Z), inclusive.' },
          to: { type: 'string', description: 'Fin ISO 8601 UTC (…Z).' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 40,
            description: 'Alertas a devolver (por defecto 15).',
          },
        },
      },
      run: guarded(async (input) => {
        const filters = {
          provider: oneOf(input, 'provider', PROVIDERS),
          entity: str(input, 'entity', 254),
          priority: oneOf(input, 'priority', ['P1', 'P2', 'P3', 'P4'] as const),
          status: oneOf(input, 'status', [
            'open',
            'new',
            'acknowledged',
            'triaged',
            'escalated',
            'closed',
          ] as const),
          text: str(input, 'text', 120),
          from: iso(input, 'from'),
          to: iso(input, 'to'),
        };
        const limit = int(input, 'limit', 1, 40, 15);
        const scan = await scanAlerts(get, filters);
        if (!isScan(scan)) return failure(scan);
        const items = scan.matched.slice(0, limit);
        return {
          ok: true,
          data: {
            matched: scan.matched.length,
            scanned: scan.scanned,
            complete: scan.complete,
            byPriority: countBy(scan.matched, (alert) => alert['priority']),
            byProvider: countBy(scan.matched, (alert) => providerOf(alert['title'])),
            byStatus: countBy(scan.matched, (alert) => alert['status']),
            ...(scan.matched.length > 0
              ? {
                  newestLima: limaLabel(scan.matched[0]?.['occurredAt']),
                  oldestLima: limaLabel(scan.matched[scan.matched.length - 1]?.['occurredAt']),
                }
              : {}),
            items: items.map(compactAlert),
            ...(scan.matched.length > items.length
              ? { omitted: scan.matched.length - items.length }
              : {}),
          },
          citations: citeAlerts(items),
        };
      }),
    });

    tools.push({
      name: 'get_alert_context',
      label: 'Abriendo la alerta con su contexto',
      description:
        'Expediente completo de UNA alerta por su id: detalle (razones de prioridad, puntaje, entidades, señal, relacionadas, incidente), la regla QAPAQ que la generó con su mapeo MITRE ATT&CK, casos de uso, falsos positivos conocidos y runbook aplicable, y el evento de origen de Wazuh (con el documento crudo si el rol tiene events.read_raw). Úsala para triage, «explícame esta alerta» y antes de recomendar acciones.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Identificador de la alerta (tal cual).' },
        },
        required: ['id'],
      },
      run: guarded(async (input) => {
        const id = str(input, 'id', 64);
        if (!id || !ID.test(id)) throw new InputError('Falta el parámetro «id» o no es válido.');
        const response = await get(`/api/alerts/${id}`);
        if (response.status !== 200) return failure(response);
        const alert = ((response.body as Row | null)?.['alert'] ?? {}) as Row;
        const rule =
          typeof alert['title'] === 'string'
            ? ruleForAlert(knowledge, { ruleId: ruleIdOf(alert), title: alert['title'] })
            : undefined;
        let sourceEvent: unknown = null;
        let sourceNote: string | undefined;
        const rawRef =
          typeof alert['rawRef'] === 'string' ? alert['rawRef'].replace(/^raw:/u, '') : undefined;
        const at = new Date(String(alert['occurredAt'] ?? ''));
        if (!canEvents) {
          sourceNote = 'Tu rol no tiene events.read: no se consultó el evento de origen.';
        } else if (!Number.isNaN(at.getTime())) {
          const window = await readEvents(
            get,
            new Date(at.getTime() - 15 * 60_000),
            new Date(at.getTime() + 5 * 60_000),
            2,
          );
          if ('events' in window) {
            const match =
              (rawRef && window.events.find((event) => event['recordId'] === rawRef)) ||
              window.events.find((event) => event['title'] === alert['title']);
            if (match) sourceEvent = compactEvent(match, canRaw);
            else
              sourceNote =
                window.status === 'disabled'
                  ? 'El explorador de eventos no está configurado.'
                  : 'No encontré el evento de origen en la ventana de ±15 min.';
          } else {
            sourceNote = 'El explorador de eventos no respondió.';
          }
        }
        const related = Array.isArray(alert['relatedAlertIds'])
          ? (alert['relatedAlertIds'] as string[])
          : [];
        const citations: Citation[] = [
          { kind: 'alert', id, label: String(alert['title'] ?? id) },
          ...related.slice(0, 5).map((relatedId) => ({
            kind: 'alert' as const,
            id: relatedId,
            label: 'Alerta relacionada',
          })),
          ...(typeof alert['incidentId'] === 'string'
            ? [{ kind: 'incident' as const, id: alert['incidentId'], label: 'Incidente vinculado' }]
            : []),
        ];
        return {
          ok: true,
          data: {
            alert: {
              ...compactAlert(alert),
              reasons: alert['reasons'],
              revision: alert['revision'],
            },
            rule: rule ? ruleView(knowledge, rule) : null,
            ...(rule
              ? {}
              : {
                  ruleNote: 'No identifiqué la regla QAPAQ de esta alerta: sin mapeo MITRE conocido.',
                }),
            sourceEvent,
            ...(sourceNote ? { sourceNote } : {}),
            ...(canRaw ? {} : { rawNote: 'El documento crudo requiere events.read_raw.' }),
          },
          citations,
        };
      }),
    });

    tools.push({
      name: 'entity_activity',
      label: 'Investigando la entidad',
      description:
        'Actividad de UNA entidad (IP, usuario/UPN, host o referencia ent_…): alertas que la involucran en la ventana (por defecto 7 días) y, si el rol tiene events.read, eventos de Wazuh donde aparece (ventana de eventos por defecto 24 h, máximo 31 días) con conteos por categoría, resultado y regla, primera y última vez vista. Úsala para «¿qué más hizo esta IP/usuario?», alertas relacionadas y alcance de un incidente.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entity: {
            type: 'string',
            maxLength: 254,
            description: 'IP, UPN/correo, host o `ent_…`.',
          },
          from: { type: 'string', description: 'Inicio ISO 8601 UTC (…Z).' },
          to: { type: 'string', description: 'Fin ISO 8601 UTC (…Z). Por defecto, ahora.' },
          includeEvents: {
            type: 'boolean',
            description: 'Buscar también en eventos (por defecto true).',
          },
        },
        required: ['entity'],
      },
      run: guarded(async (input) => {
        const entity = str(input, 'entity', 254);
        if (!entity || entity.length < 3)
          throw new InputError('Indica la entidad (mínimo 3 caracteres).');
        const to = iso(input, 'to') ?? new Date();
        const fromInput = iso(input, 'from');
        const alertsFrom = fromInput ?? new Date(to.getTime() - 7 * DAY);
        const scan = await scanAlerts(get, { entity, from: alertsFrom, to });
        if (!isScan(scan)) return failure(scan);
        const alerts = scan.matched;
        let events: unknown = { note: 'Tu rol no tiene events.read: no se consultaron eventos.' };
        if (canEvents && input['includeEvents'] !== false) {
          const eventsFrom = new Date(
            Math.max(fromInput?.getTime() ?? to.getTime() - DAY, to.getTime() - 31 * DAY),
          );
          const read = await readEvents(get, eventsFrom, to, MAX_EVENT_PAGES);
          if ('events' in read) {
            const needle = entity.toLocaleLowerCase('es');
            const hits = read.events.filter((event) =>
              JSON.stringify([
                event['identities'],
                event['resources'],
                event['source'],
                event['extensions'],
              ])
                .toLocaleLowerCase('es')
                .includes(needle),
            );
            events =
              read.status === 'disabled'
                ? { note: 'El explorador de eventos no está configurado.' }
                : {
                    window: {
                      fromLima: limaLabel(eventsFrom.toISOString()),
                      toLima: limaLabel(to.toISOString()),
                    },
                    scanned: read.events.length,
                    complete: read.complete,
                    matched: hits.length,
                    byCategory: countBy(hits, (event) => event['category']),
                    byOutcome: countBy(hits, (event) => event['outcome']),
                    byRule: countBy(hits, (event) => (event['rule'] as Row | null)?.['id']),
                    firstSeenLima: limaLabel(hits[hits.length - 1]?.['occurredAt']),
                    lastSeenLima: limaLabel(hits[0]?.['occurredAt']),
                    sample: hits.slice(0, 8).map((event) => compactEvent(event, false)),
                  };
          } else {
            events = { note: 'El explorador de eventos no respondió o la consulta no es válida.' };
          }
        }
        return {
          ok: true,
          data: {
            entity,
            alerts: {
              window: {
                fromLima: limaLabel(alertsFrom.toISOString()),
                toLima: limaLabel(to.toISOString()),
              },
              matched: alerts.length,
              complete: scan.complete,
              byPriority: countBy(alerts, (alert) => alert['priority']),
              byProvider: countBy(alerts, (alert) => providerOf(alert['title'])),
              items: alerts.slice(0, 12).map(compactAlert),
            },
            events,
          },
          citations: citeAlerts(alerts.slice(0, 12)),
        };
      }),
    });
  }

  if (capabilities.has('alerts.read')) {
    const RISK_TYPES = ['user', 'ip', 'host', 'cloud'] as const;
    const unavailable = (note: string): ToolOutcome => ({
      ok: true,
      data: { available: false, note },
    });
    const ENGINE_DOWN =
      'El motor de riesgo de entidades (correlador QAPAQ) no está disponible ahora. No hay un valor de riesgo que informar: no lo estimes; usa entity_activity para describir la actividad.';
    tools.push({
      name: 'get_entity_risk',
      label: 'Consultando el riesgo de la entidad',
      description:
        'Riesgo de entidades calculado por el correlador de QAPAQ (puntaje, pico, observaciones, tácticas, fuentes, contribuyentes por regla y candidatos a alerta). Con `value` (UPN/correo, IP, host o referencia `ent_…`) devuelve el detalle de esa entidad; sin `value` devuelve el ranking de entidades con más riesgo (opcionalmente de un `type`). Si el motor no está desplegado o la entidad no tiene puntaje, lo indica: en ese caso no estimes un riesgo numérico.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: [...RISK_TYPES], description: 'Tipo de entidad.' },
          value: {
            type: 'string',
            maxLength: 254,
            description: 'UPN/correo, IP, host o referencia `ent_…`. Omítelo para el ranking.',
          },
          top: {
            type: 'integer',
            minimum: 1,
            maximum: 50,
            description: 'Tamaño del ranking (10).',
          },
        },
      },
      run: guarded(async (input) => {
        const type = oneOf(input, 'type', RISK_TYPES);
        const value = str(input, 'value', 254);
        if (!value) {
          const top = int(input, 'top', 1, 50, 10);
          const response = await get(`/api/risk/entities?top=${top}${type ? `&type=${type}` : ''}`);
          if ([404, 501, 502, 503].includes(response.status)) return unavailable(ENGINE_DOWN);
          if (response.status !== 200) return failure(response);
          const { correlationId: _omit, ...data } = (response.body ?? {}) as Row;
          return { ok: true, data: withLima({ available: true, ...data }) };
        }
        if (!type)
          throw new InputError('Indica «type» (user, ip, host o cloud) junto con «value».');
        // La API de riesgo solo acepta referencias opacas `ent_…` en la URL (D-10b): un UPN o una
        // IP se resuelven primero contra el ranking del correlador y las entidades de las alertas.
        let ref = /^ent_[A-Za-z0-9_-]{22}$/u.test(value) ? value : undefined;
        if (!ref) {
          const needle = value.toLocaleLowerCase('es');
          const ranking = await get(`/api/risk/entities?top=100&type=${type}`);
          if ([404, 501, 502, 503].includes(ranking.status)) return unavailable(ENGINE_DOWN);
          if (ranking.status === 200) {
            const hit = rowsOf(ranking.body).find(
              (item) => String(item['label'] ?? '').toLocaleLowerCase('es') === needle,
            );
            if (typeof hit?.['ref'] === 'string') ref = hit['ref'];
          }
          if (!ref) {
            const scan = await scanAlerts(get, {
              entity: value,
              from: new Date(Date.now() - 30 * DAY),
            });
            if (isScan(scan)) {
              for (const alert of scan.matched) {
                const entity = entitiesOf(alert).find(
                  (item) =>
                    item['kind'] === type &&
                    String(item['label'] ?? '').toLocaleLowerCase('es') === needle &&
                    typeof item['ref'] === 'string',
                );
                if (entity) {
                  ref = String(entity['ref']);
                  break;
                }
              }
            }
          }
          if (!ref) {
            return unavailable(
              'El correlador no tiene puntaje de riesgo para esa entidad (no aparece en el ranking ni en alertas de los últimos 30 días). No estimes un riesgo numérico.',
            );
          }
        }
        const response = await get(`/api/risk/entities/${type}/${ref}`);
        if (response.status === 404 || response.status === 403) {
          return unavailable('El correlador no tiene puntaje de riesgo para esa entidad.');
        }
        if ([501, 502, 503].includes(response.status)) return unavailable(ENGINE_DOWN);
        if (response.status !== 200) return failure(response);
        const { correlationId: _omit, ...data } = (response.body ?? {}) as Row;
        const candidates = Array.isArray(data['candidates']) ? (data['candidates'] as Row[]) : [];
        const alertIds = candidates.flatMap((candidate) =>
          Array.isArray(candidate['qapaqAlertIds']) ? (candidate['qapaqAlertIds'] as string[]) : [],
        );
        return {
          ok: true,
          data: withLima({ available: true, ...data }),
          ...(alertIds.length > 0
            ? {
                citations: alertIds.slice(0, 10).map((id) => ({
                  kind: 'alert' as const,
                  id,
                  label: 'Alerta del correlador',
                })),
              }
            : {}),
        };
      }),
    });
  }

  return tools;
}
