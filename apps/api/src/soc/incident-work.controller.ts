/**
 * Sprint 5 · fase 4 — tareas, bitácora y timeline del incidente sobre HTTP.
 *
 * - Leer exige `incidents.read`; crear o mover tareas, `incidents.tasks.write`; escribir en la
 *   bitácora, `incidents.notes.write`. Las mutaciones exigen CSRF (`mutatingActor`) y la
 *   decisión de autorización vive en el caso de uso, como en el resto del SOC.
 * - Inexistente y no autorizado responden igual (`RESOURCE_UNAVAILABLE`): la API no confirma
 *   la existencia de casos ajenos.
 * - El timeline se arma con datos del propio caso (alertas, tareas, notas, apertura y cierre)
 *   y declara de dónde sale cada hora: `provider` es la hora del evento en la fuente y
 *   `recorded`, la hora en que QAPAQ lo registró. Las transiciones intermedias (contener,
 *   erradicar…) salen de la auditoría y solo se incluyen si el lector tiene `audit.read`; si
 *   no, la respuesta lo dice en lugar de omitirlas en silencio.
 */

import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { AUDIT_QUERY_LIMITS, planAuditQuery } from '@qapaq/audit';
import {
  addIncidentNote,
  createIncidentTask,
  executeTaskCommand,
  TASK_COMMANDS,
  type IncidentNote,
  type IncidentTask,
  type TaskCommandName,
} from '@qapaq/soc';

import { ApiError, fromSocFailure } from '../http/api-error.js';
import type { IncomingRequest } from '../http/http-contracts.js';
import { paginate, type PageQuery } from '../http/pagination.js';
import { mutatingActor, readingActor } from './session-actor.js';
import { SECOPS_RUNTIME } from './tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** Alertas vinculadas que entran al timeline (las más recientes). */
const TIMELINE_ALERT_LIMIT = 200;
/** Entradas de auditoría del caso que se consideran para el timeline. */
const TIMELINE_AUDIT_LIMIT = 200;

export function taskView(task: IncidentTask) {
  return {
    id: task.id,
    incidentId: task.incidentId,
    title: task.title,
    description: task.description,
    status: task.status,
    required: task.required,
    assigneeId: task.assigneeId,
    dueAt: task.dueAt?.toISOString() ?? null,
    createdBy: task.createdBy,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    completedAt: task.completedAt?.toISOString() ?? null,
    cancellationReason: task.cancellationReason,
    revision: task.revision,
  };
}

export function noteView(note: IncidentNote) {
  return {
    id: note.id,
    incidentId: note.incidentId,
    authorId: note.authorId,
    body: note.body,
    createdAt: note.createdAt.toISOString(),
    correctsNoteId: note.correctsNoteId,
  };
}

type TimelineKind =
  | 'incident.opened'
  | 'incident.transition'
  | 'incident.closed'
  | 'alert.linked'
  | 'task.created'
  | 'task.completed'
  | 'task.cancelled'
  | 'note.added';

interface TimelineEntry {
  readonly id: string;
  readonly kind: TimelineKind;
  readonly at: Date;
  readonly timeSource: 'provider' | 'recorded';
  /**
   * Hora en que QAPAQ registró la entrada. Igual a `at` salvo en alertas, donde `at` es la hora
   * del evento en la fuente y esta, la de su alta en QAPAQ.
   */
  readonly recordedAt?: Date;
  readonly actorId: string | null;
  readonly summary: string;
  readonly ref: { readonly type: string; readonly id: string };
}

@Controller('api/incidents')
export class IncidentWorkController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  /** Resuelve el lector y el incidente; inexistente y sin permiso se ven igual. */
  private async readable(request: IncomingRequest, incidentId: string) {
    const context = await readingActor(this.runtime, request);
    if (!context.actor.capabilities.has('incidents.read') || !UUID_PATTERN.test(incidentId)) {
      throw new ApiError('RESOURCE_UNAVAILABLE', context.correlationId);
    }
    const incident = await this.runtime.soc.incidentById(context.actor.tenantId, incidentId);
    if (!incident) throw new ApiError('RESOURCE_UNAVAILABLE', context.correlationId);
    return { ...context, incident };
  }

  @Get(':id/tasks')
  public async tasks(
    @Req() request: IncomingRequest,
    @Param('id') id: string,
    @Query() query: PageQuery,
  ) {
    const { actor, correlationId, incident } = await this.readable(request, id);
    const tasks = await this.runtime.soc.listIncidentTasks(actor.tenantId, incident.id);
    const page = paginate(
      tasks,
      (task) => ({ at: task.createdAt.getTime(), id: task.id }),
      query,
      `incident-tasks:${incident.id}`,
      correlationId,
    );
    return {
      correlationId,
      incidentId: incident.id,
      items: page.items.map(taskView),
      nextCursor: page.nextCursor,
      totalCount: tasks.length,
      openRequiredCount: tasks.filter(
        (task) => task.required && (task.status === 'open' || task.status === 'in_progress'),
      ).length,
    };
  }

  @Post(':id/tasks')
  public async createTask(
    @Req() request: IncomingRequest,
    @Param('id') id: string,
    @Body()
    body: {
      title?: unknown;
      description?: unknown;
      required?: unknown;
      assigneeId?: unknown;
      dueAt?: unknown;
    },
  ) {
    const { actor, correlationId } = await mutatingActor(this.runtime, request);
    if (!UUID_PATTERN.test(id)) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    const dueAt = typeof body.dueAt === 'string' ? new Date(body.dueAt) : null;
    if (
      typeof body.title !== 'string' ||
      typeof body.required !== 'boolean' ||
      (body.description !== undefined && typeof body.description !== 'string') ||
      (body.assigneeId !== undefined &&
        body.assigneeId !== null &&
        typeof body.assigneeId !== 'string') ||
      (body.dueAt !== undefined && body.dueAt !== null && typeof body.dueAt !== 'string') ||
      (dueAt !== null && Number.isNaN(dueAt.getTime()))
    ) {
      throw new ApiError('VALIDATION_FAILED', correlationId, [
        'title',
        'required',
        'description',
        'assigneeId',
        'dueAt',
      ]);
    }
    const result = await createIncidentTask(this.runtime.socDependencies(), {
      actor,
      incidentId: id,
      correlationId,
      title: body.title,
      required: body.required,
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(typeof body.assigneeId === 'string' ? { assigneeId: body.assigneeId } : {}),
      ...(dueAt ? { dueAt } : {}),
    });
    if (!result.ok) throw fromSocFailure(result.code, correlationId);
    return { correlationId, task: taskView(result.value) };
  }

  @Post(':id/tasks/:taskId/commands')
  public async taskCommand(
    @Req() request: IncomingRequest,
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body()
    body: { name?: unknown; expectedRevision?: unknown; assigneeId?: unknown; reason?: unknown },
  ) {
    const { actor, correlationId } = await mutatingActor(this.runtime, request);
    if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(taskId)) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    if (
      typeof body.name !== 'string' ||
      !(TASK_COMMANDS as readonly string[]).includes(body.name) ||
      typeof body.expectedRevision !== 'number' ||
      (body.assigneeId !== undefined && typeof body.assigneeId !== 'string') ||
      (body.reason !== undefined && typeof body.reason !== 'string')
    ) {
      throw new ApiError('VALIDATION_FAILED', correlationId, [
        'name',
        'expectedRevision',
        'assigneeId',
        'reason',
      ]);
    }
    const result = await executeTaskCommand(this.runtime.socDependencies(), {
      actor,
      incidentId: id,
      taskId,
      correlationId,
      command: {
        name: body.name as TaskCommandName,
        expectedRevision: body.expectedRevision,
        ...(typeof body.assigneeId === 'string' ? { assigneeId: body.assigneeId } : {}),
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      },
    });
    if (!result.ok) throw fromSocFailure(result.code, correlationId);
    return { correlationId, task: taskView(result.value) };
  }

  @Get(':id/notes')
  public async notes(
    @Req() request: IncomingRequest,
    @Param('id') id: string,
    @Query() query: PageQuery,
  ) {
    const { actor, correlationId, incident } = await this.readable(request, id);
    const notes = await this.runtime.soc.listIncidentNotes(actor.tenantId, incident.id);
    const page = paginate(
      notes,
      (note) => ({ at: note.createdAt.getTime(), id: note.id }),
      query,
      `incident-notes:${incident.id}`,
      correlationId,
    );
    return {
      correlationId,
      incidentId: incident.id,
      items: page.items.map(noteView),
      nextCursor: page.nextCursor,
      totalCount: notes.length,
    };
  }

  @Post(':id/notes')
  public async addNote(
    @Req() request: IncomingRequest,
    @Param('id') id: string,
    @Body() body: { body?: unknown; correctsNoteId?: unknown },
  ) {
    const { actor, correlationId } = await mutatingActor(this.runtime, request);
    if (!UUID_PATTERN.test(id)) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    if (
      typeof body.body !== 'string' ||
      (body.correctsNoteId !== undefined &&
        body.correctsNoteId !== null &&
        (typeof body.correctsNoteId !== 'string' || !UUID_PATTERN.test(body.correctsNoteId)))
    ) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['body', 'correctsNoteId']);
    }
    const result = await addIncidentNote(this.runtime.socDependencies(), {
      actor,
      incidentId: id,
      correlationId,
      body: body.body,
      ...(typeof body.correctsNoteId === 'string' ? { correctsNoteId: body.correctsNoteId } : {}),
    });
    if (!result.ok) throw fromSocFailure(result.code, correlationId);
    return { correlationId, note: noteView(result.value) };
  }

  @Get(':id/timeline')
  public async timeline(
    @Req() request: IncomingRequest,
    @Param('id') id: string,
    @Query() query: PageQuery,
  ) {
    const { actor, correlationId, incident } = await this.readable(request, id);
    const tenantId = actor.tenantId;
    const [tasks, notes, alerts] = await Promise.all([
      this.runtime.soc.listIncidentTasks(tenantId, incident.id),
      this.runtime.soc.listIncidentNotes(tenantId, incident.id),
      actor.capabilities.has('alerts.read')
        ? this.runtime.soc
            .listIncidentAlerts(tenantId, incident.id, TIMELINE_ALERT_LIMIT)
            .then((result) => result.items)
        : Promise.resolve([]),
    ]);
    const entries: TimelineEntry[] = [
      {
        id: `incident:${incident.id}:opened`,
        kind: 'incident.opened',
        at: incident.openedAt,
        timeSource: 'recorded',
        actorId: null,
        summary: incident.title,
        ref: { type: 'incident', id: incident.id },
      },
    ];
    if (incident.closedAt) {
      entries.push({
        id: `incident:${incident.id}:closed`,
        kind: 'incident.closed',
        at: incident.closedAt,
        timeSource: 'recorded',
        actorId: null,
        summary: incident.closureReason ?? '',
        ref: { type: 'incident', id: incident.id },
      });
    }
    for (const alert of alerts) {
      entries.push({
        id: `alert:${alert.id}`,
        kind: 'alert.linked',
        at: alert.occurredAt,
        timeSource: 'provider',
        recordedAt: alert.createdAt,
        actorId: null,
        summary: `${alert.priority} · ${alert.title}`,
        ref: { type: 'alert', id: alert.id },
      });
    }
    for (const task of tasks) {
      entries.push({
        id: `task:${task.id}:created`,
        kind: 'task.created',
        at: task.createdAt,
        timeSource: 'recorded',
        actorId: task.createdBy,
        summary: task.required ? `[obligatoria] ${task.title}` : task.title,
        ref: { type: 'incident_task', id: task.id },
      });
      if (task.status === 'done' && task.completedAt) {
        entries.push({
          id: `task:${task.id}:completed`,
          kind: 'task.completed',
          at: task.completedAt,
          timeSource: 'recorded',
          actorId: task.assigneeId,
          summary: task.title,
          ref: { type: 'incident_task', id: task.id },
        });
      }
      if (task.status === 'cancelled') {
        entries.push({
          id: `task:${task.id}:cancelled`,
          kind: 'task.cancelled',
          at: task.updatedAt,
          timeSource: 'recorded',
          actorId: null,
          summary: task.cancellationReason ?? task.title,
          ref: { type: 'incident_task', id: task.id },
        });
      }
    }
    for (const note of notes) {
      entries.push({
        id: `note:${note.id}`,
        kind: 'note.added',
        at: note.createdAt,
        timeSource: 'recorded',
        actorId: note.authorId,
        summary: note.body.length > 280 ? `${note.body.slice(0, 280)}…` : note.body,
        ref: { type: 'incident_note', id: note.id },
      });
    }
    const transitions = await this.transitions(actor, incident.id, incident.openedAt);
    entries.push(...transitions.entries);

    const page = paginate(
      entries,
      (entry) => ({ at: entry.at.getTime(), id: entry.id }),
      query,
      `incident-timeline:${incident.id}`,
      correlationId,
    );
    return {
      correlationId,
      incidentId: incident.id,
      transitions: transitions.status,
      items: page.items.map((entry) => ({
        ...entry,
        at: entry.at.toISOString(),
        recordedAt: (entry.recordedAt ?? entry.at).toISOString(),
      })),
      nextCursor: page.nextCursor,
      totalCount: entries.length,
    };
  }

  /** Transiciones del caso desde la auditoría; solo para quien puede leerla. */
  private async transitions(
    actor: Awaited<ReturnType<typeof readingActor>>['actor'],
    incidentId: string,
    openedAt: Date,
  ): Promise<{
    readonly status: 'included' | 'partial' | 'requires_audit_read';
    readonly entries: TimelineEntry[];
  }> {
    if (!actor.capabilities.has('audit.read'))
      return { status: 'requires_audit_read', entries: [] };
    // La auditoría se consulta por rango: la vida del caso, recortada al máximo permitido.
    const to = this.runtime.now();
    const earliest = new Date(to.getTime() - AUDIT_QUERY_LIMITS.maximumRangeDays * 86_400_000);
    const from = new Date(Math.max(openedAt.getTime() - 60_000, earliest.getTime()));
    const plan = planAuditQuery(
      {
        from: from.toISOString(),
        to: to.toISOString(),
        resourceType: 'incident',
        resourceId: incidentId,
        pageSize: TIMELINE_AUDIT_LIMIT,
      },
      { tenantId: actor.tenantId, capabilities: actor.capabilities },
    );
    if (!plan.ok) return { status: 'requires_audit_read', entries: [] };
    const page = await this.runtime.audit.read(plan.query);
    const shown = new Set([
      'contain',
      'eradicate',
      'resolve',
      'reopen',
      'reassign',
      'attach_alert',
    ]);
    const entries: TimelineEntry[] = [];
    for (const event of page.events) {
      const command = event.action.replace(/^soc\.incident\./u, '');
      if (event.outcome !== 'succeeded' || !shown.has(command)) continue;
      entries.push({
        id: `audit:${event.id}`,
        kind: 'incident.transition',
        at: event.occurredAt,
        timeSource: 'recorded',
        actorId: event.actor.id,
        summary: command,
        ref: { type: 'audit_event', id: event.id },
      });
    }
    // Un caso más antiguo que el rango o con más transiciones que una página se declara
    // parcial: mejor decirlo que mostrar un historial incompleto como si fuera todo.
    const truncated = from.getTime() > openedAt.getTime() - 60_000 || page.nextCursor !== null;
    return { status: truncated ? 'partial' : 'included', entries };
  }
}
