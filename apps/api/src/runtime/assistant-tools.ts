/**
 * Asistente Claude — herramientas de solo lectura.
 *
 * El modelo no consulta nada por su cuenta: pide una herramienta y el núcleo la ejecuta con el
 * actor de la sesión. Cada herramienta vuelve a exigir la misma capability que el endpoint HTTP
 * equivalente y filtra por el tenant del actor, de modo que el asistente nunca ve más que la
 * persona que conversa. La lista que se ofrece al modelo ya omite lo que el actor no puede usar;
 * la comprobación al ejecutar es la que cuenta (el modelo podría pedir una herramienta que no se
 * le ofreció).
 *
 * Todo lo que sale de aquí pasa por la seudonimización de la conversación: entidades por su
 * referencia `ent_…`, personas del SOC por referencia y texto libre depurado. Ninguna herramienta
 * escribe: no hay comandos de alerta, incidente ni notificación.
 */

import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Actor, Capability } from '@qapaq/access';
import {
  ALERT_STATUSES,
  INCIDENT_STATUSES,
  type Alert,
  type Incident,
  type IncidentNote,
  type SocReadModel,
} from '@qapaq/soc';

import { ENTITY_REF_PATTERN } from './entity-refs.js';
import type { ConversationPseudonymizer } from './assistant-pseudonymizer.js';

/** Tope de alertas por consulta: el contexto del modelo no es un listado de exportación. */
const LIST_LIMIT_MAX = 20;
const LIST_LIMIT_DEFAULT = 10;
/** Entradas de bitácora que se entregan (las más recientes). */
const NOTE_LIMIT = 30;
/** Alertas relacionadas que se enumeran por alerta. */
const RELATED_LIMIT = 20;
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/u;
const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
const ACTIVE_INCIDENT_STATUSES = INCIDENT_STATUSES.filter(
  (status) => status !== 'resolved' && status !== 'closed',
);

export interface AssistantToolContext {
  readonly actor: Actor;
  readonly soc: SocReadModel;
  readonly pseudonymizer: ConversationPseudonymizer;
}

export type AssistantToolResult =
  | { readonly ok: true; readonly content: unknown }
  | { readonly ok: false; readonly code: 'RESOURCE_UNAVAILABLE' | 'VALIDATION_FAILED' };

interface AssistantTool {
  /** Basta con una de estas capabilities; la herramienta recorta lo demás. */
  readonly requires: readonly Capability[];
  readonly definition: BetaTool;
  run(input: Record<string, unknown>, context: AssistantToolContext): Promise<AssistantToolResult>;
}

const unavailable = { ok: false, code: 'RESOURCE_UNAVAILABLE' } as const;
const invalid = { ok: false, code: 'VALIDATION_FAILED' } as const;

function limitOf(value: unknown): number | undefined {
  if (value === undefined) return LIST_LIMIT_DEFAULT;
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= LIST_LIMIT_MAX
    ? value
    : undefined;
}

function alertSummary(alert: Alert, pseudonymizer: ConversationPseudonymizer) {
  // Primero las entidades: así el título se depura con sus valores ya conocidos.
  const entities = alert.entityKeys.map((key, index) =>
    pseudonymizer.entity(key, alert.entityRefs[index] ?? null),
  );
  return {
    id: alert.id,
    title: pseudonymizer.scrub(alert.title),
    priority: alert.priority,
    score: alert.score,
    status: alert.status,
    occurredAt: alert.occurredAt.toISOString(),
    incidentId: alert.incidentId,
    entities,
  };
}

function alertDetail(alert: Alert, pseudonymizer: ConversationPseudonymizer) {
  return {
    ...alertSummary(alert, pseudonymizer),
    verdict: alert.verdict,
    assignee: pseudonymizer.actor(alert.assigneeId),
    signal: alert.signal,
    reasons: alert.reasons.map((reason) => ({
      code: reason.code,
      detail: pseudonymizer.scrub(reason.detail),
    })),
    relatedAlertIds: alert.relatedAlertIds.slice(0, RELATED_LIMIT),
  };
}

function incidentDetail(incident: Incident, pseudonymizer: ConversationPseudonymizer) {
  return {
    id: incident.id,
    title: pseudonymizer.scrub(incident.title),
    severity: incident.severity,
    status: incident.status,
    owner: pseudonymizer.actor(incident.ownerId),
    alertIds: incident.alertIds.slice(0, RELATED_LIMIT),
    alertCount: incident.alertIds.length,
    summary: pseudonymizer.scrub(incident.summary),
    openedAt: incident.openedAt.toISOString(),
    closedAt: incident.closedAt?.toISOString() ?? null,
  };
}

function noteEntry(note: IncidentNote, pseudonymizer: ConversationPseudonymizer) {
  return {
    id: note.id,
    author: pseudonymizer.actor(note.authorId),
    createdAt: note.createdAt.toISOString(),
    correctsNoteId: note.correctsNoteId,
    body: pseudonymizer.scrub(note.body),
  };
}

const TOOLS: Readonly<Record<string, AssistantTool>> = {
  list_alerts: {
    requires: ['alerts.read'],
    definition: {
      name: 'list_alerts',
      description:
        'Lista alertas de la cola QAPAQ del tenant, de la más reciente a la más antigua. ' +
        'Devuelve el total y hasta `limit` alertas con prioridad, estado y entidades ' +
        '(como referencias ent_…). Úsala para responder sobre la cola o buscar candidatas.',
      input_schema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['open', ...ALERT_STATUSES],
            description: '`open` = todo lo no cerrado (por defecto).',
          },
          priority: { type: 'string', enum: [...PRIORITIES] },
          limit: { type: 'integer', minimum: 1, maximum: LIST_LIMIT_MAX },
        },
        additionalProperties: false,
      },
    },
    async run(input, { actor, soc, pseudonymizer }) {
      const status = input['status'] ?? 'open';
      const priority = input['priority'];
      const limit = limitOf(input['limit']);
      if (
        typeof status !== 'string' ||
        !['open', ...ALERT_STATUSES].includes(status) ||
        (priority !== undefined && !PRIORITIES.includes(priority as never)) ||
        limit === undefined
      ) {
        return invalid;
      }
      const result = await soc.listAlerts({
        tenantId: actor.tenantId,
        status: status as Alert['status'] | 'open',
        ...(priority ? { priority: priority as Alert['priority'] } : {}),
      });
      return {
        ok: true,
        content: {
          total: result.total,
          items: result.items.slice(0, limit).map((alert) => alertSummary(alert, pseudonymizer)),
        },
      };
    },
  },
  get_alert: {
    requires: ['alerts.read'],
    definition: {
      name: 'get_alert',
      description:
        'Detalle de una alerta por su id: motivos de la priorización, señal, veredicto, ' +
        'entidades (ent_…), alertas relacionadas e incidente vinculado.',
      input_schema: {
        type: 'object',
        properties: { alert_id: { type: 'string' } },
        required: ['alert_id'],
        additionalProperties: false,
      },
    },
    async run(input, { actor, soc, pseudonymizer }) {
      const id = input['alert_id'];
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) return invalid;
      const alert = await soc.alertById(actor.tenantId, id);
      // Inexistente y ajena se ven igual, como en `GET /api/alerts/:id`.
      if (!alert) return unavailable;
      return { ok: true, content: alertDetail(alert, pseudonymizer) };
    },
  },
  related_alerts_by_entity: {
    requires: ['alerts.read'],
    definition: {
      name: 'related_alerts_by_entity',
      description:
        'Alertas del tenant que involucran una entidad, identificada por su referencia ent_… ' +
        '(la que aparece en `entities[].ref`). Sirve para ver la historia de un usuario o una IP.',
      input_schema: {
        type: 'object',
        properties: {
          entity_ref: { type: 'string', pattern: '^ent_[A-Za-z0-9_-]{22}$' },
          limit: { type: 'integer', minimum: 1, maximum: LIST_LIMIT_MAX },
        },
        required: ['entity_ref'],
        additionalProperties: false,
      },
    },
    async run(input, { actor, soc, pseudonymizer }) {
      const ref = input['entity_ref'];
      const limit = limitOf(input['limit']);
      if (typeof ref !== 'string' || !ENTITY_REF_PATTERN.test(ref) || limit === undefined) {
        return invalid;
      }
      const result = await soc.listAlerts({ tenantId: actor.tenantId, entityRef: ref });
      return {
        ok: true,
        content: {
          entityRef: ref,
          total: result.total,
          items: result.items.slice(0, limit).map((alert) => alertSummary(alert, pseudonymizer)),
        },
      };
    },
  },
  soc_summary: {
    requires: ['alerts.read', 'incidents.read'],
    definition: {
      name: 'soc_summary',
      description:
        'Resumen del SOC: alertas abiertas por prioridad e incidentes activos por severidad. ' +
        'Si falta alguna sección, la cuenta no tiene permiso para leerla.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run(_input, { actor, soc }) {
      const tenantId = actor.tenantId;
      const content: Record<string, unknown> = {};
      if (actor.capabilities.has('alerts.read')) {
        const [open, ...byPriority] = await Promise.all([
          soc.listAlerts({ tenantId, status: 'open' }),
          ...PRIORITIES.map((priority) => soc.listAlerts({ tenantId, status: 'open', priority })),
        ]);
        content['openAlerts'] = {
          total: open!.total,
          byPriority: Object.fromEntries(
            PRIORITIES.map((priority, index) => [priority, byPriority[index]!.total]),
          ),
        };
      }
      if (actor.capabilities.has('incidents.read')) {
        const active = await soc.listIncidents({ tenantId, statuses: ACTIVE_INCIDENT_STATUSES });
        const bySeverity: Record<string, number> = {};
        for (const incident of active.items) {
          bySeverity[incident.severity] = (bySeverity[incident.severity] ?? 0) + 1;
        }
        content['activeIncidents'] = {
          total: active.total,
          bySeverity,
          // El adapter puede recortar filas; el total sí es exacto.
          bySeverityComplete: active.items.length === active.total,
        };
      }
      return { ok: true, content };
    },
  },
  incident_log: {
    requires: ['incidents.read'],
    definition: {
      name: 'incident_log',
      description:
        'Incidente por su id con su bitácora append-only (las entradas más recientes primero). ' +
        'Autores y dueño aparecen como referencias, no como personas.',
      input_schema: {
        type: 'object',
        properties: { incident_id: { type: 'string' } },
        required: ['incident_id'],
        additionalProperties: false,
      },
    },
    async run(input, { actor, soc, pseudonymizer }) {
      const id = input['incident_id'];
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) return invalid;
      const incident = await soc.incidentById(actor.tenantId, id);
      if (!incident) return unavailable;
      const notes = await soc.listIncidentNotes(actor.tenantId, incident.id);
      const recent = [...notes]
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .slice(0, NOTE_LIMIT);
      return {
        ok: true,
        content: {
          incident: incidentDetail(incident, pseudonymizer),
          notes: recent.map((note) => noteEntry(note, pseudonymizer)),
          totalNotes: notes.length,
        },
      };
    },
  },
};

function allowed(tool: AssistantTool, actor: Actor): boolean {
  return tool.requires.some((capability) => actor.capabilities.has(capability));
}

/** Definiciones que se ofrecen al modelo: solo las que el actor puede ejecutar, en orden fijo. */
export function assistantToolsFor(actor: Actor): BetaTool[] {
  return Object.values(TOOLS)
    .filter((tool) => allowed(tool, actor))
    .map((tool) => tool.definition);
}

export const ASSISTANT_TOOL_NAMES = Object.freeze(Object.keys(TOOLS));

/** Ejecuta una herramienta pedida por el modelo. La autorización se decide aquí, no en la lista. */
export async function runAssistantTool(
  name: string,
  input: unknown,
  context: AssistantToolContext,
): Promise<AssistantToolResult> {
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
  if (!tool || !allowed(tool, context.actor)) return unavailable;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid;
  const record = input as Record<string, unknown>;
  const declared = Object.keys(tool.definition.input_schema.properties ?? {});
  if (Object.keys(record).some((key) => !declared.includes(key))) return invalid;
  return tool.run(record, context);
}
