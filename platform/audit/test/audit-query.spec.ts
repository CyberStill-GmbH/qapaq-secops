import { describe, expect, it } from 'vitest';

import { sealAuditEvent, type AuditEventDraft } from '../src/audit-event.js';
import {
  AUDIT_QUERY_LIMITS,
  AUDIT_READ,
  AUDIT_READ_SENSITIVE,
  planAuditQuery,
  projectAuditEvent,
  REDACTED,
} from '../src/audit-query.js';

const AT = new Date('2026-10-07T12:00:00.000Z');

const sealed = sealAuditEvent(
  {
    id: '0199bf00-0000-7000-8000-000000000001',
    tenantId: 'tenant-1',
    occurredAt: AT,
    actor: { id: 'analyst-1', type: 'user', sessionId: 'sess-1', ip: '10.10.1.5' },
    action: 'access.session.open',
    resource: { type: 'session', id: 'sess-1' },
    outcome: 'succeeded',
    correlationId: 'corr-1',
    metadata: {
      clientId: 'bff',
      refreshToken: 'eyJ-secreto',
      nested: { apiKey: 'abc', safe: 'visible' },
    },
  } satisfies AuditEventDraft,
  undefined,
);

const reader = (capabilities: readonly string[]) => ({
  tenantId: 'tenant-1',
  capabilities: new Set(capabilities),
});

const range = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' };

describe('C-19 · consulta autorizada y redactada', () => {
  it('deniega sin la capability de lectura de auditoría', () => {
    const plan = planAuditQuery(range, reader(['events.read']));

    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.rejection.code).toBe('UNAUTHORIZED');
  });

  it('acota la página y la ventana', () => {
    expect(
      planAuditQuery(
        { ...range, pageSize: AUDIT_QUERY_LIMITS.maximumPageSize + 1 },
        reader([AUDIT_READ]),
      ),
    ).toMatchObject({ ok: false, rejection: { code: 'PAGE_SIZE_EXCEEDED' } });
    expect(planAuditQuery({ pageSize: 10 }, reader([AUDIT_READ]))).toMatchObject({
      ok: false,
      rejection: { code: 'RANGE_REQUIRED' },
    });
    expect(planAuditQuery({ from: range.to, to: range.from }, reader([AUDIT_READ]))).toMatchObject({
      ok: false,
      rejection: { code: 'RANGE_INVERTED' },
    });
    expect(
      planAuditQuery(
        { from: '2020-01-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' },
        reader([AUDIT_READ]),
      ),
    ).toMatchObject({ ok: false, rejection: { code: 'RANGE_TOO_WIDE' } });
  });

  it('rechaza valores de filtro desconocidos en lugar de ignorarlos', () => {
    expect(planAuditQuery({ ...range, outcome: ['exploded'] }, reader([AUDIT_READ]))).toMatchObject(
      { ok: false, rejection: { code: 'FILTER_VALUE_UNKNOWN', field: 'outcome' } },
    );
  });

  it('fija el tenant del lector y no el de la petición', () => {
    const plan = planAuditQuery(
      { ...range, resourceId: 'otro' },
      { tenantId: 'tenant-9', capabilities: new Set([AUDIT_READ]) },
    );

    expect(plan.ok && plan.query.tenantId).toBe('tenant-9');
    expect(plan.ok && plan.query.includeSensitive).toBe(false);
  });

  it('redacta sesión, IP y metadata sensible sin la capability específica', () => {
    const projection = projectAuditEvent(sealed, { includeSensitive: false });

    expect(projection.actor.ip).toBe(REDACTED);
    expect(projection.actor.sessionId).toBe(REDACTED);
    expect(projection.metadata).toMatchObject({
      clientId: 'bff',
      refreshToken: REDACTED,
      nested: { apiKey: REDACTED, safe: 'visible' },
    });
    expect(JSON.stringify(projection)).not.toContain('eyJ-secreto');
  });

  it('entrega el contenido íntegro al lector con capability sensible', () => {
    const plan = planAuditQuery(range, reader([AUDIT_READ, AUDIT_READ_SENSITIVE]));
    const projection = projectAuditEvent(sealed, {
      includeSensitive: plan.ok && plan.query.includeSensitive,
    });

    expect(projection.actor.ip).toBe('10.10.1.5');
    expect(projection.metadata).toMatchObject({ refreshToken: 'eyJ-secreto' });
  });

  it('no altera el registro sellado al redactar la proyección', () => {
    const before = sealed.hash;
    projectAuditEvent(sealed, { includeSensitive: false });

    expect(sealed.hash).toBe(before);
    expect(sealed.metadata).toMatchObject({ refreshToken: 'eyJ-secreto' });
  });
});
