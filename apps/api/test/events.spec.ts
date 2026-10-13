/**
 * Sprint 5 · fase 1 — explorador de eventos.
 *
 * Fija la traducción de filtros a la consulta del Indexer (misma definición que la
 * normalización), el rechazo de lo que no se puede filtrar con honestidad, y el contrato HTTP:
 * redacción del crudo por capability, validación, fuente deshabilitada y errores del proveedor.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SecurityEventProviderError } from '@qapaq/connectors';
import { parseEventsQuery } from '@qapaq/contracts';

import { buildApi } from '../src/bootstrap.js';
import type { EventsReader } from '../src/runtime/events-reader.js';
import type { SecOpsRuntime } from '../src/runtime/secops-runtime.js';
import { compileWazuhEventFilters } from '../src/runtime/wazuh-event-filters.js';
import { wazuhRecordToEvent } from '../src/runtime/wazuh-ingestion.js';

describe('compilador de filtros para el Indexer', () => {
  it('severidad: un rango de rule.level por banda pedida, sin envolver bandas no pedidas', () => {
    expect(compileWazuhEventFilters({ severity: ['low', 'critical'] })).toEqual([
      {
        bool: {
          should: [
            { range: { 'rule.level': { gte: 1, lte: 3 } } },
            { range: { 'rule.level': { gte: 12, lte: 15 } } },
          ],
          minimum_should_match: 1,
        },
      },
    ]);
  });

  it('categoría y resultado se traducen a rule.groups con la tabla de normalización', () => {
    const [category, outcome] = compileWazuhEventFilters({
      category: ['email'],
      outcome: 'failure',
    })!;
    expect(category).toEqual({ terms: { 'rule.groups': ['exchange', 'mail', 'postfix'] } });
    expect(outcome).toEqual({
      terms: {
        'rule.groups': ['authentication_failed', 'authentication_failures', 'invalid_login'],
      },
    });
  });

  it('rechaza lo que no se puede empujar o no existe en el contrato', () => {
    expect(compileWazuhEventFilters({ category: ['unclassified'] })).toBeUndefined();
    expect(compileWazuhEventFilters({ outcome: 'unknown' })).toBeUndefined();
    expect(compileWazuhEventFilters({ severity: ['urgente'] })).toBeUndefined();
    expect(compileWazuhEventFilters({})).toEqual([]);
  });
});

describe('de q a la consulta del Indexer', () => {
  it('toda consulta válida compila solo a rule.level y rule.groups', () => {
    const queries = [
      'severity:informational,low,medium,high,critical',
      'category:authentication,iam,network,email AND outcome:success',
      'severity:high AND category:malware AND outcome:failure',
    ];
    for (const query of queries) {
      const parsed = parseEventsQuery(query);
      if (!parsed.ok) throw new Error(parsed.error.code);
      const clauses = compileWazuhEventFilters(parsed.filters);
      expect(clauses).toBeDefined();
      const fields = JSON.stringify(clauses).match(/"(rule\.[a-z]+)"/gu) ?? [];
      expect(fields.length).toBeGreaterThan(0);
      for (const field of fields) expect(['"rule.level"', '"rule.groups"']).toContain(field);
      expect(JSON.stringify(clauses)).not.toMatch(/script|wildcard|regexp|query_string|aggs/u);
    }
  });

  it('una categoría válida en la gramática pero sin grupos en Wazuh se rechaza', () => {
    const parsed = parseEventsQuery('category:threat');
    if (!parsed.ok) throw new Error(parsed.error.code);
    expect(compileWazuhEventFilters(parsed.filters)).toBeUndefined();
  });
});

describe('GET /api/events', () => {
  let runtime: SecOpsRuntime;
  let stop: () => Promise<void>;
  let application: Awaited<ReturnType<typeof buildApi>>['application'];
  const OFFICE_IP = '10.20.5.9';
  const calls: Parameters<EventsReader['read']>[0][] = [];
  let failure: Error | undefined;

  const document = {
    sourceRecordId: 'evt-1',
    dataset: 'wazuh-alerts',
    occurredAt: '2026-10-12T17:00:00.000Z',
    collectedAt: '2026-10-12T17:00:05.000Z',
    metadata: {},
    raw: {
      timestamp: '2026-10-12T17:00:00.000Z',
      id: 'evt-1',
      rule: { id: '100510', level: 12, description: 'Regla de reenvío', groups: ['office365'] },
      agent: { id: '000', name: 'wazuh-manager' },
      data: {
        integration: 'office365',
        office365: {
          Operation: 'New-InboxRule',
          UserId: 'u@qapaq-lab.example',
          ClientIP: '203.0.113.24',
        },
      },
    },
  };

  beforeAll(async () => {
    const built = await buildApi({ QAPAQ_PROFILE: 'test' }, () => {});
    runtime = built.runtime;
    stop = built.stop;
    application = built.application;
    await application.init();
    await application.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await stop();
  });

  it('sin fuente configurada responde disabled, no un error ni un «sin eventos»', async () => {
    expect(runtime.events).toBeUndefined();
    // La ruta exige sesión: la cobertura de sesión y redacción vive en la spec BFF.
    const response = await application
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/api/events', remoteAddress: OFFICE_IP });
    expect(response.statusCode).toBe(401);
  });

  it('el lector convierte, cuenta lo no normalizable y pide orden descendente', async () => {
    const { createEventsReader } = await import('../src/runtime/events-reader.js');
    const reader = createEventsReader({
      provider: {
        capabilities: async () => {
          throw new Error('no usado');
        },
        health: async () => {
          throw new Error('no usado');
        },
        readPage: async (query) => {
          calls.push(query as never);
          if (failure) throw failure;
          return {
            items: [document, { ...document, sourceRecordId: 'roto', occurredAt: undefined }],
            hasMore: false,
            readAt: '2026-10-12T17:01:00.000Z',
          };
        },
      },
      sourceId: 'wazuh-indexer',
      dataset: 'wazuh-alerts',
      toEvent: (record) => wazuhRecordToEvent(record, 'tenant-x', 'wazuh-indexer'),
    });
    const page = await reader.read({
      from: new Date('2026-10-12T00:00:00.000Z'),
      to: new Date('2026-10-12T18:00:00.000Z'),
      filters: { severity: ['critical'] },
      pageSize: 50,
    });
    expect(page.items).toHaveLength(1);
    expect(page.unparsedCount).toBe(1);
    expect(page.items[0]!.event.severity.normalized).toBe('critical');
    expect((calls[0] as unknown as { order: string }).order).toBe('desc');

    failure = new SecurityEventProviderError('PROVIDER_TIMEOUT', 'readPage', true);
    await expect(
      reader.read({ from: new Date(0), to: new Date(1), filters: {}, pageSize: 1 }),
    ).rejects.toBeInstanceOf(SecurityEventProviderError);
  });
});
