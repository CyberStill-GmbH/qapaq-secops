/**
 * Sprint 5 · fase 4 — tareas y bitácora del incidente.
 *
 * Fija las reglas que sostienen el cierre honesto de un caso (S5-D9): una tarea obligatoria
 * abierta bloquea el cierre, cancelarla exige motivo, y la bitácora no se edita.
 */

import { describe, expect, it } from 'vitest';

import { capabilitiesForRoles } from '@qapaq/access';

import {
  addIncidentNote,
  applyIncidentCommand,
  applyTaskCommand,
  blocksClosure,
  createIncidentTask,
  createNote,
  createTask,
  executeIncidentCommand,
  executeTaskCommand,
  InMemorySoc,
  openIncident,
  type IncidentTask,
  type SocDependencies,
} from '../src/index.js';

const AT = new Date('2026-10-12T16:00:00.000Z');
const INCIDENT_ID = '0190f47a-0000-7000-8000-000000000001';

function task(overrides: Partial<IncidentTask> = {}): IncidentTask {
  const created = createTask({
    id: '0190f47a-0000-7000-8000-0000000000aa',
    tenantId: 'tenant-a',
    incidentId: INCIDENT_ID,
    title: 'Revisar reglas de buzón del usuario',
    required: true,
    createdBy: 'sub-lider',
    at: AT,
  });
  if (!created.ok) throw new Error(created.detail);
  return { ...created.value, ...overrides };
}

describe('dominio de tareas', () => {
  it('nace abierta, en revisión 1 y con el título normalizado', () => {
    const created = createTask({
      id: 't-1',
      tenantId: 'tenant-a',
      incidentId: INCIDENT_ID,
      title: '  Bloquear sesión del usuario  ',
      required: false,
      createdBy: 'sub-1',
      at: AT,
    });
    expect(created).toMatchObject({
      ok: true,
      value: { status: 'open', revision: 1, title: 'Bloquear sesión del usuario' },
    });
  });

  it('rechaza títulos fuera de límite', () => {
    expect(
      createTask({
        id: 't',
        tenantId: 't',
        incidentId: INCIDENT_ID,
        title: 'ab',
        required: false,
        createdBy: 's',
        at: AT,
      }),
    ).toMatchObject({ ok: false, code: 'TASK_TITLE_INVALID' });
  });

  it('recorre iniciar → completar → reabrir con revisión y fecha de término coherentes', () => {
    const started = applyTaskCommand(task(), { name: 'start', at: AT, expectedRevision: 1 });
    expect(started).toMatchObject({ ok: true, value: { status: 'in_progress', revision: 2 } });
    if (!started.ok) return;
    const done = applyTaskCommand(started.value, { name: 'complete', at: AT, expectedRevision: 2 });
    expect(done).toMatchObject({ ok: true, value: { status: 'done', completedAt: AT } });
    if (!done.ok) return;
    const reopened = applyTaskCommand(done.value, { name: 'reopen', at: AT, expectedRevision: 3 });
    expect(reopened).toMatchObject({ ok: true, value: { status: 'open', completedAt: null } });
  });

  it('cancelar una obligatoria exige motivo; una opcional no', () => {
    expect(
      applyTaskCommand(task(), { name: 'cancel', at: AT, expectedRevision: 1, reason: 'no' }),
    ).toMatchObject({ ok: false, code: 'CANCELLATION_REASON_REQUIRED' });
    expect(
      applyTaskCommand(task(), {
        name: 'cancel',
        at: AT,
        expectedRevision: 1,
        reason: 'Duplicada con la tarea de bloqueo de sesión.',
      }),
    ).toMatchObject({ ok: true, value: { status: 'cancelled' } });
    expect(
      applyTaskCommand(task({ required: false }), { name: 'cancel', at: AT, expectedRevision: 1 }),
    ).toMatchObject({ ok: true, value: { status: 'cancelled', cancellationReason: null } });
  });

  it('rechaza revisión obsoleta, transición inválida y asignación vacía', () => {
    expect(applyTaskCommand(task(), { name: 'start', at: AT, expectedRevision: 9 })).toMatchObject({
      ok: false,
      code: 'REVISION_STALE',
    });
    expect(applyTaskCommand(task(), { name: 'reopen', at: AT, expectedRevision: 1 })).toMatchObject(
      { ok: false, code: 'INVALID_TRANSITION' },
    );
    expect(
      applyTaskCommand(task(), { name: 'assign', at: AT, expectedRevision: 1, assigneeId: ' ' }),
    ).toMatchObject({ ok: false, code: 'ASSIGNEE_REQUIRED' });
  });

  it('solo una obligatoria abierta o en curso bloquea el cierre', () => {
    expect(blocksClosure(task())).toBe(true);
    expect(blocksClosure(task({ status: 'in_progress' }))).toBe(true);
    expect(blocksClosure(task({ status: 'done' }))).toBe(false);
    expect(blocksClosure(task({ status: 'cancelled' }))).toBe(false);
    expect(blocksClosure(task({ required: false }))).toBe(false);
  });

  it('la nota exige cuerpo y conserva la corrección', () => {
    expect(
      createNote({
        id: 'n',
        tenantId: 't',
        incidentId: INCIDENT_ID,
        authorId: 'a',
        body: ' ',
        at: AT,
      }),
    ).toMatchObject({ ok: false, code: 'NOTE_BODY_INVALID' });
    expect(
      createNote({
        id: 'n2',
        tenantId: 't',
        incidentId: INCIDENT_ID,
        authorId: 'a',
        body: 'Corrijo la IP: era 203.0.113.9.',
        correctsNoteId: 'n1',
        at: AT,
      }),
    ).toMatchObject({ ok: true, value: { correctsNoteId: 'n1' } });
  });
});

describe('cierre del incidente con tareas', () => {
  it('rechaza cerrar con tareas obligatorias abiertas', () => {
    const incident = {
      ...openIncident({
        id: INCIDENT_ID,
        tenantId: 'tenant-a',
        title: 'Regla de reenvío sospechosa',
        severity: 'high' as const,
        ownerId: 'sub-lider',
        summary: 'Caso sintético.',
        alertIds: [],
        openedAt: AT,
      }),
      status: 'resolved' as const,
    };
    expect(
      applyIncidentCommand(incident, {
        name: 'close',
        actorId: 'sub-lider',
        at: AT,
        expectedRevision: 1,
        closureReason: 'Contenido y verificado con el usuario.',
        openRequiredTaskIds: ['t-1'],
      }),
    ).toMatchObject({ ok: false, code: 'REQUIRED_TASKS_OPEN' });
  });
});

describe('casos de uso de trabajo del incidente', () => {
  let counter = 0;
  const soc = new InMemorySoc();
  const dependencies: SocDependencies = {
    unitOfWork: soc,
    clock: { now: () => AT },
    ids: {
      next: () => `0190f47a-0000-7000-8000-${String(++counter).padStart(12, '0')}`,
    },
  };
  const actor = (roles: string[], subjectId = 'sub-lider') => ({
    subjectId,
    tenantId: 'tenant-a',
    sessionId: 'session-1',
    capabilities: capabilitiesForRoles(roles),
  });
  const lead = actor(['qapaq.soc.lead']);
  const auditor = actor(['qapaq.auditor'], 'sub-auditor');

  soc.incidentRows.set(`tenant-a|${INCIDENT_ID}`, {
    ...openIncident({
      id: INCIDENT_ID,
      tenantId: 'tenant-a',
      title: 'Regla de reenvío sospechosa',
      severity: 'high',
      ownerId: 'sub-lider',
      summary: 'Caso sintético.',
      alertIds: [],
      openedAt: AT,
    }),
    status: 'resolved',
  });

  it('crea la tarea con auditoría y bloquea el cierre hasta terminarla', async () => {
    const created = await createIncidentTask(dependencies, {
      actor: lead,
      incidentId: INCIDENT_ID,
      correlationId: 'corr-1',
      title: 'Confirmar con el usuario',
      required: true,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const blocked = await executeIncidentCommand(dependencies, {
      actor: lead,
      incidentId: INCIDENT_ID,
      correlationId: 'corr-2',
      command: { name: 'close', expectedRevision: 1, closureReason: 'Contenido y verificado.' },
    });
    expect(blocked).toMatchObject({ ok: false, reason: 'REQUIRED_TASKS_OPEN' });

    const done = await executeTaskCommand(dependencies, {
      actor: lead,
      incidentId: INCIDENT_ID,
      taskId: created.value.id,
      correlationId: 'corr-3',
      command: { name: 'complete', expectedRevision: 1 },
    });
    expect(done).toMatchObject({ ok: true, value: { status: 'done' } });

    const closed = await executeIncidentCommand(dependencies, {
      actor: lead,
      incidentId: INCIDENT_ID,
      correlationId: 'corr-4',
      command: { name: 'close', expectedRevision: 1, closureReason: 'Contenido y verificado.' },
    });
    expect(closed).toMatchObject({ ok: true, value: { status: 'closed' } });

    const actions = (await soc.allAudit()).map((event) => event.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'soc.incident.task.created',
        'soc.incident.task.complete',
        'soc.incident.close',
      ]),
    );
  });

  it('un incidente cerrado no admite notas nuevas', async () => {
    const result = await addIncidentNote(dependencies, {
      actor: lead,
      incidentId: INCIDENT_ID,
      correlationId: 'corr-5',
      body: 'Nota tardía.',
    });
    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN', reason: 'RESOURCE_CLOSED' });
  });

  it('sin capability se rechaza y queda auditado como denegado', async () => {
    const result = await addIncidentNote(dependencies, {
      actor: auditor,
      incidentId: INCIDENT_ID,
      correlationId: 'corr-6',
      body: 'Intento del auditor.',
    });
    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN', reason: 'CAPABILITY_MISSING' });
    const last = (await soc.allAudit()).at(-1);
    expect(last).toMatchObject({ action: 'soc.incident.note.added', outcome: 'denied' });
  });
});
