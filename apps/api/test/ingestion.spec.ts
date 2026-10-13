/**
 * Sprint 5 · fase 0 — ingesta de fuentes hacia el SOC.
 *
 * Fija las propiedades que hacen segura la lectura periódica del Indexer:
 * - la marca de agua avanza solo con páginas completas y nunca retrocede;
 * - releer el solape no duplica alertas (identidad estable por documento);
 * - un error deja observación con código neutral y no avanza la marca;
 * - otra réplica con el lease vigente no lee;
 * - un poll exitoso vacío también queda observado (base de la salud por fuente).
 *
 * Los documentos son sintéticos (dominios `.example`, IPs RFC 5737).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { EventQuery, ProviderRecord, SecurityEventProvider } from '@qapaq/connectors';
import { InMemoryIngestionState, type InMemorySoc } from '@qapaq/soc';

import { buildApi } from '../src/bootstrap.js';
import { createIngestionPass } from '../src/runtime/ingestion-poller.js';
import type { SecOpsRuntime } from '../src/runtime/secops-runtime.js';
import { wazuhRecordToEvent } from '../src/runtime/wazuh-ingestion.js';

const NOW = new Date('2026-10-12T18:00:00.000Z');
const KEY = { tenantId: 'tenant-ingesta', sourceId: 'wazuh-indexer', dataset: 'wazuh-alerts' };

function office365Document(id: string, timestamp: string): ProviderRecord {
  return {
    sourceRecordId: id,
    dataset: 'wazuh-alerts',
    occurredAt: timestamp,
    collectedAt: NOW.toISOString(),
    metadata: {},
    raw: {
      timestamp,
      id,
      rule: {
        id: '100510',
        level: 12,
        description: 'Office 365: regla de bandeja que reenvía correo',
        groups: ['office365', 'qapaq_persistence'],
      },
      agent: { id: '000', name: 'wazuh-manager' },
      data: {
        integration: 'office365',
        office365: {
          CreationTime: timestamp.slice(0, 19),
          Operation: 'New-InboxRule',
          Workload: 'Exchange',
          RecordType: 1,
          ResultStatus: 'True',
          UserId: 'usuario.sintetico@qapaq-lab.example',
          ClientIP: '203.0.113.24:51544',
          Parameters: [{ Name: 'ForwardTo', Value: 'externo@dominio-ajeno.example' }],
        },
      },
    },
  };
}

/** Proveedor falso que pagina una lista fija dentro de la ventana pedida. */
function fakeReader(documents: readonly ProviderRecord[], pageSize = 2) {
  const calls: EventQuery[] = [];
  const readPage = async (query: EventQuery) => {
    calls.push(query);
    const inWindow = documents.filter(
      (doc) => doc.occurredAt! >= query.from && doc.occurredAt! <= query.to,
    );
    const offset = query.cursor ? Number(query.cursor) : 0;
    const items = inWindow.slice(offset, offset + pageSize);
    const hasMore = offset + pageSize < inWindow.length;
    return { items, hasMore, ...(hasMore ? { nextCursor: String(offset + pageSize) } : {}) };
  };
  return { readPage, calls };
}

describe('pasada de ingesta', () => {
  let state: InMemoryIngestionState;
  const promoted: string[] = [];
  const base = () => ({
    key: KEY,
    state,
    toEvent: (record: ProviderRecord) => wazuhRecordToEvent(record, KEY.tenantId, KEY.sourceId),
    promote: async (event: { recordId: string }) => {
      promoted.push(event.recordId);
      return 'promoted' as const;
    },
    window: {
      lagMs: 30_000,
      overlapMs: 120_000,
      initialLookbackMs: 3_600_000,
      maximumWindowMs: 3_600_000,
    },
    pageSize: 2,
    maximumPages: 5,
    leaseMs: 300_000,
    now: () => NOW,
  });

  beforeEach(() => {
    state = new InMemoryIngestionState();
    promoted.length = 0;
  });

  it('lee la ventana inicial, promueve, avanza la marca y registra éxito', async () => {
    const docs = [
      office365Document('doc-1', '2026-10-12T17:10:00.000Z'),
      office365Document('doc-2', '2026-10-12T17:20:00.000Z'),
      office365Document('doc-3', '2026-10-12T17:30:00.000Z'),
    ];
    const reader = fakeReader(docs);
    const pass = createIngestionPass({ ...base(), readPage: reader.readPage });

    expect(await pass()).toBe(0);
    expect(promoted).toHaveLength(3);
    expect(reader.calls[0]).toMatchObject({
      from: '2026-10-12T17:00:00.000Z',
      to: '2026-10-12T17:59:30.000Z',
    });
    const [observation] = await state.recentObservations(KEY, 1);
    expect(observation).toMatchObject({
      outcome: 'success',
      recordsSeen: 3,
      promoted: 3,
      errorClass: null,
    });
    expect(observation!.newestEventAt?.toISOString()).toBe('2026-10-12T17:30:00.000Z');
    const cursor = state.cursors.get(`${KEY.tenantId}|${KEY.sourceId}|${KEY.dataset}`);
    expect(cursor?.watermark?.toISOString()).toBe('2026-10-12T17:30:00.000Z');
    expect(cursor?.claimId).toBeNull();
  });

  it('releer el solape produce la misma identidad de evento', async () => {
    const doc = office365Document('doc-1', '2026-10-12T17:10:00.000Z');
    const first = wazuhRecordToEvent(doc, KEY.tenantId, KEY.sourceId);
    // Otra lectura: otra hora de recolección y otro orden de claves en el documento.
    const again = wazuhRecordToEvent(
      {
        ...doc,
        collectedAt: '2026-10-12T18:05:00.000Z',
        raw: Object.fromEntries(Object.entries(doc.raw).reverse()),
      },
      KEY.tenantId,
      KEY.sourceId,
    );
    expect(first.status).toBe('normalized');
    expect(again.status).toBe('normalized');
    if (first.status !== 'normalized' || again.status !== 'normalized') return;
    expect(again.event.recordId).toBe(first.event.recordId);
    expect(first.event.raw.ref).toBe('raw:wazuh/wazuh-alerts/doc-1');
  });

  it('un poll vacío también queda observado como éxito', async () => {
    const pass = createIngestionPass({ ...base(), readPage: fakeReader([]).readPage });
    await pass();
    const [observation] = await state.recentObservations(KEY, 1);
    expect(observation).toMatchObject({ outcome: 'success', recordsSeen: 0, newestEventAt: null });
  });

  it('un error queda con código neutral, no avanza la marca y libera el lease', async () => {
    const failing = async () => {
      throw Object.assign(new Error('upstream dijo algo con datos internos'), {
        code: 'PROVIDER_TIMEOUT',
        retryable: true,
      });
    };
    const pass = createIngestionPass({ ...base(), readPage: failing });
    await expect(pass()).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    const [observation] = await state.recentObservations(KEY, 1);
    expect(observation).toMatchObject({
      outcome: 'retryable_error',
      errorClass: 'PROVIDER_TIMEOUT',
      recordsSeen: 0,
    });
    const cursor = state.cursors.get(`${KEY.tenantId}|${KEY.sourceId}|${KEY.dataset}`);
    expect(cursor?.watermark).toBeNull();
    expect(cursor?.claimId).toBeNull();
  });

  it('con el lease tomado por otra réplica no lee nada', async () => {
    await state.claimCursor(KEY, NOW, 300_000);
    const reader = fakeReader([office365Document('doc-1', '2026-10-12T17:10:00.000Z')]);
    const pass = createIngestionPass({ ...base(), readPage: reader.readPage });
    expect(await pass()).toBe(0);
    expect(reader.calls).toHaveLength(0);
  });

  it('con más páginas que el tope pide otra pasada sin esperar el intervalo', async () => {
    const docs = Array.from({ length: 12 }, (_, index) =>
      office365Document(
        `doc-${index}`,
        `2026-10-12T17:${String(10 + index).padStart(2, '0')}:00.000Z`,
      ),
    );
    const pass = createIngestionPass({ ...base(), readPage: fakeReader(docs).readPage });
    expect(await pass()).toBe(1);
    expect(promoted).toHaveLength(10);
  });
});

describe('ingesta Wazuh de punta a punta con el runtime', () => {
  let runtime: SecOpsRuntime;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const built = await buildApi({ QAPAQ_PROFILE: 'test' }, () => {});
    runtime = built.runtime;
    stop = built.stop;
  });

  afterAll(async () => {
    await stop();
  });

  it('un documento del Indexer termina como alerta y releerlo no la duplica', async () => {
    const { createWazuhIngestion } = await import('../src/runtime/wazuh-ingestion.js');
    // El runtime usa el reloj real: el documento cae 10 minutos antes, dentro de la ventana.
    const at = new Date(runtime.now().getTime() - 10 * 60_000).toISOString();
    const docs = [office365Document('doc-e2e', at)];
    const reader = fakeReader(docs);
    const provider = { readPage: reader.readPage } as unknown as SecurityEventProvider;
    const soc = runtime.soc as InMemorySoc;
    const tenantId = [...soc.alertRows.values()][0]?.tenantId ?? 'tenant-e2e';
    soc.alertRows.clear();

    const loop = createWazuhIngestion({
      runtime,
      tenantId,
      sourceId: 'wazuh-indexer',
      intervalMs: 60_000,
      initialLookbackMs: 3_600_000,
      onError: () => undefined,
      provider,
    });
    loop.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await loop.stop();
    expect([...soc.alertRows.values()].filter((alert) => alert.tenantId === tenantId)).toHaveLength(
      1,
    );

    // Segunda pasada sobre la misma ventana (solape): la alerta no se duplica.
    soc.ingestion.cursors.clear();
    loop.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await loop.stop();
    expect([...soc.alertRows.values()].filter((alert) => alert.tenantId === tenantId)).toHaveLength(
      1,
    );
  });
});
