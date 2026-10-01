import { describe, expect, it } from 'vitest';

import {
  buildProjectionDocument,
  decideProjection,
  PROJECTION_VERSION,
} from '../src/event-projection.js';
import {
  EVENTS_READ,
  EVENTS_READ_RAW,
  planQuery,
  QUERY_LIMITS,
  shapeEventForReader,
  shapePage,
  type ReaderContext,
} from '../src/event-query.js';
import { normalizeWazuhAlert } from '../src/wazuh-normalization.js';

const AT = new Date('2026-10-01T10:00:00.000Z');

function sampleEvent() {
  const outcome = normalizeWazuhAlert(
    {
      record: {
        sourceRecordId: 'evt-77',
        dataset: 'alerts',
        collectedAt: '2026-10-01T09:59:30.000Z',
        raw: {
          timestamp: '2026-10-01T09:59:00.000Z',
          rule: {
            id: 5716,
            level: 10,
            description: 'Intento de autenticación fallido',
            groups: ['sshd', 'authentication_failed'],
          },
          agent: { id: '003', name: 'srv-app-01.qapaq.local' },
          data: { srcuser: 'jperez@qapaq.pe' },
        },
      },
      raw: {
        ref: 'raw:tenant-1/2026/10/01/evt-77',
        sha256: 'b'.repeat(64),
        mediaType: 'application/json',
        sizeBytes: 512,
      },
    },
    {
      tenantId: 'tenant-1',
      instanceId: 'siem-1',
      connector: 'qapaq-wazuh-indexer',
      connectorVersion: '1.0.0',
      receivedAt: AT,
    },
  );
  if (outcome.status !== 'normalized') throw new Error('fixture inválido');
  return outcome.event;
}

const reader: ReaderContext = {
  tenantId: 'tenant-1',
  capabilities: new Set([EVENTS_READ]),
};

const baseQuery = { from: '2026-09-25T00:00:00Z', to: '2026-10-01T00:00:00Z' };

describe('C-14 proyección', () => {
  it('construye un documento consultable sin el contenido crudo', () => {
    const document = buildProjectionDocument(sampleEvent());

    expect(document.id).toBe(sampleEvent().recordId);
    expect(document.projectionVersion).toBe(PROJECTION_VERSION);
    expect(document.severity).toBe('high');
    expect(document.category).toEqual(['authentication']);
    expect(document.principals).toEqual(['jperez@qapaq.pe']);
    expect(document.resources).toEqual(['srv-app-01.qapaq.local']);
    // Referencia y huella sí; contenido jamás.
    expect(document.rawRef).toBe('raw:tenant-1/2026/10/01/evt-77');
    expect(JSON.stringify(document)).not.toContain('"timestamp"');
    expect(JSON.stringify(document)).not.toContain('srcuser');
  });

  it('el identificador del documento es el del evento, de modo que reproyectar no duplica', () => {
    const first = buildProjectionDocument(sampleEvent());
    const second = buildProjectionDocument(sampleEvent());
    expect(first.id).toBe(second.id);
    expect(first).toEqual(second);
  });

  it('no reescribe una proyección ya al día', () => {
    const decision = decideProjection(sampleEvent(), {
      id: sampleEvent().recordId,
      projectionVersion: PROJECTION_VERSION,
    });
    expect(decision).toEqual({ effect: 'skip', reason: 'ALREADY_CURRENT' });
  });

  it('reindexa de forma explícita una proyección de versión anterior', () => {
    const decision = decideProjection(sampleEvent(), {
      id: sampleEvent().recordId,
      projectionVersion: '0.9.0',
    });
    if (decision.effect !== 'reindex') throw new Error('se esperaba reindexación');
    expect(decision.from).toBe('0.9.0');
    expect(decision.document.projectionVersion).toBe(PROJECTION_VERSION);
  });

  it('indexa un evento que no existía', () => {
    expect(decideProjection(sampleEvent(), undefined).effect).toBe('index');
  });
});

describe('C-14 autorización de la consulta', () => {
  it('deniega por defecto a quien no tiene la capability de lectura', () => {
    const plan = planQuery(baseQuery, { tenantId: 'tenant-1', capabilities: new Set() });
    expect(plan).toEqual({ ok: false, rejection: { code: 'UNAUTHORIZED', field: 'capabilities' } });
  });

  it('el tenant sale del lector, no de la petición', () => {
    const plan = planQuery(
      { ...baseQuery, ...({ tenantId: 'tenant-ajeno' } as Record<string, unknown>) },
      reader,
    );
    if (!plan.ok) throw new Error('se esperaba plan válido');
    expect(plan.query.tenantId).toBe('tenant-1');
  });

  it('sin capability de crudo la consulta no lo incluye', () => {
    const plan = planQuery(baseQuery, reader);
    if (!plan.ok) throw new Error('se esperaba plan válido');
    expect(plan.query.includeRaw).toBe(false);
  });

  it('con capability explícita de crudo sí lo incluye', () => {
    const plan = planQuery(baseQuery, {
      tenantId: 'tenant-1',
      capabilities: new Set([EVENTS_READ, EVENTS_READ_RAW]),
    });
    if (!plan.ok) throw new Error('se esperaba plan válido');
    expect(plan.query.includeRaw).toBe(true);
  });
});

describe('C-14 límites de la consulta', () => {
  it('aplica el tamaño de página por defecto', () => {
    const plan = planQuery(baseQuery, reader);
    if (!plan.ok) throw new Error('se esperaba plan válido');
    expect(plan.query.pageSize).toBe(QUERY_LIMITS.defaultPageSize);
  });

  it('acepta exactamente el máximo', () => {
    const plan = planQuery({ ...baseQuery, pageSize: QUERY_LIMITS.maximumPageSize }, reader);
    expect(plan.ok).toBe(true);
  });

  it('rechaza en vez de recortar en silencio un tamaño mayor al máximo', () => {
    const plan = planQuery({ ...baseQuery, pageSize: QUERY_LIMITS.maximumPageSize + 1 }, reader);
    expect(plan).toEqual({
      ok: false,
      rejection: { code: 'PAGE_SIZE_EXCEEDED', field: 'pageSize' },
    });
  });

  it.each([0, -1, 1.5])('rechaza un tamaño de página inválido: %s', (pageSize) => {
    const plan = planQuery({ ...baseQuery, pageSize }, reader);
    if (plan.ok) throw new Error('se esperaba rechazo');
    expect(plan.rejection.code).toBe('PAGE_SIZE_INVALID');
  });

  it('exige una ventana temporal', () => {
    expect(planQuery({}, reader)).toEqual({
      ok: false,
      rejection: { code: 'RANGE_REQUIRED', field: 'range' },
    });
  });

  it('rechaza una ventana invertida', () => {
    const plan = planQuery({ from: '2026-10-01T00:00:00Z', to: '2026-09-01T00:00:00Z' }, reader);
    if (plan.ok) throw new Error('se esperaba rechazo');
    expect(plan.rejection.code).toBe('RANGE_INVERTED');
  });

  it('rechaza una ventana que degeneraría en barrido completo', () => {
    const plan = planQuery({ from: '2025-01-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }, reader);
    if (plan.ok) throw new Error('se esperaba rechazo');
    expect(plan.rejection.code).toBe('RANGE_TOO_WIDE');
  });

  it.each([
    ['severity', { severity: ['altísima'] }],
    ['category', { category: ['no_existe'] }],
    ['kind', { kind: ['cosa'] }],
    ['outcome', { outcome: ['quizá'] }],
  ])('rechaza un valor desconocido en el filtro %s', (field, filter) => {
    const plan = planQuery({ ...baseQuery, ...filter }, reader);
    if (plan.ok) throw new Error('se esperaba rechazo');
    expect(plan.rejection).toEqual({ code: 'FILTER_VALUE_UNKNOWN', field });
  });

  it('acepta y deduplica filtros válidos', () => {
    const plan = planQuery({ ...baseQuery, severity: ['high', 'high', 'critical'] }, reader);
    if (!plan.ok) throw new Error('se esperaba plan válido');
    expect(plan.query.severity).toEqual(['high', 'critical']);
  });
});

describe('C-14 forma del resultado: raw oculto por defecto', () => {
  it('elimina la referencia al crudo para un lector sin capability', () => {
    const plan = planQuery(baseQuery, reader);
    if (!plan.ok) throw new Error('se esperaba plan válido');

    const shaped = shapeEventForReader(sampleEvent(), plan.query);

    expect('raw' in shaped).toBe(false);
    expect(JSON.stringify(shaped)).not.toContain('raw:tenant-1');
    // El resto del evento sí llega completo.
    expect(shaped.eventUid).toBe(sampleEvent().eventUid);
    expect(shaped.severity.normalized).toBe('high');
  });

  it('entrega la referencia al crudo solo con capability explícita', () => {
    const plan = planQuery(baseQuery, {
      tenantId: 'tenant-1',
      capabilities: new Set([EVENTS_READ, EVENTS_READ_RAW]),
    });
    if (!plan.ok) throw new Error('se esperaba plan válido');

    const shaped = shapeEventForReader(sampleEvent(), plan.query);
    expect(shaped.raw?.ref).toBe('raw:tenant-1/2026/10/01/evt-77');
  });

  it('la página entera respeta la regla, no solo el primer elemento', () => {
    const plan = planQuery(baseQuery, reader);
    if (!plan.ok) throw new Error('se esperaba plan válido');

    const page = shapePage([sampleEvent(), sampleEvent(), sampleEvent()], plan.query, 'cursor-2');

    expect(page.events).toHaveLength(3);
    expect(page.events.every((event) => !('raw' in event))).toBe(true);
    expect(page.nextCursor).toBe('cursor-2');
    expect(page.pageSize).toBe(QUERY_LIMITS.defaultPageSize);
  });
});
