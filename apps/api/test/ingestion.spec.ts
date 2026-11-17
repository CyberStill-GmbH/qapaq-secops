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

function wazuhRecordToEventId(record: ProviderRecord): string {
  const converted = wazuhRecordToEvent(record, KEY.tenantId, KEY.sourceId);
  if (converted.status !== 'normalized') throw new Error('documento de prueba inválido');
  return converted.event.recordId;
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
      normalized: 3,
      promoted: 3,
      duplicates: 0,
      notPromoted: 0,
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

  it('el pull reconcilia un documento visible tarde mientras siga dentro del solape', async () => {
    const watermark = new Date('2026-10-12T17:59:00.000Z');
    const cursor = await state.claimCursor(KEY, NOW, 300_000);
    expect(cursor).toBeDefined();
    await state.advanceCursor(cursor!, watermark, NOW);
    await state.releaseCursor(cursor!);

    const late = office365Document('doc-late-within-overlap', '2026-10-12T17:58:00.000Z');
    const reader = fakeReader([late]);
    const pass = createIngestionPass({ ...base(), readPage: reader.readPage });

    await pass();

    expect(reader.calls[0]!.from).toBe('2026-10-12T17:57:00.000Z');
    expect(promoted).toEqual([wazuhRecordToEventId(late)]);
  });

  it('no promete recuperar por pull un documento anterior al límite del solape', async () => {
    const watermark = new Date('2026-10-12T17:59:00.000Z');
    const cursor = await state.claimCursor(KEY, NOW, 300_000);
    expect(cursor).toBeDefined();
    await state.advanceCursor(cursor!, watermark, NOW);
    await state.releaseCursor(cursor!);

    const late = office365Document('doc-late-outside-overlap', '2026-10-12T17:56:59.999Z');
    const reader = fakeReader([late]);
    const pass = createIngestionPass({ ...base(), readPage: reader.readPage });

    await pass();

    expect(reader.calls[0]!.from).toBe('2026-10-12T17:57:00.000Z');
    expect(promoted).not.toContain(wazuhRecordToEventId(late));
  });

  it('separa occurredAt y receivedAt sin cambiar la identidad entre push, pull y replay', () => {
    const doc = office365Document('doc-time-semantics', '2026-10-12T17:10:00.000Z');
    const first = wazuhRecordToEvent(
      doc,
      KEY.tenantId,
      KEY.sourceId,
      new Date('2026-10-12T17:11:00.000Z'),
    );
    const replay = wazuhRecordToEvent(
      { ...doc, collectedAt: '2026-10-12T17:12:00.000Z' },
      KEY.tenantId,
      KEY.sourceId,
      new Date('2026-10-12T17:13:00.000Z'),
    );

    expect(first.status).toBe('normalized');
    expect(replay.status).toBe('normalized');
    if (first.status !== 'normalized' || replay.status !== 'normalized') return;
    expect(first.event.recordId).toBe(replay.event.recordId);
    expect(first.event.occurredAt).toBe('2026-10-12T17:10:00.000Z');
    expect(first.event.receivedAt).toBe('2026-10-12T17:11:00.000Z');
    expect(replay.event.receivedAt).toBe('2026-10-12T17:13:00.000Z');
    expect(replay.event.observedAt).toBe('2026-10-12T17:12:00.000Z');
  });

  it('un poll vacío también queda observado como éxito', async () => {
    const pass = createIngestionPass({ ...base(), readPage: fakeReader([]).readPage });
    await pass();
    const [observation] = await state.recentObservations(KEY, 1);
    expect(observation).toMatchObject({ outcome: 'success', recordsSeen: 0, newestEventAt: null });
  });

  it('separa alertas creadas, duplicados y eventos sin promoción', async () => {
    const docs = [
      office365Document('created', '2026-10-12T17:10:00.000Z'),
      office365Document('duplicate', '2026-10-12T17:11:00.000Z'),
      office365Document('below-threshold', '2026-10-12T17:12:00.000Z'),
      office365Document('suppressed', '2026-10-12T17:13:00.000Z'),
    ];
    const recordIds = docs.map(wazuhRecordToEventId);
    const pass = createIngestionPass({
      ...base(),
      readPage: fakeReader(docs).readPage,
      promote: async (event) =>
        event.recordId === recordIds[0]
          ? 'promoted'
          : event.recordId === recordIds[1]
            ? 'duplicate'
            : event.recordId === recordIds[2]
              ? 'below_threshold'
              : 'suppressed',
    });

    await pass();
    const [observation] = await state.recentObservations(KEY, 1);
    expect(observation).toMatchObject({
      recordsSeen: 4,
      normalized: 4,
      promoted: 1,
      duplicates: 1,
      notPromoted: 2,
      belowThreshold: 1,
      suppressed: 1,
      quarantined: 0,
    });
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

  it('un hueco de más de una ventana sin eventos no deja la marca clavada', async () => {
    // Marca en un evento de hace 20 h; el siguiente evento llegó hace 10 min. Cada ventana
    // (1 h) intermedia está vacía o solo contiene lo ya leído: la marca tiene que avanzar
    // tramo a tramo hasta alcanzar el evento nuevo.
    const old = office365Document('doc-viejo', '2026-10-11T22:00:00.000Z');
    const fresh = office365Document('doc-nuevo', '2026-10-12T17:50:00.000Z');
    const reader = fakeReader([old, fresh]);
    const claim = await state.claimCursor(KEY, NOW, 1);
    await state.advanceCursor(claim!, new Date(old.occurredAt!));
    await state.releaseCursor(claim!);
    const pass = createIngestionPass({ ...base(), readPage: reader.readPage });
    let passes = 0;
    while ((await pass()) === 1 && passes < 50) passes += 1;
    expect(passes).toBeLessThan(50);
    expect(promoted).toContain(wazuhRecordToEventId(fresh));
    const cursor = state.cursors.get(`${KEY.tenantId}|${KEY.sourceId}|${KEY.dataset}`);
    expect(cursor?.watermark?.toISOString()).toBe('2026-10-12T17:50:00.000Z');
  });

  it('un solape con más eventos que el tope no deja la marca clavada (2026-11-13)', async () => {
    // 12 eventos dentro del solape (≤ marca) superan el tope de 10 (5 páginas × 2): antes cada
    // pasada releía solo el solape y los eventos posteriores nunca se ingerían.
    const watermark = new Date('2026-10-12T17:50:00.000Z');
    const burst = Array.from({ length: 12 }, (_, index) =>
      office365Document(
        `burst-${index}`,
        `2026-10-12T17:4${index < 10 ? 8 : 9}:${String(10 + index).padStart(2, '0')}.000Z`,
      ),
    );
    const atMark = office365Document('at-mark', watermark.toISOString());
    const fresh = office365Document('after-mark', '2026-10-12T17:55:00.000Z');
    const reader = fakeReader([...burst, atMark, fresh]);
    const claim = await state.claimCursor(KEY, NOW, 1);
    await state.advanceCursor(claim!, watermark);
    await state.releaseCursor(claim!);
    const pass = createIngestionPass({ ...base(), readPage: reader.readPage });

    let passes = 0;
    while ((await pass()) === 1 && passes < 5) passes += 1;

    expect(promoted).toContain(wazuhRecordToEventId(fresh));
    const cursor = state.cursors.get(`${KEY.tenantId}|${KEY.sourceId}|${KEY.dataset}`);
    expect(cursor?.watermark?.toISOString()).toBe('2026-10-12T17:55:00.000Z');
  });

  it('reanuda con search_after durable cuando más eventos comparten la marca que el tope', async () => {
    const watermark = new Date('2026-10-12T17:50:00.000Z');
    const tied = Array.from({ length: 12 }, (_, index) =>
      office365Document(`tied-${index}`, watermark.toISOString()),
    );
    const reader = fakeReader(tied);
    const claim = await state.claimCursor(KEY, NOW, 300_000);
    await state.advanceCursor(claim!, watermark, NOW);
    await state.releaseCursor(claim!);
    const pass = createIngestionPass({ ...base(), readPage: reader.readPage });

    expect(await pass()).toBe(1);
    expect(
      state.cursors.get(`${KEY.tenantId}|${KEY.sourceId}|${KEY.dataset}`)?.continuation,
    ).toMatchObject({ from: watermark, cursor: '10' });
    expect(await pass()).toBe(0);
    expect(reader.calls.at(-1)?.cursor).toBe('10');
    expect(new Set(promoted).size).toBe(12);
    expect(
      state.cursors.get(`${KEY.tenantId}|${KEY.sourceId}|${KEY.dataset}`)?.continuation,
    ).toBeNull();
  });

  it('reinicia el rango fijo si expira el token search_after guardado', async () => {
    const watermark = new Date('2026-10-12T17:50:00.000Z');
    const to = new Date('2026-10-12T17:59:30.000Z');
    const tied = Array.from({ length: 12 }, (_, index) =>
      office365Document(`expired-${index}`, watermark.toISOString()),
    );
    const reader = fakeReader(tied);
    const claim = await state.claimCursor(KEY, NOW, 300_000);
    await state.advanceCursor(claim!, watermark, NOW);
    await state.saveContinuation(claim!, { from: watermark, to, cursor: 'expired-token' }, NOW);
    await state.releaseCursor(claim!);
    const readPage = async (query: EventQuery) => {
      if (query.cursor === 'expired-token') {
        throw Object.assign(new Error('cursor expired'), { code: 'PROVIDER_CURSOR_EXPIRED' });
      }
      return reader.readPage(query);
    };
    const pass = createIngestionPass({ ...base(), readPage });

    expect(await pass()).toBe(1);
    expect(reader.calls[0]?.from).toBe(watermark.toISOString());
    expect(await pass()).toBe(0);
    expect(new Set(promoted).size).toBe(12);
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
