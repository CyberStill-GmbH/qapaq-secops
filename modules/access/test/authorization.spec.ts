import { describe, expect, it } from 'vitest';

import {
  authorize,
  projectFields,
  visibleFields,
  type Actor,
  type ResourceContext,
} from '../src/authorization.js';
import {
  capabilitiesForRoles,
  effectiveCapabilities,
  type Capability,
} from '../src/capabilities.js';

function actor(capabilities: readonly Capability[], overrides: Partial<Actor> = {}): Actor {
  return {
    subjectId: 'analyst-1',
    tenantId: 'tenant-1',
    sessionId: 'sess-1',
    capabilities: new Set(capabilities),
    roles: ['qapaq.soc.analyst'],
    ...overrides,
  };
}

const alert: ResourceContext = {
  type: 'alert',
  id: 'alert-1',
  tenantId: 'tenant-1',
  assigneeId: 'analyst-1',
};

describe('C-18 · capabilities por rol y scope', () => {
  it('traduce roles de Entra a capabilities de QAPAQ', () => {
    expect([...capabilitiesForRoles(['qapaq.soc.analyst'])]).toContain('alerts.triage');
    expect([...capabilitiesForRoles(['qapaq.soc.analyst'])]).not.toContain('events.read_raw');
    expect([...capabilitiesForRoles(['qapaq.soc.lead'])]).toContain('incidents.close');
  });

  it('no concede nada ante un rol desconocido', () => {
    expect(capabilitiesForRoles(['rol.inventado']).size).toBe(0);
    expect(capabilitiesForRoles([]).size).toBe(0);
  });

  it('interseca rol y scope: ninguno amplía al otro', () => {
    const lead = ['qapaq.soc.lead'];

    expect([...effectiveCapabilities(lead, ['soc.read'])]).not.toContain('incidents.close');
    expect([...effectiveCapabilities(lead, ['soc.read', 'soc.write'])]).toContain(
      'incidents.close',
    );
    // El scope de auditoría no concede auditoría a quien no la tiene por rol.
    expect([...effectiveCapabilities(['qapaq.soc.analyst'], ['audit.read'])]).toEqual([]);
  });
});

describe('C-18 · autorización contextual', () => {
  it('permite la acción con capability, tenant y asignación correctos', () => {
    expect(
      authorize({
        actor: actor(['alerts.triage']),
        capability: 'alerts.triage',
        resource: alert,
        requiresAssignment: true,
      }),
    ).toEqual({ allowed: true });
  });

  it('deniega por capability ausente', () => {
    expect(
      authorize({ actor: actor(['alerts.read']), capability: 'alerts.triage', resource: alert }),
    ).toMatchObject({ allowed: false, reason: 'CAPABILITY_MISSING' });
  });

  it('deniega un recurso de otro tenant antes de mirar la capability', () => {
    const decision = authorize({
      actor: actor(['alerts.triage']),
      capability: 'alerts.triage',
      resource: { ...alert, tenantId: 'tenant-2' },
    });

    expect(decision).toMatchObject({ allowed: false, reason: 'TENANT_MISMATCH' });
  });

  it('deniega al analista que no tiene asignado el recurso', () => {
    expect(
      authorize({
        actor: actor(['alerts.triage']),
        capability: 'alerts.triage',
        resource: { ...alert, assigneeId: 'otro-analista' },
        requiresAssignment: true,
      }),
    ).toMatchObject({ allowed: false, reason: 'RESOURCE_NOT_ASSIGNED' });
  });

  it('deniega escribir sobre un recurso cerrado', () => {
    expect(
      authorize({
        actor: actor(['incidents.write']),
        capability: 'incidents.write',
        resource: { type: 'incident', id: 'inc-1', tenantId: 'tenant-1', closed: true },
        rejectWhenClosed: true,
      }),
    ).toMatchObject({ allowed: false, reason: 'RESOURCE_CLOSED' });
  });

  it('deniega sin sesión resuelta', () => {
    expect(
      authorize({
        actor: actor(['alerts.read'], { sessionId: '' }),
        capability: 'alerts.read',
        resource: alert,
      }),
    ).toMatchObject({ allowed: false, reason: 'SESSION_INVALID' });
  });

  it('entrega siempre un motivo auditable en la denegación', () => {
    const decision = authorize({
      actor: actor([]),
      capability: 'alerts.read',
      resource: alert,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.detail.length).toBeGreaterThan(0);
  });
});

describe('C-18 · autorización por campo', () => {
  it('oculta el crudo a quien no tiene events.read_raw', () => {
    const capabilities = capabilitiesForRoles(['qapaq.soc.analyst']);

    expect(visibleFields(['id', 'severity', 'raw'], capabilities)).toEqual(['id', 'severity']);
    expect(projectFields({ id: 'e1', raw: { ref: 'raw:1' } }, capabilities)).toEqual({ id: 'e1' });
  });

  it('proyecta el crudo al rol que sí lo tiene', () => {
    const capabilities = capabilitiesForRoles(['qapaq.soc.lead']);

    expect(projectFields({ id: 'e1', raw: { ref: 'raw:1' } }, capabilities)).toEqual({
      id: 'e1',
      raw: { ref: 'raw:1' },
    });
  });

  it('omite el campo en lugar de enviarlo nulo', () => {
    const projected = projectFields({ id: 'e1', rawRef: 'raw:1' }, new Set<Capability>());

    expect(Object.hasOwn(projected, 'rawRef')).toBe(false);
  });
});
