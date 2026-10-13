/**
 * C-17 — incidente/caso mínimo.
 *
 * El incidente agrupa alertas que pertenecen al mismo hecho y sostiene el trabajo de
 * respuesta. El MVP cubre el recorrido que la Review debe poder demostrar: abrir desde
 * una alerta escalada, contener, resolver y cerrar, sin perder quién hizo qué.
 *
 * No se permite cerrar con alertas sin triar: un incidente cerrado sobre evidencia a
 * medias es peor que uno abierto, porque deja de pedir atención.
 */

export const INCIDENT_STATUSES = ['open', 'contained', 'eradicated', 'resolved', 'closed'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_COMMANDS = [
  'contain',
  'eradicate',
  'resolve',
  'close',
  'reopen',
  'attach_alert',
  'reassign',
] as const;
export type IncidentCommandName = (typeof INCIDENT_COMMANDS)[number];

export interface Incident {
  readonly id: string;
  readonly tenantId: string;
  readonly title: string;
  readonly severity: IncidentSeverity;
  readonly status: IncidentStatus;
  readonly ownerId: string;
  readonly alertIds: readonly string[];
  readonly summary: string;
  readonly openedAt: Date;
  readonly updatedAt: Date;
  readonly closedAt: Date | null;
  readonly closureReason: string | null;
  readonly revision: number;
}

const TRANSITIONS: Readonly<Record<IncidentCommandName, Readonly<Record<string, IncidentStatus>>>> =
  Object.freeze({
    contain: { open: 'contained' },
    eradicate: { contained: 'eradicated' },
    resolve: { contained: 'resolved', eradicated: 'resolved' },
    close: { resolved: 'closed' },
    reopen: { closed: 'open', resolved: 'open' },
    attach_alert: {
      open: 'open',
      contained: 'contained',
      eradicated: 'eradicated',
      resolved: 'resolved',
    },
    reassign: {
      open: 'open',
      contained: 'contained',
      eradicated: 'eradicated',
      resolved: 'resolved',
    },
  });

export const INCIDENT_ERROR_CODES = [
  'INVALID_TRANSITION',
  'REVISION_STALE',
  'OWNER_REQUIRED',
  'CLOSURE_REASON_REQUIRED',
  'OPEN_ALERTS_PENDING',
  'REQUIRED_TASKS_OPEN',
  'ALERT_ALREADY_ATTACHED',
  'ALERT_TENANT_MISMATCH',
] as const;
export type IncidentErrorCode = (typeof INCIDENT_ERROR_CODES)[number];

export interface IncidentCommand {
  readonly name: IncidentCommandName;
  readonly actorId: string;
  readonly at: Date;
  readonly expectedRevision: number;
  readonly ownerId?: string;
  readonly closureReason?: string;
  readonly alert?: { readonly id: string; readonly tenantId: string; readonly triaged: boolean };
  /** Alertas aún sin triar al momento de cerrar; el caso de uso las aporta. */
  readonly untriagedAlertIds?: readonly string[];
  /** Tareas obligatorias aún abiertas al cerrar (S5-D9); el caso de uso las aporta. */
  readonly openRequiredTaskIds?: readonly string[];
}

export type IncidentTransition =
  | { readonly ok: true; readonly incident: Incident; readonly from: IncidentStatus }
  | { readonly ok: false; readonly code: IncidentErrorCode; readonly detail: string };

function fail(code: IncidentErrorCode, detail: string): IncidentTransition {
  return { ok: false, code, detail };
}

export function openIncident(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly title: string;
  readonly severity: IncidentSeverity;
  readonly ownerId: string;
  readonly summary: string;
  readonly alertIds: readonly string[];
  readonly openedAt: Date;
}): Incident {
  return {
    ...input,
    alertIds: [...input.alertIds],
    status: 'open',
    updatedAt: input.openedAt,
    closedAt: null,
    closureReason: null,
    revision: 1,
  };
}

export function applyIncidentCommand(
  incident: Incident,
  command: IncidentCommand,
): IncidentTransition {
  if (incident.revision !== command.expectedRevision) {
    return fail(
      'REVISION_STALE',
      `El incidente avanzó a la revisión ${incident.revision}; se esperaba ${command.expectedRevision}.`,
    );
  }
  const next = TRANSITIONS[command.name][incident.status];
  if (!next) {
    return fail(
      'INVALID_TRANSITION',
      `No se puede ejecutar ${command.name} sobre un incidente en estado ${incident.status}.`,
    );
  }
  const base = {
    ...incident,
    status: next,
    updatedAt: command.at,
    revision: incident.revision + 1,
  };

  if (command.name === 'attach_alert') {
    const alert = command.alert;
    if (!alert) return fail('INVALID_TRANSITION', 'Falta la alerta a asociar.');
    if (alert.tenantId !== incident.tenantId) {
      return fail('ALERT_TENANT_MISMATCH', 'La alerta pertenece a otro tenant.');
    }
    if (incident.alertIds.includes(alert.id)) {
      return fail('ALERT_ALREADY_ATTACHED', `La alerta ${alert.id} ya está asociada.`);
    }
    return {
      ok: true,
      from: incident.status,
      incident: { ...base, alertIds: [...incident.alertIds, alert.id] },
    };
  }
  if (command.name === 'reassign') {
    if (!command.ownerId) return fail('OWNER_REQUIRED', 'Falta la nueva persona responsable.');
    return { ok: true, from: incident.status, incident: { ...base, ownerId: command.ownerId } };
  }
  if (command.name === 'close') {
    const reason = command.closureReason?.trim() ?? '';
    if (reason.length < 10) {
      return fail('CLOSURE_REASON_REQUIRED', 'El cierre exige un motivo sustentado.');
    }
    const pending = command.untriagedAlertIds ?? [];
    if (pending.length > 0) {
      return fail(
        'OPEN_ALERTS_PENDING',
        `Quedan ${pending.length} alerta(s) sin triar: ${pending.join(', ')}.`,
      );
    }
    const openTasks = command.openRequiredTaskIds ?? [];
    if (openTasks.length > 0) {
      return fail(
        'REQUIRED_TASKS_OPEN',
        `Quedan ${openTasks.length} tarea(s) obligatoria(s) sin terminar ni cancelar.`,
      );
    }
    return {
      ok: true,
      from: incident.status,
      incident: { ...base, closedAt: command.at, closureReason: reason },
    };
  }
  if (command.name === 'reopen') {
    return {
      ok: true,
      from: incident.status,
      incident: { ...base, closedAt: null, closureReason: null },
    };
  }
  return { ok: true, from: incident.status, incident: base };
}
