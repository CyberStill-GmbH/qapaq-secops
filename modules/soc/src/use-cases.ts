/**
 * C-17 — casos de uso del SOC.
 *
 * Cada caso de uso hace lo mismo y en el mismo orden: autoriza, transiciona el estado,
 * sella auditoría y encola el hecho; todo dentro de una transacción. El orden importa.
 * Autorizar al final permitiría que una denegación dejara trabajo a medias, y auditar
 * fuera de la transacción produciría dos verdades distintas sobre lo que pasó.
 *
 * La denegación también se audita. Un intento rechazado es justamente lo que un
 * auditor necesita ver.
 */

import { authorize, type Actor } from '@qapaq/access';
import { recordAudit, type AuditEventDraft } from '@qapaq/audit';
import type { DetectionCandidate } from '@qapaq/detection';

import {
  applyAlertCommand,
  createAlert,
  linkAlertToIncident,
  type Alert,
  type AlertCommand,
  type AlertErrorCode,
  type TriageVerdict,
} from './alert.js';
import {
  applyIncidentCommand,
  openIncident,
  type Incident,
  type IncidentCommand,
  type IncidentErrorCode,
  type IncidentSeverity,
} from './incident.js';
import {
  applyTaskCommand,
  blocksClosure,
  createNote,
  createTask,
  type IncidentNote,
  type IncidentTask,
  type TaskCommand,
  type TaskErrorCode,
} from './incident-work.js';
import { alertEvent, incidentEvent, toOutboxMessage, type SocDomainEvent } from './events.js';
import type { SocTransactionContext, SocUnitOfWork } from './ports.js';

export const SOC_FAILURE_CODES = ['FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'INVALID_COMMAND'] as const;
export type SocFailureCode = (typeof SOC_FAILURE_CODES)[number];

export type SocResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: SocFailureCode;
      readonly reason: string;
      readonly detail: string;
    };

export interface SocClock {
  now(): Date;
}

export interface IdFactory {
  next(): string;
}

function failure(code: SocFailureCode, reason: string, detail: string): SocResult<never> {
  return { ok: false, code, reason, detail };
}

function mapTransitionCode(
  code: AlertErrorCode | IncidentErrorCode | TaskErrorCode,
): SocFailureCode {
  return code === 'REVISION_STALE' ? 'CONFLICT' : 'INVALID_COMMAND';
}

interface AuditInput {
  readonly actor: Actor;
  readonly action: string;
  readonly resource: { readonly type: string; readonly id: string };
  readonly outcome: AuditEventDraft['outcome'];
  readonly correlationId: string;
  readonly at: Date;
  readonly id: string;
  readonly reason?: string;
  readonly metadata?: AuditEventDraft['metadata'];
}

function auditDraft(input: AuditInput): AuditEventDraft {
  return {
    id: input.id,
    tenantId: input.actor.tenantId,
    occurredAt: input.at,
    actor: { id: input.actor.subjectId, type: 'user', sessionId: input.actor.sessionId },
    action: input.action,
    resource: input.resource,
    outcome: input.outcome,
    correlationId: input.correlationId,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  };
}

async function publish(
  context: SocTransactionContext,
  events: readonly SocDomainEvent[],
  ids: IdFactory,
): Promise<void> {
  for (const event of events) {
    await context.outbox.enqueueIfAbsent(toOutboxMessage(event, ids.next()));
  }
}

/**
 * Deriva la referencia opaca de una clave de entidad (D-10b). La implementa el composition
 * root con un HMAC por tenant; el dominio no conoce la clave.
 */
export type EntityRefFactory = (tenantId: string, entityKey: string) => string;

export interface SocDependencies {
  readonly unitOfWork: SocUnitOfWork;
  readonly clock: SocClock;
  readonly ids: IdFactory;
  /** Sin factory, la alerta no tiene referencias y no se puede pivotar por entidad. */
  readonly entityRefs?: EntityRefFactory;
}

/** Materializa un candidato de C-16 como alerta. Repetirlo no crea una segunda. */
export async function ingestCandidate(
  dependencies: SocDependencies,
  candidate: DetectionCandidate,
  systemActorId = 'system:detection',
): Promise<SocResult<{ readonly alert: Alert; readonly created: boolean }>> {
  const at = dependencies.clock.now();
  return dependencies.unitOfWork.run(async (context) => {
    // El candidato se persiste primero: es la evidencia de por qué existe la alerta y su
    // unicidad por clave de idempotencia es la segunda barrera contra duplicados.
    await context.candidates.insertIfAbsent(candidate);
    const alert = createAlert({
      id: candidate.id,
      tenantId: candidate.tenantId,
      candidateId: candidate.id,
      eventRecordId: candidate.eventRecordId,
      title: candidate.title,
      priority: candidate.priority,
      score: candidate.score,
      reasons: candidate.reasons,
      occurredAt: candidate.occurredAt,
      createdAt: at,
      entityKeys: candidate.entityKeys,
      entityRefs: dependencies.entityRefs
        ? candidate.entityKeys.map((key) => dependencies.entityRefs!(candidate.tenantId, key))
        : [],
      signal: candidate.signal,
      ruleId: candidate.ruleId,
      relatedAlertIds: candidate.relatedAlertIds,
    });
    const created = await context.alerts.insertIfAbsent(alert);
    if (!created) {
      const existing = await context.alerts.byId(candidate.tenantId, candidate.id);
      return existing
        ? { ok: true as const, value: { alert: existing, created: false } }
        : failure('CONFLICT', 'ALERT_RACE', 'La alerta existía y dejó de estar disponible.');
    }
    await recordAudit(
      context.audit,
      auditDraft({
        id: dependencies.ids.next(),
        actor: {
          subjectId: systemActorId,
          tenantId: candidate.tenantId,
          sessionId: 'system',
          capabilities: new Set(),
          roles: [],
        },
        action: 'soc.alert.created',
        resource: { type: 'alert', id: alert.id },
        outcome: 'succeeded',
        correlationId: candidate.idempotencyKey,
        at,
        metadata: {
          priority: alert.priority,
          score: alert.score,
          signal: alert.signal,
          relatedAlerts: alert.relatedAlertIds.length,
        },
      }),
    );
    await publish(
      context,
      [
        alertEvent({
          type: 'soc.alert.created',
          tenantId: alert.tenantId,
          alertId: alert.id,
          actorId: systemActorId,
          at,
          priority: alert.priority,
          status: alert.status,
          title: alert.title,
        }),
      ],
      dependencies.ids,
    );
    return { ok: true as const, value: { alert, created: true } };
  });
}

export interface AlertCommandRequest {
  readonly actor: Actor;
  readonly alertId: string;
  readonly correlationId: string;
  readonly command: Omit<AlertCommand, 'actorId' | 'at'>;
}

const COMMAND_CAPABILITY = {
  acknowledge: 'alerts.triage',
  assign: 'alerts.assign',
  triage: 'alerts.triage',
  escalate: 'alerts.triage',
  close: 'alerts.triage',
  reopen: 'alerts.triage',
} as const;

export async function executeAlertCommand(
  dependencies: SocDependencies,
  request: AlertCommandRequest,
): Promise<SocResult<Alert>> {
  const at = dependencies.clock.now();
  return dependencies.unitOfWork.run(async (context) => {
    const alert = await context.alerts.byId(request.actor.tenantId, request.alertId);
    const decision = authorize({
      actor: request.actor,
      capability: COMMAND_CAPABILITY[request.command.name],
      resource: {
        type: 'alert',
        id: request.alertId,
        // Un recurso ausente se evalúa con el tenant del actor: así una denegación por
        // permisos y una por inexistencia no se distinguen desde fuera.
        tenantId: alert?.tenantId ?? request.actor.tenantId,
        assigneeId: alert?.assigneeId ?? null,
        closed: alert?.status === 'closed',
      },
      requiresAssignment: request.command.name === 'triage',
    });
    if (!decision.allowed) {
      await recordAudit(
        context.audit,
        auditDraft({
          id: dependencies.ids.next(),
          actor: request.actor,
          action: `soc.alert.${request.command.name}`,
          resource: { type: 'alert', id: request.alertId },
          outcome: 'denied',
          correlationId: request.correlationId,
          at,
          reason: decision.reason,
          metadata: { detail: decision.detail },
        }),
      );
      return failure('FORBIDDEN', decision.reason, decision.detail);
    }
    if (!alert) return failure('NOT_FOUND', 'ALERT_NOT_FOUND', 'La alerta no existe.');

    const transition = applyAlertCommand(alert, {
      ...request.command,
      actorId: request.actor.subjectId,
      at,
    });
    if (!transition.ok) {
      await recordAudit(
        context.audit,
        auditDraft({
          id: dependencies.ids.next(),
          actor: request.actor,
          action: `soc.alert.${request.command.name}`,
          resource: { type: 'alert', id: alert.id },
          outcome: 'failed',
          correlationId: request.correlationId,
          at,
          reason: transition.code,
          metadata: { detail: transition.detail, status: alert.status },
        }),
      );
      return failure(mapTransitionCode(transition.code), transition.code, transition.detail);
    }
    if (!(await context.alerts.update(transition.alert, alert.revision))) {
      return failure('CONFLICT', 'REVISION_STALE', 'Otra escritura modificó la alerta.');
    }
    await recordAudit(
      context.audit,
      auditDraft({
        id: dependencies.ids.next(),
        actor: request.actor,
        action: `soc.alert.${request.command.name}`,
        resource: { type: 'alert', id: alert.id },
        outcome: 'succeeded',
        correlationId: request.correlationId,
        at,
        metadata: {
          from: transition.from,
          to: transition.alert.status,
          verdict: transition.alert.verdict,
        },
      }),
    );
    const type =
      request.command.name === 'triage'
        ? 'soc.alert.triaged'
        : request.command.name === 'escalate'
          ? 'soc.alert.escalated'
          : request.command.name === 'close'
            ? 'soc.alert.closed'
            : undefined;
    if (type) {
      await publish(
        context,
        [
          alertEvent({
            type,
            tenantId: alert.tenantId,
            alertId: alert.id,
            actorId: request.actor.subjectId,
            at,
            priority: transition.alert.priority,
            status: transition.alert.status,
            title: transition.alert.title,
            verdict: transition.alert.verdict,
            incidentId: transition.alert.incidentId,
          }),
        ],
        dependencies.ids,
      );
    }
    return { ok: true as const, value: transition.alert };
  });
}

export interface OpenIncidentRequest {
  readonly actor: Actor;
  readonly alertId: string;
  readonly title: string;
  readonly severity: IncidentSeverity;
  readonly summary: string;
  readonly correlationId: string;
  readonly expectedAlertRevision: number;
}

export async function openIncidentFromAlert(
  dependencies: SocDependencies,
  request: OpenIncidentRequest,
): Promise<SocResult<Incident>> {
  const at = dependencies.clock.now();
  return dependencies.unitOfWork.run(async (context) => {
    const alert = await context.alerts.byId(request.actor.tenantId, request.alertId);
    const decision = authorize({
      actor: request.actor,
      capability: 'incidents.write',
      resource: {
        type: 'alert',
        id: request.alertId,
        tenantId: alert?.tenantId ?? request.actor.tenantId,
      },
    });
    if (!decision.allowed) {
      await recordAudit(
        context.audit,
        auditDraft({
          id: dependencies.ids.next(),
          actor: request.actor,
          action: 'soc.incident.open',
          resource: { type: 'alert', id: request.alertId },
          outcome: 'denied',
          correlationId: request.correlationId,
          at,
          reason: decision.reason,
        }),
      );
      return failure('FORBIDDEN', decision.reason, decision.detail);
    }
    if (!alert) return failure('NOT_FOUND', 'ALERT_NOT_FOUND', 'La alerta no existe.');
    if (alert.revision !== request.expectedAlertRevision) {
      return failure('CONFLICT', 'REVISION_STALE', 'La alerta cambió mientras se abría el caso.');
    }
    if (alert.incidentId) {
      return failure('CONFLICT', 'ALERT_ALREADY_LINKED', 'La alerta ya pertenece a un caso.');
    }
    const incident = openIncident({
      id: dependencies.ids.next(),
      tenantId: alert.tenantId,
      title: request.title,
      severity: request.severity,
      ownerId: request.actor.subjectId,
      summary: request.summary,
      alertIds: [alert.id],
      openedAt: at,
    });
    await context.incidents.insert(incident);
    if (
      !(await context.alerts.update(linkAlertToIncident(alert, incident.id, at), alert.revision))
    ) {
      return failure('CONFLICT', 'REVISION_STALE', 'Otra escritura modificó la alerta.');
    }
    await recordAudit(
      context.audit,
      auditDraft({
        id: dependencies.ids.next(),
        actor: request.actor,
        action: 'soc.incident.open',
        resource: { type: 'incident', id: incident.id },
        outcome: 'succeeded',
        correlationId: request.correlationId,
        at,
        metadata: { severity: incident.severity, alertId: alert.id },
      }),
    );
    await publish(
      context,
      [
        incidentEvent({
          type: 'soc.incident.opened',
          tenantId: incident.tenantId,
          incidentId: incident.id,
          actorId: request.actor.subjectId,
          at,
          severity: incident.severity,
          status: incident.status,
          title: incident.title,
          alertCount: incident.alertIds.length,
        }),
      ],
      dependencies.ids,
    );
    return { ok: true as const, value: incident };
  });
}

export interface IncidentCommandRequest {
  readonly actor: Actor;
  readonly incidentId: string;
  readonly correlationId: string;
  readonly command: Omit<
    IncidentCommand,
    'actorId' | 'at' | 'untriagedAlertIds' | 'openRequiredTaskIds'
  >;
}

export async function executeIncidentCommand(
  dependencies: SocDependencies,
  request: IncidentCommandRequest,
): Promise<SocResult<Incident>> {
  const at = dependencies.clock.now();
  return dependencies.unitOfWork.run(async (context) => {
    const incident = await context.incidents.byId(request.actor.tenantId, request.incidentId);
    const decision = authorize({
      actor: request.actor,
      capability: request.command.name === 'close' ? 'incidents.close' : 'incidents.write',
      resource: {
        type: 'incident',
        id: request.incidentId,
        tenantId: incident?.tenantId ?? request.actor.tenantId,
        closed: incident?.status === 'closed',
      },
      rejectWhenClosed: request.command.name !== 'reopen',
    });
    if (!decision.allowed) {
      await recordAudit(
        context.audit,
        auditDraft({
          id: dependencies.ids.next(),
          actor: request.actor,
          action: `soc.incident.${request.command.name}`,
          resource: { type: 'incident', id: request.incidentId },
          outcome: 'denied',
          correlationId: request.correlationId,
          at,
          reason: decision.reason,
        }),
      );
      return failure('FORBIDDEN', decision.reason, decision.detail);
    }
    if (!incident) return failure('NOT_FOUND', 'INCIDENT_NOT_FOUND', 'El caso no existe.');

    const linked = await context.alerts.byIncident(incident.tenantId, incident.id);
    const tasks =
      request.command.name === 'close'
        ? await context.tasks.byIncident(incident.tenantId, incident.id)
        : [];
    const transition = applyIncidentCommand(incident, {
      ...request.command,
      actorId: request.actor.subjectId,
      at,
      untriagedAlertIds: linked.filter((alert) => alert.verdict === null).map((alert) => alert.id),
      openRequiredTaskIds: tasks.filter(blocksClosure).map((task) => task.id),
    });
    if (!transition.ok) {
      await recordAudit(
        context.audit,
        auditDraft({
          id: dependencies.ids.next(),
          actor: request.actor,
          action: `soc.incident.${request.command.name}`,
          resource: { type: 'incident', id: incident.id },
          outcome: 'failed',
          correlationId: request.correlationId,
          at,
          reason: transition.code,
          metadata: { detail: transition.detail },
        }),
      );
      return failure(mapTransitionCode(transition.code), transition.code, transition.detail);
    }
    if (!(await context.incidents.update(transition.incident, incident.revision))) {
      return failure('CONFLICT', 'REVISION_STALE', 'Otra escritura modificó el caso.');
    }
    await recordAudit(
      context.audit,
      auditDraft({
        id: dependencies.ids.next(),
        actor: request.actor,
        action: `soc.incident.${request.command.name}`,
        resource: { type: 'incident', id: incident.id },
        outcome: 'succeeded',
        correlationId: request.correlationId,
        at,
        metadata: { from: transition.from, to: transition.incident.status },
      }),
    );
    await publish(
      context,
      [
        incidentEvent({
          type:
            request.command.name === 'close'
              ? 'soc.incident.closed'
              : 'soc.incident.status_changed',
          tenantId: incident.tenantId,
          incidentId: incident.id,
          actorId: request.actor.subjectId,
          at,
          severity: transition.incident.severity,
          status: transition.incident.status,
          title: transition.incident.title,
          alertCount: transition.incident.alertIds.length,
        }),
      ],
      dependencies.ids,
    );
    return { ok: true as const, value: transition.incident };
  });
}

export type { TriageVerdict };

/* ------------------------------------------------- Trabajo del incidente (S5-D8) */

interface IncidentWorkScope {
  readonly actor: Actor;
  readonly incidentId: string;
  readonly correlationId: string;
}

/**
 * Autoriza y carga el incidente para una operación de tareas o notas. Un incidente cerrado
 * no admite trabajo nuevo: primero se reabre, y eso queda auditado. El rechazo por permiso
 * se audita como `denied`; hacia afuera, el inexistente responde igual.
 */
async function incidentForWork(
  dependencies: SocDependencies,
  context: SocTransactionContext,
  scope: IncidentWorkScope,
  capability: 'incidents.tasks.write' | 'incidents.notes.write',
  action: string,
  at: Date,
): Promise<SocResult<Incident>> {
  const incident = await context.incidents.byId(scope.actor.tenantId, scope.incidentId);
  const decision = authorize({
    actor: scope.actor,
    capability,
    resource: {
      type: 'incident',
      id: scope.incidentId,
      tenantId: incident?.tenantId ?? scope.actor.tenantId,
      closed: incident?.status === 'closed',
    },
    rejectWhenClosed: true,
  });
  if (!decision.allowed) {
    await recordAudit(
      context.audit,
      auditDraft({
        id: dependencies.ids.next(),
        actor: scope.actor,
        action,
        resource: { type: 'incident', id: scope.incidentId },
        outcome: 'denied',
        correlationId: scope.correlationId,
        at,
        reason: decision.reason,
      }),
    );
    return failure('FORBIDDEN', decision.reason, decision.detail);
  }
  if (!incident) return failure('NOT_FOUND', 'INCIDENT_NOT_FOUND', 'El caso no existe.');
  return { ok: true, value: incident };
}

async function auditWorkFailure(
  dependencies: SocDependencies,
  context: SocTransactionContext,
  scope: IncidentWorkScope,
  action: string,
  resource: { readonly type: string; readonly id: string },
  at: Date,
  code: TaskErrorCode,
  detail: string,
): Promise<SocResult<never>> {
  await recordAudit(
    context.audit,
    auditDraft({
      id: dependencies.ids.next(),
      actor: scope.actor,
      action,
      resource,
      outcome: 'failed',
      correlationId: scope.correlationId,
      at,
      reason: code,
      metadata: { detail, incidentId: scope.incidentId },
    }),
  );
  return failure(mapTransitionCode(code), code, detail);
}

export interface CreateTaskRequest extends IncidentWorkScope {
  readonly title: string;
  readonly description?: string;
  readonly required: boolean;
  readonly assigneeId?: string | null;
  readonly dueAt?: Date | null;
}

export async function createIncidentTask(
  dependencies: SocDependencies,
  request: CreateTaskRequest,
): Promise<SocResult<IncidentTask>> {
  const at = dependencies.clock.now();
  const action = 'soc.incident.task.created';
  return dependencies.unitOfWork.run(async (context) => {
    const loaded = await incidentForWork(
      dependencies,
      context,
      request,
      'incidents.tasks.write',
      action,
      at,
    );
    if (!loaded.ok) return loaded;
    const created = createTask({
      id: dependencies.ids.next(),
      tenantId: loaded.value.tenantId,
      incidentId: loaded.value.id,
      title: request.title,
      ...(request.description === undefined ? {} : { description: request.description }),
      required: request.required,
      ...(request.assigneeId === undefined ? {} : { assigneeId: request.assigneeId }),
      ...(request.dueAt === undefined ? {} : { dueAt: request.dueAt }),
      createdBy: request.actor.subjectId,
      at,
    });
    if (!created.ok) {
      return auditWorkFailure(
        dependencies,
        context,
        request,
        action,
        { type: 'incident', id: loaded.value.id },
        at,
        created.code,
        created.detail,
      );
    }
    await context.tasks.insert(created.value);
    await recordAudit(
      context.audit,
      auditDraft({
        id: dependencies.ids.next(),
        actor: request.actor,
        action,
        resource: { type: 'incident_task', id: created.value.id },
        outcome: 'succeeded',
        correlationId: request.correlationId,
        at,
        metadata: { incidentId: loaded.value.id, required: created.value.required },
      }),
    );
    return { ok: true as const, value: created.value };
  });
}

export interface TaskCommandRequest extends IncidentWorkScope {
  readonly taskId: string;
  readonly command: Omit<TaskCommand, 'at'>;
}

export async function executeTaskCommand(
  dependencies: SocDependencies,
  request: TaskCommandRequest,
): Promise<SocResult<IncidentTask>> {
  const at = dependencies.clock.now();
  const action = `soc.incident.task.${request.command.name}`;
  return dependencies.unitOfWork.run(async (context) => {
    const loaded = await incidentForWork(
      dependencies,
      context,
      request,
      'incidents.tasks.write',
      action,
      at,
    );
    if (!loaded.ok) return loaded;
    const task = await context.tasks.byId(loaded.value.tenantId, request.taskId);
    if (!task || task.incidentId !== loaded.value.id) {
      return failure('NOT_FOUND', 'TASK_NOT_FOUND', 'La tarea no existe en este caso.');
    }
    const transition = applyTaskCommand(task, { ...request.command, at });
    if (!transition.ok) {
      return auditWorkFailure(
        dependencies,
        context,
        request,
        action,
        { type: 'incident_task', id: task.id },
        at,
        transition.code,
        transition.detail,
      );
    }
    if (!(await context.tasks.update(transition.value, task.revision))) {
      return failure('CONFLICT', 'REVISION_STALE', 'Otra escritura modificó la tarea.');
    }
    const reason = request.command.reason?.trim();
    await recordAudit(
      context.audit,
      auditDraft({
        id: dependencies.ids.next(),
        actor: request.actor,
        action,
        resource: { type: 'incident_task', id: task.id },
        outcome: 'succeeded',
        correlationId: request.correlationId,
        at,
        ...(reason ? { reason } : {}),
        metadata: { incidentId: loaded.value.id, from: task.status, to: transition.value.status },
      }),
    );
    return { ok: true as const, value: transition.value };
  });
}

export interface AddNoteRequest extends IncidentWorkScope {
  readonly body: string;
  readonly correctsNoteId?: string | null;
}

export async function addIncidentNote(
  dependencies: SocDependencies,
  request: AddNoteRequest,
): Promise<SocResult<IncidentNote>> {
  const at = dependencies.clock.now();
  const action = 'soc.incident.note.added';
  return dependencies.unitOfWork.run(async (context) => {
    const loaded = await incidentForWork(
      dependencies,
      context,
      request,
      'incidents.notes.write',
      action,
      at,
    );
    if (!loaded.ok) return loaded;
    if (request.correctsNoteId) {
      const corrected = await context.notes.byId(loaded.value.tenantId, request.correctsNoteId);
      if (!corrected || corrected.incidentId !== loaded.value.id) {
        return failure('NOT_FOUND', 'NOTE_NOT_FOUND', 'La nota a corregir no existe en este caso.');
      }
    }
    const created = createNote({
      id: dependencies.ids.next(),
      tenantId: loaded.value.tenantId,
      incidentId: loaded.value.id,
      authorId: request.actor.subjectId,
      body: request.body,
      correctsNoteId: request.correctsNoteId ?? null,
      at,
    });
    if (!created.ok) {
      return auditWorkFailure(
        dependencies,
        context,
        request,
        action,
        { type: 'incident', id: loaded.value.id },
        at,
        created.code,
        created.detail,
      );
    }
    await context.notes.insert(created.value);
    // La auditoría registra que hubo nota y qué corrige; el cuerpo vive solo en la bitácora.
    await recordAudit(
      context.audit,
      auditDraft({
        id: dependencies.ids.next(),
        actor: request.actor,
        action,
        resource: { type: 'incident_note', id: created.value.id },
        outcome: 'succeeded',
        correlationId: request.correlationId,
        at,
        metadata: {
          incidentId: loaded.value.id,
          ...(created.value.correctsNoteId ? { correctsNoteId: created.value.correctsNoteId } : {}),
        },
      }),
    );
    return { ok: true as const, value: created.value };
  });
}
