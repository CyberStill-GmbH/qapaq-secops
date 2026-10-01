import { describe, expect, it } from 'vitest';

import {
  applyAlertCommand,
  createAlert,
  TRIAGE_NOTE_LIMITS,
  type Alert,
  type AlertCommandName,
  type AlertStatus,
} from '../src/alert.js';
import { applyIncidentCommand, openIncident, type Incident } from '../src/incident.js';

const AT = new Date('2026-10-08T09:00:00.000Z');

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    ...createAlert({
      id: 'alert-1',
      tenantId: 'tenant-1',
      candidateId: 'cand-1',
      eventRecordId: 'rec-1',
      title: 'Intento de autenticación fallido (wazuh 5716)',
      priority: 'P1',
      score: 90,
      reasons: [{ code: 'BASE_SEVERITY', delta: 80, detail: 'crítico' }],
      occurredAt: AT,
      createdAt: AT,
    }),
    ...overrides,
  };
}

function command(name: AlertCommandName, overrides: Record<string, unknown> = {}) {
  return {
    name,
    actorId: 'analyst-1',
    at: AT,
    expectedRevision: 1,
    ...overrides,
  } as Parameters<typeof applyAlertCommand>[1];
}

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    ...openIncident({
      id: 'inc-1',
      tenantId: 'tenant-1',
      title: 'Acceso no autorizado a srv-app-01',
      severity: 'critical',
      ownerId: 'analyst-1',
      summary: 'Alerta P1 escalada',
      alertIds: ['alert-1'],
      openedAt: AT,
    }),
    ...overrides,
  };
}

describe('C-17 · invariantes de la alerta', () => {
  it('nace en new, sin asignar y sin veredicto', () => {
    expect(alert()).toMatchObject({
      status: 'new',
      assigneeId: null,
      verdict: null,
      incidentId: null,
      revision: 1,
    });
  });

  it('recorre el camino completo new → acknowledged → triaged → escalated', () => {
    const acknowledged = applyAlertCommand(alert(), command('acknowledge'));
    expect(acknowledged.ok && acknowledged.alert.status).toBe('acknowledged');
    expect(acknowledged.ok && acknowledged.alert.assigneeId).toBe('analyst-1');

    const triaged = applyAlertCommand(
      acknowledged.ok ? acknowledged.alert : alert(),
      command('triage', {
        expectedRevision: 2,
        verdict: 'true_positive',
        note: 'Credenciales comprometidas confirmadas con el usuario.',
      }),
    );
    expect(triaged.ok && triaged.alert.status).toBe('triaged');

    const escalated = applyAlertCommand(
      triaged.ok ? triaged.alert : alert(),
      command('escalate', { expectedRevision: 3 }),
    );
    expect(escalated.ok && escalated.alert.status).toBe('escalated');
  });

  it('rechaza cada transición fuera de la tabla', () => {
    const cases: readonly (readonly [AlertStatus, AlertCommandName])[] = [
      ['new', 'triage'],
      ['new', 'escalate'],
      ['new', 'reopen'],
      ['acknowledged', 'escalate'],
      ['acknowledged', 'reopen'],
      ['triaged', 'acknowledge'],
      ['closed', 'triage'],
      ['closed', 'close'],
      ['escalated', 'triage'],
    ];

    for (const [status, name] of cases) {
      const result = applyAlertCommand(alert({ status }), command(name));
      expect(result, `${name} sobre ${status}`).toMatchObject({
        ok: false,
        code: 'INVALID_TRANSITION',
      });
    }
  });

  it('exige veredicto y nota sustentada para triar', () => {
    const base = alert({ status: 'acknowledged', assigneeId: 'analyst-1' });

    expect(applyAlertCommand(base, command('triage', { note: 'texto suficiente' }))).toMatchObject({
      ok: false,
      code: 'VERDICT_REQUIRED',
    });
    expect(
      applyAlertCommand(base, command('triage', { verdict: 'benign', note: 'ok' })),
    ).toMatchObject({ ok: false, code: 'NOTE_REQUIRED' });
    expect(
      applyAlertCommand(
        base,
        command('triage', {
          verdict: 'benign',
          note: 'x'.repeat(TRIAGE_NOTE_LIMITS.maximumLength + 1),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'NOTE_REQUIRED' });
  });

  it('solo deja triar a la persona asignada', () => {
    const result = applyAlertCommand(
      alert({ status: 'acknowledged', assigneeId: 'analyst-2' }),
      command('triage', { verdict: 'benign', note: 'Actividad esperada del respaldo.' }),
    );

    expect(result).toMatchObject({ ok: false, code: 'NOT_ASSIGNED' });
  });

  it('solo escala un verdadero positivo', () => {
    expect(
      applyAlertCommand(
        alert({ status: 'triaged', verdict: 'false_positive' }),
        command('escalate'),
      ),
    ).toMatchObject({ ok: false, code: 'ESCALATION_REQUIRES_TRUE_POSITIVE' });
  });

  it('exige justificación para cerrar sin triaje previo', () => {
    expect(applyAlertCommand(alert({ status: 'acknowledged' }), command('close'))).toMatchObject({
      ok: false,
      code: 'NOTE_REQUIRED',
    });
    expect(
      applyAlertCommand(
        alert({ status: 'acknowledged' }),
        command('close', { note: 'Duplicada del caso INC-1, se cierra por acuerdo.' }),
      ),
    ).toMatchObject({ ok: true });
  });

  it('reabre a acknowledged, no a new', () => {
    const reopened = applyAlertCommand(alert({ status: 'closed' }), command('reopen'));

    expect(reopened.ok && reopened.alert.status).toBe('acknowledged');
  });

  it('rechaza un comando con revisión obsoleta antes de mirar la transición', () => {
    const result = applyAlertCommand(alert({ revision: 4 }), command('acknowledge'));

    expect(result).toMatchObject({ ok: false, code: 'REVISION_STALE' });
  });

  it('avanza la revisión en cada transición aceptada', () => {
    const result = applyAlertCommand(alert(), command('acknowledge'));

    expect(result.ok && result.alert.revision).toBe(2);
    expect(result.ok && result.alert.updatedAt).toEqual(AT);
  });

  it('no muta la alerta original', () => {
    const original = alert();
    applyAlertCommand(original, command('acknowledge'));

    expect(original.status).toBe('new');
    expect(original.revision).toBe(1);
  });
});

describe('C-17 · invariantes del incidente', () => {
  it('recorre open → contained → eradicated → resolved → closed', () => {
    let current = incident();
    for (const [name, expected] of [
      ['contain', 'contained'],
      ['eradicate', 'eradicated'],
      ['resolve', 'resolved'],
    ] as const) {
      const result = applyIncidentCommand(current, {
        name,
        actorId: 'analyst-1',
        at: AT,
        expectedRevision: current.revision,
      });
      expect(result.ok && result.incident.status).toBe(expected);
      if (result.ok) current = result.incident;
    }
    const closed = applyIncidentCommand(current, {
      name: 'close',
      actorId: 'analyst-1',
      at: AT,
      expectedRevision: current.revision,
      closureReason: 'Contenido y erradicado; se documenta en el informe INC-1.',
    });

    expect(closed.ok && closed.incident.status).toBe('closed');
    expect(closed.ok && closed.incident.closedAt).toEqual(AT);
  });

  it('no cierra con alertas sin triar', () => {
    const result = applyIncidentCommand(incident({ status: 'resolved' }), {
      name: 'close',
      actorId: 'analyst-1',
      at: AT,
      expectedRevision: 1,
      closureReason: 'Se cierra tras la contención completa del incidente.',
      untriagedAlertIds: ['alert-9'],
    });

    expect(result).toMatchObject({ ok: false, code: 'OPEN_ALERTS_PENDING' });
  });

  it('exige motivo sustentado para cerrar', () => {
    expect(
      applyIncidentCommand(incident({ status: 'resolved' }), {
        name: 'close',
        actorId: 'analyst-1',
        at: AT,
        expectedRevision: 1,
        closureReason: 'ok',
      }),
    ).toMatchObject({ ok: false, code: 'CLOSURE_REASON_REQUIRED' });
  });

  it('no asocia dos veces la misma alerta ni una de otro tenant', () => {
    const base = incident();

    expect(
      applyIncidentCommand(base, {
        name: 'attach_alert',
        actorId: 'analyst-1',
        at: AT,
        expectedRevision: 1,
        alert: { id: 'alert-1', tenantId: 'tenant-1', triaged: true },
      }),
    ).toMatchObject({ ok: false, code: 'ALERT_ALREADY_ATTACHED' });
    expect(
      applyIncidentCommand(base, {
        name: 'attach_alert',
        actorId: 'analyst-1',
        at: AT,
        expectedRevision: 1,
        alert: { id: 'alert-2', tenantId: 'tenant-2', triaged: true },
      }),
    ).toMatchObject({ ok: false, code: 'ALERT_TENANT_MISMATCH' });
  });

  it('rechaza transiciones inválidas y revisiones obsoletas', () => {
    expect(
      applyIncidentCommand(incident(), {
        name: 'close',
        actorId: 'analyst-1',
        at: AT,
        expectedRevision: 1,
        closureReason: 'Motivo suficientemente extenso para el cierre.',
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    expect(
      applyIncidentCommand(incident({ revision: 3 }), {
        name: 'contain',
        actorId: 'analyst-1',
        at: AT,
        expectedRevision: 1,
      }),
    ).toMatchObject({ ok: false, code: 'REVISION_STALE' });
  });

  it('reabrir limpia el cierre', () => {
    const closed = incident({
      status: 'closed',
      closedAt: AT,
      closureReason: 'Cerrado por resolución completa.',
    });
    const reopened = applyIncidentCommand(closed, {
      name: 'reopen',
      actorId: 'analyst-1',
      at: AT,
      expectedRevision: 1,
    });

    expect(reopened.ok && reopened.incident).toMatchObject({
      status: 'open',
      closedAt: null,
      closureReason: null,
    });
  });
});
