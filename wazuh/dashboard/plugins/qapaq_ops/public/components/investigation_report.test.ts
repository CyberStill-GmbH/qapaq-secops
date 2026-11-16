/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import type { InvestigationEventSummary, RelatedResponse } from '../../common';
import { QapaqApiError } from '../api/client';
import {
  collectInvestigationReport,
  createInvestigationXlsx,
  investigationPrintHtml,
  investigationPrintHtmlWithProgress,
  writeInvestigationPrintWindowWithProgress,
  writeInvestigationXlsx,
} from './investigation_report';
import { investigationCsv, investigationCsvWithProgress } from './investigation_export';

function verifyStoredZip(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read32 = (offset: number) => view.getUint32(offset, true);
  const read16 = (offset: number) => view.getUint16(offset, true);
  const end = bytes.length - 22;
  expect(read32(end)).toBe(0x06054b50);
  expect(read16(end + 20)).toBe(0);
  const count = read16(end + 10);
  const centralOffset = read32(end + 16);
  const centralSize = read32(end + 12);
  const decoder = new TextDecoder();
  const names: string[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    expect(read32(cursor)).toBe(0x02014b50);
    expect(read16(cursor + 8)).toBe(0x0808);
    expect(read16(cursor + 10)).toBe(0);
    const crc = read32(cursor + 16);
    const size = read32(cursor + 24);
    const nameLength = read16(cursor + 28);
    const extraLength = read16(cursor + 30);
    const commentLength = read16(cursor + 32);
    const localOffset = read32(cursor + 42);
    const name = decoder.decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    names.push(name);

    expect(read32(localOffset)).toBe(0x04034b50);
    expect(read16(localOffset + 6)).toBe(0x0808);
    expect(read32(localOffset + 14)).toBe(0);
    expect(read32(localOffset + 18)).toBe(0);
    expect(read32(localOffset + 22)).toBe(0);
    const localNameLength = read16(localOffset + 26);
    const localExtraLength = read16(localOffset + 28);
    expect(decoder.decode(bytes.slice(localOffset + 30, localOffset + 30 + localNameLength))).toBe(
      name,
    );
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.slice(dataStart, dataStart + size);
    let computed = 0xffffffff;
    for (const byte of data) {
      computed ^= byte;
      for (let bit = 0; bit < 8; bit += 1)
        computed = (computed >>> 1) ^ (computed & 1 ? 0xedb88320 : 0);
    }
    computed = (computed ^ 0xffffffff) >>> 0;
    const descriptor = dataStart + size;
    expect(read32(descriptor)).toBe(0x08074b50);
    expect(read32(descriptor + 4)).toBe(crc);
    expect(read32(descriptor + 8)).toBe(size);
    expect(read32(descriptor + 12)).toBe(size);
    expect(computed).toBe(crc);
    expect(read32(cursor + 20)).toBe(size);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  expect(cursor).toBe(centralOffset + centralSize);
  expect(cursor).toBe(end);
  return names;
}

function event(id: string, at = '2026-11-11T12:00:00.000Z'): InvestigationEventSummary {
  return {
    id,
    index: 'wazuh-alerts-test',
    at,
    level: 8,
    ruleId: '101700',
    description: `Acceso <sospechoso> ${id}`,
    groups: ['office365'],
    vendor: 'office365',
    agent: null,
    mitre: { ids: [], tactics: [], techniques: [] },
    matched: ['user:analyst@example.test'],
  };
}

function page(
  events: InvestigationEventSummary[],
  total: number,
  nextCursor: string | null,
): RelatedResponse {
  return {
    access: 'ok',
    from: '2026-11-10T12:00:00.000Z',
    to: '2026-11-12T12:00:00.000Z',
    total,
    events,
    nextCursor,
    pageSize: 100,
    perEntity: {},
  };
}

const query = {
  entities: [{ kind: 'user' as const, value: 'analyst@example.test' }],
  at: '2026-11-11T12:00:00.000Z',
  window: '24h' as const,
};

describe('reportes de investigación', () => {
  it('recorre el cursor completo y entrega progreso según filas recibidas', async () => {
    const cursors: Array<string | undefined> = [];
    const progress: number[] = [];
    const report = await collectInvestigationReport({
      query,
      alert: null,
      title: 'Investigación Office 365',
      entities: ['Usuario: analyst@example.test'],
      signal: new AbortController().signal,
      now: () => new Date('2026-11-11T13:00:00Z'),
      loadPage: async (_filters, cursor) => {
        cursors.push(cursor);
        return cursor ? page([event('e-2')], 2, null) : page([event('e-1')], 2, 'cursor-2');
      },
      onProgress: (item) => progress.push(item.completed),
    });
    expect(cursors).toEqual([undefined, 'cursor-2']);
    expect(report.events.map((item) => item.id)).toEqual(['e-1', 'e-2']);
    expect(report.totalEvents).toBe(2);
    expect(report.truncated).toBe(false);
    expect(progress).toEqual([0, 1, 2]);
  });

  it('incluye el evento de origen scrubbed, deduplica e indica el límite con honestidad', async () => {
    const report = await collectInvestigationReport({
      query,
      alert: null,
      sourceEvent: event('source'),
      title: 'Informe',
      entities: [],
      signal: new AbortController().signal,
      maximumEvents: 2,
      loadPage: async () => page([event('e-1'), event('e-2')], 3, 'more'),
    });
    expect(report.events.map((item) => item.id)).toEqual(['source', 'e-1']);
    expect(report.totalEvents).toBe(4);
    expect(report.truncated).toBe(true);
  });

  it('no cuenta dos veces el source si aparece entre los eventos relacionados', async () => {
    const report = await collectInvestigationReport({
      query,
      alert: null,
      sourceEvent: event('source'),
      title: 'Informe',
      entities: [],
      signal: new AbortController().signal,
      loadPage: async () => page([event('source'), event('e-1')], 2, null),
    });
    expect(report.events.map((item) => item.id)).toEqual(['source', 'e-1']);
    expect(report.totalEvents).toBe(2);
    expect(report.truncated).toBe(false);
  });

  it('rechaza una página a la que el usuario no tiene acceso y no produce informe parcial', async () => {
    await expect(
      collectInvestigationReport({
        query,
        alert: null,
        title: 'Informe',
        entities: [],
        signal: new AbortController().signal,
        loadPage: async () => ({ ...page([], 0, null), access: 'forbidden' }),
      }),
    ).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('reintenta un fallo transitorio del Indexer y completa el informe', async () => {
    let attempts = 0;
    const messages: string[] = [];
    const report = await collectInvestigationReport({
      query,
      alert: null,
      title: 'Informe',
      entities: [],
      signal: new AbortController().signal,
      retryDelayMs: 0,
      onProgress: (item) => messages.push(item.message),
      loadPage: async () => {
        attempts += 1;
        return attempts === 1
          ? ({ ...page([], 0, null), access: 'error' } as RelatedResponse)
          : page([event('recovered')], 1, null);
      },
    });
    expect(attempts).toBe(2);
    expect(report.events.map((item) => item.id)).toEqual(['recovered']);
    expect(messages).toContain('El Indexer no respondió; reintentando la página (1/2)');
  });

  it('tras agotar los reintentos rechaza la exportación sin devolver un resultado parcial', async () => {
    let attempts = 0;
    await expect(
      collectInvestigationReport({
        query,
        alert: null,
        title: 'Informe',
        entities: [],
        signal: new AbortController().signal,
        retryDelayMs: 0,
        loadPage: async () => {
          attempts += 1;
          return { ...page([], 0, null), access: 'error' } as RelatedResponse;
        },
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(attempts).toBe(3);
  });

  it('no presenta un rechazo HTTP de la consulta como una caída del Indexer', async () => {
    let attempts = 0;
    await expect(
      collectInvestigationReport({
        query,
        alert: null,
        title: 'Informe',
        entities: [],
        signal: new AbortController().signal,
        retryDelayMs: 0,
        loadPage: async () => {
          attempts += 1;
          throw new QapaqApiError('VALIDATION_FAILED', 400, null);
        },
      }),
    ).rejects.toMatchObject({ kind: 'rejected' });
    expect(attempts).toBe(1);
  });

  it('produce un XLSX ZIP real con hojas, celdas seguras y contenido escapado', async () => {
    const report = {
      alert: null,
      sourceEvent: event('source'),
      title: 'Informe <M365>',
      entities: ['Usuario: analyst@example.test'],
      events: [
        {
          ...event('event-1'),
          description: '=SUM(1,1)\u0001 🛡',
          email: {
            internetMessageId: '<msg@example.test>',
            networkMessageId: 'network-1',
            mailboxOwnerUpn: 'owner@example.test',
            recipients: ['recipient&one@example.test'],
            recipientCount: 120,
            recipientsTruncated: true,
            operation: 'Send',
          },
        },
        {
          ...event('event-2'),
          email: {
            networkMessageId: 'network-1',
            mailboxOwnerUpn: 'recipient@example.test',
            recipients: ['archive@example.test'],
            operation: 'MailItemsAccessed',
          },
        },
      ],
      totalEvents: 1,
      generatedAt: new Date('2026-11-11T13:00:00Z'),
      truncated: false,
      assistantAnalysis: 'Qapaqzito analysis with cited evidence',
      assistantCitations: [{ kind: 'event', id: 'preview-source', label: 'Source event' }],
    };
    const blob = await createInvestigationXlsx(report);
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(0x04034b50);
    expect(verifyStoredZip(bytes)).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        'xl/workbook.xml',
        'xl/worksheets/sheet1.xml',
        'xl/worksheets/sheet2.xml',
      ]),
    );
    const content = new TextDecoder().decode(bytes);
    expect(content).toContain('xl/workbook.xml');
    expect(content).toContain('name="Eventos"');
    expect(content).toContain('name="Actividad agrupada"');
    expect(content).toContain('name="IDs exactos de mensaje"');
    expect(content).toContain('Destinatarios distintos observados');
    expect(content).toContain('Coincidencia por ID exacto; no prueba causalidad ni hilo');
    expect(content).toContain('Dirección según operaciones explícitas');
    expect(content).toContain('Salida; Dirección no determinada');
    expect(content).toContain('owner@example.test');
    expect(content).toContain('recipient@example.test');
    expect(content).toContain('archive@example.test');
    expect(content).toContain('Informe &lt;M365&gt;');
    expect(content).toContain('=SUM(1,1)� 🛡');
    expect(content).toContain('&lt;msg@example.test&gt;');
    expect(content).toContain('recipient&amp;one@example.test');
    expect(content).toContain('Total destinatarios');
    expect(content).toContain('Lista de destinatarios truncada');
    expect(content).toContain('120');
    expect(content).toContain('Sí');
    expect(content).not.toContain('<f>');
  });

  it('reporta progreso monotónico y permite cancelar durante el render XLSX', async () => {
    const events = Array.from({ length: 1_001 }, (_, index) => event(`row-${index}`));
    const input = {
      alert: null,
      title: 'Carga de prueba',
      entities: [],
      events,
      totalEvents: events.length,
      generatedAt: new Date('2026-11-11T13:00:00Z'),
      truncated: false,
    };
    const progress: number[] = [];
    await createInvestigationXlsx(input, (item) => {
      if (item.percent !== undefined) progress.push(item.percent);
    });
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1]!)).toBe(
      true,
    );
    expect(progress[progress.length - 1]).toBe(100);

    const controller = new AbortController();
    const cancelled = createInvestigationXlsx(
      input,
      (item) => {
        if (item.phase === 'render' && item.completed >= 500) controller.abort();
      },
      controller.signal,
    );
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('escribe XLSX por partes con backpressure y cancela el destino', async () => {
    const input = {
      alert: null,
      title: 'Stream XLSX',
      entities: ['user:analyst@example.test'],
      events: [event('stream-1'), event('stream-2')],
      totalEvents: 2,
      generatedAt: new Date('2026-11-11T13:00:00Z'),
      truncated: false,
    };
    const chunks: Uint8Array[] = [];
    let closed = false;
    let aborted = false;
    let writesInFlight = 0;
    let maximumWritesInFlight = 0;
    const sink = {
      async write(chunk: Uint8Array) {
        writesInFlight += 1;
        maximumWritesInFlight = Math.max(maximumWritesInFlight, writesInFlight);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        chunks.push(chunk.slice());
        writesInFlight -= 1;
      },
      async close() {
        closed = true;
      },
      async abort() {
        aborted = true;
      },
    };
    let completedAfterClose = false;
    await writeInvestigationXlsx(input, sink, (next) => {
      if (next.percent === 100) completedAfterClose = closed;
    });
    expect(maximumWritesInFlight).toBe(1);
    expect(aborted).toBe(false);
    expect(completedAfterClose).toBe(true);
    const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    expect(verifyStoredZip(output)).toContain('xl/worksheets/sheet2.xml');

    const controller = new AbortController();
    const cancelledSink = {
      async write() {},
      async close() {},
      async abort() {
        aborted = true;
      },
    };
    await expect(
      writeInvestigationXlsx(
        input,
        cancelledSink,
        (next) => {
          if (next.phase === 'render' && next.completed > 0) controller.abort();
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(true);
  });

  it('serializa CSV con progreso por filas y permite cancelar', async () => {
    const events = Array.from({ length: 750 }, (_, index) => event(`csv-${index}`));
    const input = {
      alert: null,
      title: 'Informe CSV',
      entities: ['Usuario: analyst@example.test'],
      events,
      totalEvents: events.length,
      generatedAt: new Date('2026-11-11T13:00:00Z'),
    };
    const progress: number[] = [];
    const csv = await investigationCsvWithProgress(input, new AbortController().signal, (item) =>
      progress.push(item.completed),
    );
    expect(csv).toBe(investigationCsv(input));
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBeGreaterThan(750);

    const controller = new AbortController();
    const cancelled = investigationCsvWithProgress(input, controller.signal, (item) => {
      if (item.completed >= 250) controller.abort();
    });
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('construye PDF imprimible con progreso monotónico y permite cancelar el render HTML', async () => {
    const events = Array.from({ length: 600 }, (_, index) => event(`print-${index}`));
    const input = {
      alert: null,
      title: 'Informe PDF imprimible',
      entities: ['Usuario: analyst@example.test'],
      events,
      totalEvents: events.length,
      generatedAt: new Date('2026-11-11T13:00:00Z'),
      truncated: false,
    };
    const progress: number[] = [];
    const rendered = await investigationPrintHtmlWithProgress(
      input,
      new AbortController().signal,
      (item) => progress.push(item.completed),
    );
    expect(rendered).toBe(investigationPrintHtml(input));
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1]!)).toBe(
      true,
    );
    expect(progress.at(-1)).toBeGreaterThan(events.length);

    const controller = new AbortController();
    const cancelled = investigationPrintHtmlWithProgress(input, controller.signal, (item) => {
      if (item.completed >= 250) controller.abort();
    });
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('puebla la vista imprimible por lotes antes del dialogo de impresion', async () => {
    const input = {
      alert: null,
      title: 'Vista previa progresiva',
      entities: ['user:analyst@example.test'],
      events: Array.from({ length: 600 }, (_, index) => event(`preview-${index}`)),
      totalEvents: 600,
      generatedAt: new Date('2026-11-11T13:00:00Z'),
      truncated: false,
      assistantAnalysis: 'Análisis de Qapaqzito con evidencia citada.',
      assistantCitations: [{ kind: 'event', id: 'preview-source', label: 'Evento fuente' }],
    };
    const sections = Array.from({ length: 3 }, () => ({
      textContent: 'placeholder',
      chunks: [] as string[],
      insertAdjacentHTML(_position: string, chunk: string) {
        this.chunks.push(chunk);
      },
    }));
    let shell = '';
    let printed = false;
    const target = {
      document: {
        open() {},
        write(content: string) {
          shell = content;
        },
        close() {},
        querySelectorAll() {
          return sections;
        },
      },
      print() {
        printed = true;
      },
      setTimeout(callback: () => void) {
        callback();
        return 0;
      },
    } as unknown as Window;
    const generatedWithRows: boolean[] = [];
    await writeInvestigationPrintWindowWithProgress(
      target,
      input,
      new AbortController().signal,
      (next) => {
        if (next.phase === 'render') {
          generatedWithRows.push(sections[2]!.chunks.join('').includes('preview-0'));
        }
      },
    );
    expect(shell).toContain('<style>');
    expect(shell).not.toContain('preview-0');
    expect(shell).not.toContain('window.print');
    expect(sections[2]!.chunks.length).toBe(3);
    expect(sections[2]!.chunks.join('')).toContain('preview-0');
    expect(sections[2]!.chunks.join('')).toContain('preview-599');
    expect(generatedWithRows).toContain(true);
    expect(printed).toBe(true);
  });

  it('imprime una respuesta de Qapaqzito sin exigir tablas de investigación', async () => {
    const input = {
      alert: null,
      title: 'Respuesta de Qapaqzito',
      entities: [],
      events: [],
      totalEvents: 0,
      generatedAt: new Date('2026-11-11T13:00:00Z'),
      truncated: false,
      assistantAnalysis: 'Resumen basado únicamente en la respuesta.',
      assistantCitations: [],
    };
    let shell = '';
    let printed = false;
    const target = {
      document: {
        open() {},
        write(content: string) {
          shell = content;
        },
        close() {},
        querySelectorAll() {
          return [];
        },
      },
      print() {
        printed = true;
      },
      setTimeout(callback: () => void) {
        callback();
        return 0;
      },
    } as unknown as Window;

    await writeInvestigationPrintWindowWithProgress(target, input, new AbortController().signal);

    expect(shell).toContain('Resumen basado únicamente en la respuesta.');
    expect(shell.match(/<tbody>/gu)).toBeNull();
    expect(printed).toBe(true);
  });

  it('conserva las secciones vacías de un expediente sin eventos', async () => {
    const input = {
      alert: null,
      title: 'Expediente sin eventos',
      entities: [],
      events: [],
      totalEvents: 0,
      generatedAt: new Date('2026-11-11T13:00:00Z'),
      truncated: false,
    };
    const sections = Array.from({ length: 3 }, () => ({
      textContent: 'placeholder',
      insertAdjacentHTML() {},
    }));
    const target = {
      document: {
        open() {},
        write() {},
        close() {},
        querySelectorAll() {
          return sections;
        },
      },
      print() {},
      setTimeout(callback: () => void) {
        callback();
        return 0;
      },
    } as unknown as Window;

    await expect(
      writeInvestigationPrintWindowWithProgress(target, input, new AbortController().signal),
    ).resolves.toBeUndefined();
  });

  it('escapa el HTML para impresión y advierte que proximidad no es causalidad', () => {
    const html = investigationPrintHtml({
      alert: null,
      title: '<script>alert(1)</script>',
      entities: ['user:<analyst>'],
      events: [
        {
          ...event('event-1'),
          email: {
            internetMessageId: '<m&1>',
            networkMessageId: 'same-network-id',
            mailboxOwnerUpn: 'owner@example.test',
            recipients: ['a@example.test'],
            recipientCount: 75,
            recipientsTruncated: true,
            operation: 'Send',
          },
        },
        {
          ...event('event-2'),
          email: {
            internetMessageId: '<m&1>',
            networkMessageId: 'same-network-id',
            mailboxOwnerUpn: 'recipient@example.test',
            operation: 'MailItemsAccessed',
          },
        },
      ],
      totalEvents: 1,
      generatedAt: new Date('2026-11-11T13:00:00Z'),
      truncated: false,
    });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('no establece causalidad');
    expect(html).toContain('InternetMessageId: &lt;m&amp;1&gt;');
    expect(html).toContain('Destinatarios: a@example.test (lista truncada; 75 total)');
    expect(html).toContain('same-network-id');
    expect(html).toContain('Coincidencias por identificador exacto de mensaje');
    expect(html).toContain('Salida; Dirección no determinada');
    expect(html).toContain('owner@example.test');
    expect(html).toContain('recipient@example.test');
    expect(html).toContain('Dirección según operaciones');
    expect(html).toContain('no prueban causalidad ni un hilo');
    expect(html).not.toContain('Dirección:');
  });
});
