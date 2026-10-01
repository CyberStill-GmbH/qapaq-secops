import { beforeEach, describe, expect, it } from 'vitest';

import { capabilitiesForRoles, type Actor } from '@qapaq/access';
import { verifyChain } from '@qapaq/audit';
import type { DetectionCandidate } from '@qapaq/detection';

import { InMemorySoc } from '../src/memory-unit-of-work.js';
import {
  executeAlertCommand,
  executeIncidentCommand,
  ingestCandidate,
  openIncidentFromAlert,
  type SocDependencies,
} from '../src/use-cases.js';
import { requiresCriticalNotification, type SocDomainEvent } from '../src/events.js';

const AT = new Date('2026-10-08T09:00:00.000Z');

const CANDIDATE: DetectionCandidate = {
  id: '0199bf11-0000-7000-8000-0000000000a1',
  tenantId: 'tenant-1',
  eventRecordId: '01890f47-7abc-7def-8abc-0123456789ab',
  eventUid: 'siem-qapaq-lab:alerts:evt-0001',
  idempotencyKey: 'key-1',
  priority: 'P1',
  score: 95,
  reasons: [{ code: 'BASE_SEVERITY', delta: 80, detail: 'crítico' }],
  rulesetId: 'qapaq.detection.prioritization',
  rulesetVersion: '1.0.0',
  occurredAt: AT,
  createdAt: AT,
  title: 'Acceso sospechoso (wazuh 5716)',
};

function actor(roles: readonly string[], overrides: Partial<Actor> = {}): Actor {
  return {
    subjectId: 'analyst-1',
    tenantId: 'tenant-1',
    sessionId: 'sess-1',
    roles: [...roles],
    capabilities: capabilitiesForRoles(roles),
    ...overrides,
  };
}

let soc: InMemorySoc;
let sequence: number;
let dependencies: SocDependencies;

beforeEach(() => {
  soc = new InMemorySoc();
  sequence = 0;
  dependencies = {
    unitOfWork: soc,
    clock: { now: () => AT },
    ids: {
      next: () => {
        sequence += 1;
        return `0199bf22-0000-7000-8000-${sequence.toString().padStart(12, '0')}`;
      },
    },
  };
});

async function seedAcknowledgedAlert() {
  await ingestCandidate(dependencies, CANDIDATE);
  const acknowledged = await executeAlertCommand(dependencies, {
    actor: actor(['qapaq.soc.analyst']),
    alertId: CANDIDATE.id,
    correlationId: 'corr-1',
    command: { name: 'acknowledge', expectedRevision: 1 },
  });
  if (!acknowledged.ok) throw new Error('No se pudo reconocer la alerta.');
  return acknowledged.value;
}

describe('C-17 · ingesta del candidato', () => {
  it('crea la alerta, su AuditEvent y su mensaje de outbox', async () => {
    const result = await ingestCandidate(dependencies, CANDIDATE);

    expect(result.ok && result.value.created).toBe(true);
    expect(soc.alertRows.size).toBe(1);
    expect(soc.outboxRows.size).toBe(1);
    expect((await soc.allAudit()).map((event) => event.action)).toEqual(['soc.alert.created']);
  });

  it('repetir la ingesta no duplica alerta, auditoría ni outbox', async () => {
    await ingestCandidate(dependencies, CANDIDATE);
    const second = await ingestCandidate(dependencies, CANDIDATE);

    expect(second.ok && second.value.created).toBe(false);
    expect(soc.alertRows.size).toBe(1);
    expect(soc.outboxRows.size).toBe(1);
    expect(await soc.allAudit()).toHaveLength(1);
  });

  it('no deja rastro si la transacción falla al confirmar', async () => {
    soc.failNextCommit = true;

    await expect(ingestCandidate(dependencies, CANDIDATE)).rejects.toThrow('COMMIT_FAILED');
    expect(soc.alertRows.size).toBe(0);
    expect(soc.outboxRows.size).toBe(0);
    expect(await soc.allAudit()).toHaveLength(0);
  });
});

describe('C-17 · autorización de los comandos', () => {
  it('permite triar al analista asignado', async () => {
    await seedAcknowledgedAlert();
    const triaged = await executeAlertCommand(dependencies, {
      actor: actor(['qapaq.soc.analyst']),
      alertId: CANDIDATE.id,
      correlationId: 'corr-2',
      command: {
        name: 'triage',
        expectedRevision: 2,
        verdict: 'true_positive',
        note: 'Confirmado con el usuario: no reconoce el acceso.',
      },
    });

    expect(triaged.ok && triaged.value.status).toBe('triaged');
    expect(triaged.ok && triaged.value.verdict).toBe('true_positive');
  });

  it('deniega a quien no tiene la capability y audita la denegación', async () => {
    await seedAcknowledgedAlert();
    const denied = await executeAlertCommand(dependencies, {
      actor: actor(['qapaq.auditor'], { subjectId: 'auditor-1' }),
      alertId: CANDIDATE.id,
      correlationId: 'corr-3',
      command: { name: 'triage', expectedRevision: 2, verdict: 'benign', note: 'sin sustento.' },
    });
    const audit = await soc.allAudit();

    expect(denied).toMatchObject({ ok: false, code: 'FORBIDDEN', reason: 'CAPABILITY_MISSING' });
    expect(audit.at(-1)).toMatchObject({ outcome: 'denied', action: 'soc.alert.triage' });
    expect(soc.alertRows.get('tenant-1|' + CANDIDATE.id)?.status).toBe('acknowledged');
  });

  it('deniega a otro tenant sin revelar si la alerta existe', async () => {
    await seedAcknowledgedAlert();
    const foreign = await executeAlertCommand(dependencies, {
      actor: actor(['qapaq.soc.analyst'], { tenantId: 'tenant-2' }),
      alertId: CANDIDATE.id,
      correlationId: 'corr-4',
      command: { name: 'acknowledge', expectedRevision: 1 },
    });
    const missing = await executeAlertCommand(dependencies, {
      actor: actor(['qapaq.soc.analyst'], { tenantId: 'tenant-2' }),
      alertId: 'alert-inexistente',
      correlationId: 'corr-5',
      command: { name: 'acknowledge', expectedRevision: 1 },
    });

    expect(foreign).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(missing).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(foreign.ok === false && foreign.reason).toBe(missing.ok === false && missing.reason);
  });

  it('deniega triar una alerta asignada a otra persona', async () => {
    await seedAcknowledgedAlert();
    const denied = await executeAlertCommand(dependencies, {
      actor: actor(['qapaq.soc.analyst'], { subjectId: 'analyst-2' }),
      alertId: CANDIDATE.id,
      correlationId: 'corr-6',
      command: {
        name: 'triage',
        expectedRevision: 2,
        verdict: 'benign',
        note: 'Intento de triaje cruzado.',
      },
    });

    expect(denied).toMatchObject({ ok: false, reason: 'RESOURCE_NOT_ASSIGNED' });
  });
});

describe('C-17 · concurrencia', () => {
  it('solo una de dos escrituras simultáneas prospera', async () => {
    await ingestCandidate(dependencies, CANDIDATE);
    const request = {
      actor: actor(['qapaq.soc.analyst']),
      alertId: CANDIDATE.id,
      correlationId: 'corr-7',
      command: { name: 'acknowledge' as const, expectedRevision: 1 },
    };
    const results = await Promise.all([
      executeAlertCommand(dependencies, request),
      executeAlertCommand(dependencies, { ...request, correlationId: 'corr-8' }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === 'CONFLICT')).toHaveLength(1);
    expect(soc.alertRows.get(`tenant-1|${CANDIDATE.id}`)?.revision).toBe(2);
  });

  it('informa conflicto, no error genérico, ante revisión obsoleta', async () => {
    await seedAcknowledgedAlert();
    const stale = await executeAlertCommand(dependencies, {
      actor: actor(['qapaq.soc.analyst']),
      alertId: CANDIDATE.id,
      correlationId: 'corr-9',
      command: { name: 'acknowledge', expectedRevision: 1 },
    });

    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT', reason: 'REVISION_STALE' });
  });
});

describe('C-17 · incidente y notificación', () => {
  async function escalateAndOpen() {
    await seedAcknowledgedAlert();
    await executeAlertCommand(dependencies, {
      actor: actor(['qapaq.soc.analyst']),
      alertId: CANDIDATE.id,
      correlationId: 'corr-10',
      command: {
        name: 'triage',
        expectedRevision: 2,
        verdict: 'true_positive',
        note: 'Confirmado con el usuario: no reconoce el acceso.',
      },
    });
    await executeAlertCommand(dependencies, {
      actor: actor(['qapaq.soc.analyst']),
      alertId: CANDIDATE.id,
      correlationId: 'corr-11',
      command: { name: 'escalate', expectedRevision: 3 },
    });
    return openIncidentFromAlert(dependencies, {
      actor: actor(['qapaq.soc.lead'], { subjectId: 'lead-1' }),
      alertId: CANDIDATE.id,
      title: 'Acceso no autorizado a srv-app-01',
      severity: 'critical',
      summary: 'Alerta P1 escalada por el analista.',
      correlationId: 'corr-12',
      expectedAlertRevision: 4,
    });
  }

  it('abre el caso desde la alerta escalada y la vincula', async () => {
    const opened = await escalateAndOpen();

    expect(opened.ok && opened.value.status).toBe('open');
    expect(soc.alertRows.get(`tenant-1|${CANDIDATE.id}`)?.incidentId).toBe(
      opened.ok ? opened.value.id : undefined,
    );
  });

  it('publica un hecho que exige notificación crítica', async () => {
    const opened = await escalateAndOpen();
    const messages = [...soc.outboxRows.values()];
    const criticalEvent: SocDomainEvent = {
      type: 'soc.incident.opened',
      tenantId: 'tenant-1',
      aggregateType: 'incident',
      aggregateId: opened.ok ? opened.value.id : '',
      occurredAt: AT,
      actorId: 'lead-1',
      payload: { severity: 'critical', status: 'open', title: 't', alertCount: 1 },
    };

    expect(messages.map((message) => message.messageType)).toEqual(
      expect.arrayContaining(['soc.alert.triaged', 'soc.alert.escalated', 'soc.incident.opened']),
    );
    expect(requiresCriticalNotification(criticalEvent)).toBe(true);
  });

  it('no deja cerrar el caso con alertas sin triar', async () => {
    await ingestCandidate(dependencies, CANDIDATE);
    const opened = await openIncidentFromAlert(dependencies, {
      actor: actor(['qapaq.soc.lead'], { subjectId: 'lead-1' }),
      alertId: CANDIDATE.id,
      title: 'Caso sin triaje',
      severity: 'high',
      summary: 'Apertura directa.',
      correlationId: 'corr-13',
      expectedAlertRevision: 1,
    });
    if (!opened.ok) throw new Error('No se pudo abrir el caso.');
    const resolved = await executeIncidentCommand(dependencies, {
      actor: actor(['qapaq.soc.lead'], { subjectId: 'lead-1' }),
      incidentId: opened.value.id,
      correlationId: 'corr-14',
      command: { name: 'contain', expectedRevision: 1 },
    });
    if (!resolved.ok) throw new Error('No se pudo contener el caso.');
    const settled = await executeIncidentCommand(dependencies, {
      actor: actor(['qapaq.soc.lead'], { subjectId: 'lead-1' }),
      incidentId: opened.value.id,
      correlationId: 'corr-15',
      command: { name: 'resolve', expectedRevision: 2 },
    });
    if (!settled.ok) throw new Error('No se pudo resolver el caso.');
    const closed = await executeIncidentCommand(dependencies, {
      actor: actor(['qapaq.soc.lead'], { subjectId: 'lead-1' }),
      incidentId: opened.value.id,
      correlationId: 'corr-16',
      command: {
        name: 'close',
        expectedRevision: 3,
        closureReason: 'Se cierra tras la contención completa.',
      },
    });

    expect(closed).toMatchObject({
      ok: false,
      code: 'INVALID_COMMAND',
      reason: 'OPEN_ALERTS_PENDING',
    });
  });

  it('deniega cerrar a quien no tiene incidents.close', async () => {
    const opened = await escalateAndOpen();
    if (!opened.ok) throw new Error('No se pudo abrir el caso.');
    const denied = await executeIncidentCommand(dependencies, {
      actor: actor(['qapaq.soc.analyst']),
      incidentId: opened.value.id,
      correlationId: 'corr-16',
      command: { name: 'close', expectedRevision: 1, closureReason: 'Cierre no autorizado.' },
    });

    expect(denied).toMatchObject({ ok: false, code: 'FORBIDDEN', reason: 'CAPABILITY_MISSING' });
  });
});

describe('C-17 · evidencia de auditoría del recorrido', () => {
  it('deja una cadena verificable con cada paso del flujo', async () => {
    await seedAcknowledgedAlert();
    await executeAlertCommand(dependencies, {
      actor: actor(['qapaq.soc.analyst']),
      alertId: CANDIDATE.id,
      correlationId: 'corr-17',
      command: {
        name: 'triage',
        expectedRevision: 2,
        verdict: 'true_positive',
        note: 'Confirmado con el usuario: no reconoce el acceso.',
      },
    });
    const events = await soc.allAudit();

    expect(events.map((event) => event.action)).toEqual([
      'soc.alert.created',
      'soc.alert.acknowledge',
      'soc.alert.triage',
    ]);
    expect(verifyChain(events).ok).toBe(true);
    expect(events.every((event) => event.correlationId.length > 0)).toBe(true);
  });
});
