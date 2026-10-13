/**
 * Sprint 5 · fase 4 — trabajo asignable y bitácora del incidente (S5-D8, S5-D9).
 *
 * - `IncidentTask` es trabajo comprometido: responsable, estado, vencimiento y si es
 *   obligatorio. Un incidente no se cierra con tareas obligatorias abiertas; cancelar una
 *   obligatoria exige motivo, así la excepción queda explicada.
 * - `IncidentNote` es la bitácora del analista y es append-only: una corrección es una nota
 *   nueva que referencia a la anterior (`correctsNoteId`). Nada se edita en silencio.
 *
 * Funciones puras; la persistencia, la autorización y la auditoría viven en los casos de uso.
 */

export const TASK_STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_COMMANDS = ['start', 'complete', 'reopen', 'cancel', 'assign'] as const;
export type TaskCommandName = (typeof TASK_COMMANDS)[number];

export const TASK_ERROR_CODES = [
  'INVALID_TRANSITION',
  'REVISION_STALE',
  'TASK_TITLE_INVALID',
  'TASK_DESCRIPTION_INVALID',
  'TASK_DUE_INVALID',
  'ASSIGNEE_REQUIRED',
  'CANCELLATION_REASON_REQUIRED',
  'NOTE_BODY_INVALID',
] as const;
export type TaskErrorCode = (typeof TASK_ERROR_CODES)[number];

/** Límites de texto: suficientes para documentar, acotados para no volverse un adjunto. */
export const INCIDENT_WORK_LIMITS = Object.freeze({
  titleMin: 3,
  titleMax: 200,
  descriptionMax: 4_000,
  noteMin: 1,
  noteMax: 10_000,
  reasonMin: 10,
  reasonMax: 500,
});

export interface IncidentTask {
  readonly id: string;
  readonly tenantId: string;
  readonly incidentId: string;
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly required: boolean;
  readonly assigneeId: string | null;
  readonly dueAt: Date | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
  readonly cancellationReason: string | null;
  readonly revision: number;
}

export interface IncidentNote {
  readonly id: string;
  readonly tenantId: string;
  readonly incidentId: string;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt: Date;
  /** Nota que esta corrige; `null` si es una entrada nueva. */
  readonly correctsNoteId: string | null;
}

export type WorkResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: TaskErrorCode; readonly detail: string };

function fail<T>(code: TaskErrorCode, detail: string): WorkResult<T> {
  return { ok: false, code, detail };
}

function within(text: string, min: number, max: number): boolean {
  return text.length >= min && text.length <= max;
}

export interface NewTaskInput {
  readonly id: string;
  readonly tenantId: string;
  readonly incidentId: string;
  readonly title: string;
  readonly description?: string;
  readonly required: boolean;
  readonly assigneeId?: string | null;
  readonly dueAt?: Date | null;
  readonly createdBy: string;
  readonly at: Date;
}

export function createTask(input: NewTaskInput): WorkResult<IncidentTask> {
  const title = input.title.trim();
  const description = (input.description ?? '').trim();
  if (!within(title, INCIDENT_WORK_LIMITS.titleMin, INCIDENT_WORK_LIMITS.titleMax)) {
    return fail('TASK_TITLE_INVALID', 'El título debe tener entre 3 y 200 caracteres.');
  }
  if (description.length > INCIDENT_WORK_LIMITS.descriptionMax) {
    return fail('TASK_DESCRIPTION_INVALID', 'La descripción supera 4000 caracteres.');
  }
  if (input.dueAt && Number.isNaN(input.dueAt.getTime())) {
    return fail('TASK_DUE_INVALID', 'La fecha de vencimiento no es válida.');
  }
  return {
    ok: true,
    value: {
      id: input.id,
      tenantId: input.tenantId,
      incidentId: input.incidentId,
      title,
      description,
      status: 'open',
      required: input.required,
      assigneeId: input.assigneeId?.trim() || null,
      dueAt: input.dueAt ?? null,
      createdBy: input.createdBy,
      createdAt: input.at,
      updatedAt: input.at,
      completedAt: null,
      cancellationReason: null,
      revision: 1,
    },
  };
}

export interface TaskCommand {
  readonly name: TaskCommandName;
  readonly at: Date;
  readonly expectedRevision: number;
  readonly assigneeId?: string;
  readonly reason?: string;
}

/** Estados desde los que cada comando es válido y el estado al que lleva. */
const TASK_TRANSITIONS: Readonly<Record<TaskCommandName, Readonly<Record<string, TaskStatus>>>> =
  Object.freeze({
    start: { open: 'in_progress' },
    complete: { open: 'done', in_progress: 'done' },
    reopen: { done: 'open', cancelled: 'open' },
    cancel: { open: 'cancelled', in_progress: 'cancelled' },
    assign: { open: 'open', in_progress: 'in_progress' },
  });

export function applyTaskCommand(
  task: IncidentTask,
  command: TaskCommand,
): WorkResult<IncidentTask> {
  if (task.revision !== command.expectedRevision) {
    return fail(
      'REVISION_STALE',
      `La tarea avanzó a la revisión ${task.revision}; se esperaba ${command.expectedRevision}.`,
    );
  }
  const next = TASK_TRANSITIONS[command.name][task.status];
  if (!next) {
    return fail(
      'INVALID_TRANSITION',
      `No se puede ejecutar ${command.name} sobre una tarea en estado ${task.status}.`,
    );
  }
  const base: IncidentTask = {
    ...task,
    status: next,
    updatedAt: command.at,
    revision: task.revision + 1,
  };
  switch (command.name) {
    case 'assign': {
      const assigneeId = command.assigneeId?.trim() ?? '';
      if (!assigneeId) return fail('ASSIGNEE_REQUIRED', 'Falta la persona responsable.');
      return { ok: true, value: { ...base, assigneeId } };
    }
    case 'complete':
      return { ok: true, value: { ...base, completedAt: command.at } };
    case 'cancel': {
      const reason = command.reason?.trim() ?? '';
      // Una tarea obligatoria solo se cancela con motivo: es la excepción que deja cerrar.
      if (
        task.required &&
        !within(reason, INCIDENT_WORK_LIMITS.reasonMin, INCIDENT_WORK_LIMITS.reasonMax)
      ) {
        return fail(
          'CANCELLATION_REASON_REQUIRED',
          'Cancelar una tarea obligatoria exige un motivo de 10 a 500 caracteres.',
        );
      }
      return { ok: true, value: { ...base, cancellationReason: reason || null } };
    }
    case 'reopen':
      return { ok: true, value: { ...base, completedAt: null, cancellationReason: null } };
    default:
      return { ok: true, value: base };
  }
}

/** Una tarea obligatoria bloquea el cierre mientras no esté terminada o cancelada. */
export function blocksClosure(task: IncidentTask): boolean {
  return task.required && (task.status === 'open' || task.status === 'in_progress');
}

export interface NewNoteInput {
  readonly id: string;
  readonly tenantId: string;
  readonly incidentId: string;
  readonly authorId: string;
  readonly body: string;
  readonly correctsNoteId?: string | null;
  readonly at: Date;
}

export function createNote(input: NewNoteInput): WorkResult<IncidentNote> {
  const body = input.body.trim();
  if (!within(body, INCIDENT_WORK_LIMITS.noteMin, INCIDENT_WORK_LIMITS.noteMax)) {
    return fail('NOTE_BODY_INVALID', 'La nota debe tener entre 1 y 10000 caracteres.');
  }
  return {
    ok: true,
    value: {
      id: input.id,
      tenantId: input.tenantId,
      incidentId: input.incidentId,
      authorId: input.authorId,
      body,
      createdAt: input.at,
      correctsNoteId: input.correctsNoteId ?? null,
    },
  };
}
