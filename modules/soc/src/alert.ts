/**
 * C-17 — ciclo de vida de la alerta SOC.
 *
 * Una alerta nace de un candidato de C-16 y recorre estados que corresponden a trabajo
 * humano real: reconocer, triar y cerrar o escalar. El modelo es explícito en vez de
 * permisivo porque el estado de una alerta es evidencia: "cerrada" debe significar que
 * alguien decidió cerrarla, con motivo y en un orden reconstruible.
 *
 * Las transiciones se declaran en una tabla y no en condicionales dispersos; cualquier
 * movimiento fuera de la tabla es un error de dominio, no un no-op silencioso.
 */

import type { Priority, Reason, SignalClass } from '@qapaq/detection';

export const ALERT_STATUSES = ['new', 'acknowledged', 'triaged', 'escalated', 'closed'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const TRIAGE_VERDICTS = ['true_positive', 'false_positive', 'benign', 'duplicate'] as const;
export type TriageVerdict = (typeof TRIAGE_VERDICTS)[number];

export const ALERT_COMMANDS = [
  'acknowledge',
  'assign',
  'triage',
  'escalate',
  'close',
  'reopen',
] as const;
export type AlertCommandName = (typeof ALERT_COMMANDS)[number];

export interface Alert {
  readonly id: string;
  readonly tenantId: string;
  readonly candidateId: string;
  readonly eventRecordId: string;
  readonly title: string;
  readonly priority: Priority;
  readonly score: number;
  readonly reasons: readonly Reason[];
  readonly status: AlertStatus;
  readonly assigneeId: string | null;
  readonly verdict: TriageVerdict | null;
  readonly triageNote: string | null;
  readonly incidentId: string | null;
  readonly occurredAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Compare-and-set del store. Dos analistas sobre la misma alerta es lo normal. */
  readonly revision: number;
  /**
   * Correlación de C-16 al momento de crear la alerta: claves `user:`/`ip:`, clase de
   * señal, regla de origen y alertas relacionadas. Permiten agrupar por entidad en la
   * consola y alimentan la correlación de las alertas siguientes.
   */
  readonly entityKeys: readonly string[];
  /**
   * Referencias opacas (`ent_…`) de `entityKeys`, en el mismo orden (D-10b). Son lo único
   * que viaja en URLs y filtros: un UPN o una IP no deben quedar en historial ni en logs.
   */
  readonly entityRefs: readonly string[];
  readonly signal: SignalClass | null;
  readonly ruleId: string | null;
  readonly relatedAlertIds: readonly string[];
}

/**
 * Transiciones válidas. `reopen` existe para el caso real de un cierre equivocado y
 * devuelve la alerta a `acknowledged`, no a `new`: el reconocimiento ya ocurrió.
 */
const TRANSITIONS: Readonly<Record<AlertCommandName, Readonly<Record<string, AlertStatus>>>> =
  Object.freeze({
    acknowledge: { new: 'acknowledged' },
    assign: { new: 'acknowledged', acknowledged: 'acknowledged', triaged: 'triaged' },
    triage: { acknowledged: 'triaged' },
    escalate: { triaged: 'escalated' },
    close: { acknowledged: 'closed', triaged: 'closed', escalated: 'closed' },
    reopen: { closed: 'acknowledged' },
  });

export const ALERT_ERROR_CODES = [
  'INVALID_TRANSITION',
  'ASSIGNEE_REQUIRED',
  'NOT_ASSIGNED',
  'VERDICT_REQUIRED',
  'NOTE_REQUIRED',
  'ESCALATION_REQUIRES_TRUE_POSITIVE',
  'REVISION_STALE',
] as const;
export type AlertErrorCode = (typeof ALERT_ERROR_CODES)[number];

export const TRIAGE_NOTE_LIMITS = Object.freeze({ minimumLength: 10, maximumLength: 2000 });

export interface AlertCommand {
  readonly name: AlertCommandName;
  readonly actorId: string;
  readonly at: Date;
  readonly expectedRevision: number;
  readonly assigneeId?: string;
  readonly verdict?: TriageVerdict;
  readonly note?: string;
}

export type AlertTransition =
  | { readonly ok: true; readonly alert: Alert; readonly from: AlertStatus }
  | { readonly ok: false; readonly code: AlertErrorCode; readonly detail: string };

function fail(code: AlertErrorCode, detail: string): AlertTransition {
  return { ok: false, code, detail };
}

export function createAlert(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly candidateId: string;
  readonly eventRecordId: string;
  readonly title: string;
  readonly priority: Priority;
  readonly score: number;
  readonly reasons: readonly Reason[];
  readonly occurredAt: Date;
  readonly createdAt: Date;
  readonly entityKeys?: readonly string[];
  readonly entityRefs?: readonly string[];
  readonly signal?: SignalClass | null;
  readonly ruleId?: string | null;
  readonly relatedAlertIds?: readonly string[];
}): Alert {
  return {
    ...input,
    entityKeys: input.entityKeys ?? [],
    entityRefs: input.entityRefs ?? [],
    signal: input.signal ?? null,
    ruleId: input.ruleId ?? null,
    relatedAlertIds: input.relatedAlertIds ?? [],
    status: 'new',
    assigneeId: null,
    verdict: null,
    triageNote: null,
    incidentId: null,
    updatedAt: input.createdAt,
    revision: 1,
  };
}

export function applyAlertCommand(alert: Alert, command: AlertCommand): AlertTransition {
  if (alert.revision !== command.expectedRevision) {
    return fail(
      'REVISION_STALE',
      `La alerta avanzó a la revisión ${alert.revision}; se esperaba ${command.expectedRevision}.`,
    );
  }
  const next = TRANSITIONS[command.name][alert.status];
  if (!next) {
    return fail(
      'INVALID_TRANSITION',
      `No se puede ejecutar ${command.name} sobre una alerta en estado ${alert.status}.`,
    );
  }
  const base = { ...alert, status: next, updatedAt: command.at, revision: alert.revision + 1 };

  if (command.name === 'assign') {
    if (!command.assigneeId) return fail('ASSIGNEE_REQUIRED', 'Falta la persona asignada.');
    return { ok: true, from: alert.status, alert: { ...base, assigneeId: command.assigneeId } };
  }
  if (command.name === 'acknowledge') {
    return {
      ok: true,
      from: alert.status,
      alert: { ...base, assigneeId: alert.assigneeId ?? command.actorId },
    };
  }
  if (command.name === 'triage') {
    if (!command.verdict) return fail('VERDICT_REQUIRED', 'El triaje exige un veredicto.');
    const note = command.note?.trim() ?? '';
    if (note.length < TRIAGE_NOTE_LIMITS.minimumLength) {
      return fail('NOTE_REQUIRED', 'El triaje exige una nota con el sustento de la decisión.');
    }
    if (note.length > TRIAGE_NOTE_LIMITS.maximumLength) {
      return fail('NOTE_REQUIRED', 'La nota de triaje excede el límite.');
    }
    // Solo tria quien tiene la alerta asignada: evita dos triajes paralelos del mismo caso.
    if (alert.assigneeId !== command.actorId) {
      return fail('NOT_ASSIGNED', 'La alerta está asignada a otra persona.');
    }
    return {
      ok: true,
      from: alert.status,
      alert: { ...base, verdict: command.verdict, triageNote: note },
    };
  }
  if (command.name === 'escalate') {
    if (alert.verdict !== 'true_positive') {
      return fail(
        'ESCALATION_REQUIRES_TRUE_POSITIVE',
        'Solo se escala una alerta triada como verdadero positivo.',
      );
    }
    return { ok: true, from: alert.status, alert: base };
  }
  if (command.name === 'close') {
    const note = command.note?.trim() ?? '';
    if (alert.status !== 'triaged' && note.length < TRIAGE_NOTE_LIMITS.minimumLength) {
      return fail('NOTE_REQUIRED', 'Cerrar sin triaje exige justificación escrita.');
    }
    return {
      ok: true,
      from: alert.status,
      alert: { ...base, triageNote: note.length > 0 ? note : alert.triageNote },
    };
  }
  return { ok: true, from: alert.status, alert: base };
}

export function linkAlertToIncident(alert: Alert, incidentId: string, at: Date): Alert {
  return { ...alert, incidentId, updatedAt: at, revision: alert.revision + 1 };
}
