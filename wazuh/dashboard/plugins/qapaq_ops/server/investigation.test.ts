/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import {
  eventOf,
  findEvent,
  findRelated,
  findSource,
  nearest,
  relatedQuery,
  sourceQuery,
} from './investigation';
import type { SearchClient } from './overview';
import { groupExactEmailMessages } from '../common/investigation';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const hit = (id: string, timestamp: string, extra: Json = {}) => ({
  _id: id,
  _index: 'wazuh-alerts-4.x-2026.11.08',
  _source: {
    timestamp,
    agent: { id: '000', name: 'wazuh.manager' },
    rule: {
      id: '101503',
      level: 5,
      description: 'QAPAQ Cloudflare: cambio DNS',
      groups: ['cloudflare'],
      mitre: { id: ['T1584.002'], tactic: ['Resource Development'], technique: ['DNS Server'] },
    },
    data: { cloudflare: { zone_name: 'qapaq.pe' } },
    ...extra,
  } as Json,
});

function client(responses: unknown[], seen: Json[] = []): SearchClient {
  return {
    search: async (params) => {
      seen.push(params);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { body: next };
    },
  };
}

describe('evento de origen', () => {
  it('busca por regla, descripción y ±5 min, y elige el más cercano', async () => {
    const seen: Json[] = [];
    const result = await findSource(
      client(
        [
          {
            hits: {
              hits: [
                hit('a', '2026-11-08T14:50:00.000+0000'),
                hit('b', '2026-11-08T14:57:31.925+0000'),
              ],
            },
          },
        ],
        seen,
      ),
      {
        ruleId: '101503',
        at: '2026-11-08T14:57:31.925Z',
        description: 'QAPAQ Cloudflare: cambio DNS',
      },
    );
    expect(result.match).toBe('matched');
    expect(result.event?.id).toBe('b');
    expect(result.event?.vendor).toBe('cloudflare');
    expect(result.event?.mitre.ids).toEqual(['T1584.002']);
    expect(seen[0].index).toBe('wazuh-alerts-*');
    expect(JSON.stringify(seen[0].body)).toContain(
      '"rule.description":"QAPAQ Cloudflare: cambio DNS"',
    );
  });

  it('reintenta sin descripción si no hay coincidencia exacta', async () => {
    const seen: Json[] = [];
    const result = await findSource(
      client(
        [{ hits: { hits: [] } }, { hits: { hits: [hit('c', '2026-11-08T14:57:00.000+0000')] } }],
        seen,
      ),
      { ruleId: '101503', at: '2026-11-08T14:57:31.925Z', description: 'otra' },
    );
    expect(seen).toHaveLength(2);
    expect(result.event?.id).toBe('c');
  });

  it('un 403 del Security plugin es «forbidden», no un error', async () => {
    const forbidden = Object.assign(new Error('no'), { statusCode: 403 });
    const result = await findSource(client([forbidden]), {
      ruleId: '1',
      at: '2026-11-08T00:00:00Z',
    });
    expect(result).toEqual({ access: 'forbidden', match: 'none', event: null });
  });

  it('sin regla ni id no consulta', () => {
    expect(sourceQuery({ at: '2026-11-08T00:00:00Z' })).toBeNull();
  });

  it('recorta documentos enormes', () => {
    const event = eventOf(hit('d', '2026-11-08T00:00:00.000+0000', { note: 'x'.repeat(70000) }));
    expect(event.rawTruncated).toBe(true);
    expect(JSON.stringify(event.raw).length).toBeLessThan(2000);
  });

  it('omite campos de log aunque sean cortos en eventos que no son M365', () => {
    const event = eventOf(
      hit('short-log', '2026-11-08T00:00:00.000+0000', {
        full_log: 'token=short-secret',
        nested: { previous_output: 'password=short-secret', retained: 'metadata' },
      }),
    );

    expect(event.rawTruncated).toBe(false);
    expect(JSON.stringify(event.raw)).not.toContain('short-secret');
    expect(event.raw).toMatchObject({ nested: { retained: 'metadata' } });
  });

  it('aplica el tope al tamaño UTF-8 de los documentos multibyte', () => {
    const event = eventOf(
      hit('unicode-log', '2026-11-08T00:00:00.000+0000', { note: '🙂'.repeat(20_000) }),
    );

    expect(event.rawTruncated).toBe(true);
    expect(JSON.stringify(event.raw).length).toBeLessThan(2000);
  });

  it('mantiene JSON expandible y omite campos M365 descartados de la proyección canónica', async () => {
    const raw = {
      Operation: 'New-InboxRule',
      UserId: 'analista@qapaq-lab.example',
      Parameters: [{ Name: 'ForwardTo', Value: 'externo@example.test' }],
      ModifiedProperties: [{ Name: 'ForwardingSmtpAddress', NewValue: 'externo@example.test' }],
      response: { body: 'contenido de prueba' },
      SafeMetadata: 'conservado',
    };
    const sourceHit = hit('m365-source', '2026-11-08T00:00:00.000+0000', {
      full_log: 'm365-top-level-short-secret',
      previous_output: 'm365-previous-short-secret',
      data: { office365: raw },
    });

    const source = await findSource(client([{ hits: { hits: [sourceHit] } }]), {
      id: 'm365-source',
    });
    const expanded = await findEvent(client([{ hits: { hits: [sourceHit] } }]), 'm365-source');
    const serialized = JSON.stringify([source.event?.raw, expanded.event?.raw]);

    expect(serialized).toContain('New-InboxRule');
    expect(serialized).toContain('SafeMetadata');
    expect(serialized).not.toContain('Parameters');
    expect(serialized).not.toContain('ModifiedProperties');
    expect(serialized).not.toContain('externo@example.test');
    expect(serialized).not.toContain('contenido de prueba');
    expect(serialized).not.toContain('m365-top-level-short-secret');
    expect(serialized).not.toContain('m365-previous-short-secret');
    expect(sourceHit._source.full_log).toBe('m365-top-level-short-secret');
    expect(sourceHit._source.previous_output).toBe('m365-previous-short-secret');
    expect(sourceHit._source.data.office365.Parameters).toEqual(raw.Parameters);
    expect(sourceHit._source.data.office365.ModifiedProperties).toEqual(raw.ModifiedProperties);
    expect(sourceHit._source.data.office365.response).toEqual(raw.response);
  });

  it('nearest sin hora devuelve el primero', () => {
    expect(nearest([{ _id: 'x' }, { _id: 'y' }])).toEqual({ _id: 'x' });
  });
});

describe('eventos relacionados', () => {
  it('consulta cualquier campo de las entidades en la ventana y excluye el origen', () => {
    const body = relatedQuery({
      entities: [{ kind: 'zone', value: 'qapaq.pe' }],
      at: Date.parse('2026-11-08T12:00:00Z'),
      window: '1h',
      excludeId: 'src',
    }) as Json;
    expect(body.query.bool.filter[0].range.timestamp).toEqual({
      gte: '2026-11-08T11:00:00.000Z',
      lte: '2026-11-08T13:00:00.000Z',
    });
    expect(body.query.bool.should).toHaveLength(2);
    expect(body.query.bool.must_not).toEqual([{ ids: { values: ['src'] } }]);
    expect(Object.keys(body.aggs.perEntity.filters.filters)).toEqual(['zone:qapaq.pe']);
    expect(body._source.excludes).toEqual([
      'full_log',
      'data.office365.Parameters',
      'data.office365.ModifiedProperties',
      'data.office365.response',
      'previous_output',
    ]);
  });

  it('pagina con tamaño fijo, orden estable y cursor search_after sobre el mismo filtro', () => {
    const first = relatedQuery({
      entities: [{ kind: 'zone', value: 'qapaq.pe' }],
      at: Date.parse('2026-11-08T12:00:00Z'),
      window: '1h',
    }) as Json;
    const next = relatedQuery({
      entities: [{ kind: 'zone', value: 'qapaq.pe' }],
      at: Date.parse('2026-11-08T12:00:00Z'),
      window: '1h',
      searchAfter: [Date.parse('2026-11-08T12:00:00.000Z'), 'id-100'],
    }) as Json;
    expect(first.size).toBe(100);
    expect(first.sort).toEqual([
      { timestamp: { order: 'desc' } },
      { id: { order: 'asc', unmapped_type: 'keyword' } },
    ]);
    expect(first.search_after).toBeUndefined();
    expect(next.search_after).toEqual([Date.parse('2026-11-08T12:00:00.000Z'), 'id-100']);
    // Sin PIT: el de wazuh-alerts-* abarca un índice por día y no cabe en el cursor de URL.
    expect(next.pit).toBeUndefined();
    expect(next.query).toEqual(first.query);
    expect(next._source).toEqual(first._source);
  });

  it('emite cursor ligado a filtros y rechaza su reutilización con otra entidad', async () => {
    const seen: Json[] = [];
    const rows = Array.from({ length: 100 }, (_, index) => {
      const item = hit(`event-${index}`, '2026-11-08T12:00:00.000Z');
      return { ...item, sort: [Date.parse('2026-11-08T12:00:00.000Z'), `id-${index}`] };
    });
    const first = await findRelated(
      client(
        [
          {
            hits: { total: { value: 101 }, hits: rows },
            aggregations: { perEntity: { buckets: {} } },
          },
        ],
        seen,
      ),
      {
        entities: [{ kind: 'zone', value: 'qapaq.pe' }],
        at: Date.parse('2026-11-08T12:00:00Z'),
        window: '1h',
      },
    );
    expect(first.events).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    expect(() =>
      findRelated(client([], seen), {
        entities: [{ kind: 'zone', value: 'other.io' }],
        at: Date.parse('2026-11-08T12:00:00Z'),
        window: '1h',
        cursor: first.nextCursor ?? undefined,
      }),
    ).toThrow('Cursor de investigacion no valido.');
    expect(seen).toHaveLength(1);
  });

  it('continúa con el cursor y deja de ofrecerlo al alcanzar el total real', async () => {
    const seen: Json[] = [];
    const firstRows = Array.from({ length: 100 }, (_, index) => {
      const item = hit(`event-${index}`, '2026-11-08T12:00:00.000Z');
      return { ...item, sort: [Date.parse('2026-11-08T12:00:00.000Z'), `id-${index}`] };
    });
    const secondRows = [
      {
        ...hit('event-100', '2026-11-08T11:59:00.000Z'),
        sort: [Date.parse('2026-11-08T11:59:00.000Z'), `id-${100}`],
      },
    ];
    const search = client(
      [
        {
          hits: { total: { value: 101 }, hits: firstRows },
          aggregations: { perEntity: { buckets: {} } },
        },
        {
          hits: { total: { value: 101 }, hits: secondRows },
          aggregations: { perEntity: { buckets: {} } },
        },
      ],
      seen,
    );
    const params = {
      entities: [{ kind: 'zone' as const, value: 'qapaq.pe' }],
      at: Date.parse('2026-11-08T12:00:00Z'),
      window: '1h' as const,
    };
    const first = await findRelated(search, params);
    const second = await findRelated(search, { ...params, cursor: first.nextCursor ?? undefined });
    expect(second.events.map((event) => event.id)).toEqual(['event-100']);
    expect(second.nextCursor).toBeNull();
    expect(seen[0].index).toBe('wazuh-alerts-*');
    expect(seen[0].body.pit).toBeUndefined();
    expect(seen[1].body.search_after).toEqual([Date.parse('2026-11-08T12:00:00.000Z'), 'id-99']);
  });

  it('preserva el cursor ante un error transitorio y permite reintentar la misma página', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      ...hit(`event-${index}`, '2026-11-08T12:00:00.000Z'),
      sort: [Date.parse('2026-11-08T12:00:00.000Z'), `id-${index}`],
    }));
    const last = {
      ...hit('event-100', '2026-11-08T11:59:00.000Z'),
      sort: [Date.parse('2026-11-08T11:59:00.000Z'), `id-${100}`],
    };
    const failure = Object.assign(new Error('timeout'), { statusCode: 503 });
    const search = client([
      { hits: { total: { value: 101 }, hits: rows }, aggregations: { perEntity: { buckets: {} } } },
      failure,
      {
        hits: { total: { value: 101 }, hits: [last] },
        aggregations: { perEntity: { buckets: {} } },
      },
    ]);
    const params = {
      entities: [{ kind: 'zone' as const, value: 'qapaq.pe' }],
      at: Date.parse('2026-11-08T12:00:00Z'),
      window: '1h' as const,
    };
    const first = await findRelated(search, params);
    const failedPage = await findRelated(search, {
      ...params,
      cursor: first.nextCursor ?? undefined,
    });
    const retriedPage = await findRelated(search, {
      ...params,
      cursor: first.nextCursor ?? undefined,
    });

    expect(first.events).toHaveLength(100);
    expect(failedPage.access).toBe('error');
    expect(failedPage.events).toEqual([]);
    expect(retriedPage.events.map((event) => event.id)).toEqual(['event-100']);
    expect(retriedPage.nextCursor).toBeNull();
  });

  it('rechaza un cursor con el formato antiguo (timestamp texto + _shard_doc)', () => {
    const legacy = Buffer.from(
      JSON.stringify({ filter: 'x', pitId: 'p', sort: ['2026-11-08T12:00:00.000Z', 1], count: 1 }),
    ).toString('base64url');
    expect(() =>
      findRelated(client([]), {
        entities: [{ kind: 'zone', value: 'qapaq.pe' }],
        at: Date.parse('2026-11-08T12:00:00Z'),
        window: '1h',
        cursor: legacy,
      }),
    ).toThrow('Cursor de investigacion no valido.');
  });

  it('marca qué entidades aparecen en cada evento y cuenta por entidad', async () => {
    const result = await findRelated(
      client([
        {
          hits: {
            total: { value: 1 },
            hits: [
              hit('e', '2026-11-08T12:00:00.000+0000', {
                data: {
                  cloudflare: { zone_name: 'qapaq.pe' },
                  office365: {
                    Parameters: [{ Value: 'externo@example.test' }],
                    ModifiedProperties: [{ NewValue: 'valor sensible' }],
                    response: { body: 'contenido de prueba' },
                  },
                },
              }),
            ],
          },
          aggregations: { perEntity: { buckets: { 'zone:qapaq.pe': { doc_count: 7 } } } },
        },
      ]),
      { entities: [{ kind: 'zone', value: 'qapaq.pe' }], at: Date.now(), window: '24h' },
    );
    expect(result.total).toBe(1);
    expect(result.events[0].matched).toEqual(['zone:qapaq.pe']);
    expect(result.perEntity).toEqual({ 'zone:qapaq.pe': 7 });
    expect(JSON.stringify(result.events)).not.toContain('externo@example.test');
    expect(JSON.stringify(result.events)).not.toContain('ModifiedProperties');
    expect(JSON.stringify(result.events)).not.toContain('contenido de prueba');
  });

  it('proyecta correo opcional, pivota por destinatario y oculta el crudo de Exchange', async () => {
    const mail = {
      Operation: 'Send',
      MailboxOwnerUPN: 'mailbox-owner@example.test',
      recipientList: [
        { Address: 'recipient@example.test', Name: 'Recipient' },
        { Address: 'recipient-two@example.test', Name: 'Recipient Two' },
      ],
      recipientCount: 2,
      InternetMessageId: '<message-1@example.test>',
      NetworkMessageId: 'ABCDEF01-2345-6789-ABCD-EF0123456789',
      Parameters: [{ Name: 'Body', Value: 'secret text' }],
      ModifiedProperties: [{ Name: 'ForwardTo', NewValue: 'secret recipient' }],
      response: { body: 'secret body' },
    };
    const sourceHit = hit('mail-event', '2026-11-08T12:00:00.000Z', {
      data: { office365: mail },
    });
    const event = eventOf(sourceHit);
    expect(event.email).toEqual({
      internetMessageId: '<message-1@example.test>',
      networkMessageId: 'abcdef01-2345-6789-abcd-ef0123456789',
      mailboxOwnerUpn: 'mailbox-owner@example.test',
      recipients: ['recipient@example.test', 'recipient-two@example.test'],
      recipientCount: 2,
      operation: 'Send',
    });
    expect(event.entities.map(({ value }) => value)).toContain('recipient@example.test');
    const rawText = JSON.stringify(event.raw);
    expect(rawText).not.toContain('recipient@example.test');
    expect(rawText).not.toContain('secret text');
    expect(rawText).not.toContain('secret recipient');
    expect(rawText).not.toContain('secret body');

    const seen: Json[] = [];
    const receiveHit = hit('receive-event', '2026-11-08T12:00:02.000Z', {
      data: {
        office365: {
          Operation: 'Receive',
          MailboxOwnerUPN: 'recipient@example.test',
          InternetMessageId: '<message-1@example.test>',
          NetworkMessageId: 'abcdef01-2345-6789-abcd-ef0123456789',
        },
      },
    });
    const related = await findRelated(
      client(
        [
          {
            hits: {
              total: { value: 2 },
              hits: [
                { ...sourceHit, sort: [Date.parse('2026-11-08T12:00:00.000Z'), `id-${1}`] },
                { ...receiveHit, sort: [Date.parse('2026-11-08T12:00:02.000Z'), `id-${2}`] },
              ],
            },
            aggregations: {
              perEntity: { buckets: { 'user:recipient@example.test': { doc_count: 2 } } },
            },
          },
        ],
        seen,
      ),
      {
        entities: [{ kind: 'user', value: 'recipient@example.test' }],
        at: Date.parse('2026-11-08T12:00:00Z'),
        window: '1h',
      },
    );
    expect(seen[0].body.query.bool.should).toContainEqual({
      term: { 'data.office365.recipientList.Address': 'recipient@example.test' },
    });
    expect(related.events).toHaveLength(2);
    expect(related.events.map(({ matched }) => matched)).toEqual([
      ['user:recipient@example.test'],
      ['user:recipient@example.test'],
    ]);
    expect(related.events.map(({ email }) => email?.operation)).toEqual(['Send', 'Receive']);
    expect(new Set(related.events.map(({ email }) => email?.networkMessageId))).toEqual(
      new Set(['abcdef01-2345-6789-abcd-ef0123456789']),
    );
    expect(groupExactEmailMessages(related.events)).toMatchObject([
      {
        idType: 'NetworkMessageId',
        id: 'abcdef01-2345-6789-abcd-ef0123456789',
        events: [{ email: { operation: 'Send' } }, { email: { operation: 'Receive' } }],
      },
    ]);
  });

  it('declara el truncamiento de destinatarios en el DTO sin filtrar lista completa al crudo', () => {
    const recipients = Array.from({ length: 60 }, (_, index) => ({
      Address: `worker${index}@example.test`,
      Name: `Worker ${index}`,
    }));
    const event = eventOf(
      hit('large-mail', '2026-11-08T12:00:00.000Z', {
        data: { office365: { recipientCount: 60, recipientList: recipients } },
      }),
    );
    expect(event.email?.recipients).toHaveLength(50);
    expect(event.email?.recipientCount).toBe(60);
    expect(event.email?.recipientsTruncated).toBe(true);
    expect(JSON.stringify(event.raw)).not.toContain('worker0@example.test');
    expect(JSON.stringify(event.raw)).not.toContain('worker59@example.test');
  });
});
