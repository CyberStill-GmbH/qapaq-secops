/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import type { Alert, InvestigationEventSummary, RelatedResponse } from '../../common';
import { QapaqApiError } from '../api/client';
import {
  groupExactEmailMessages,
  summarizeExactEmailMessageGroup,
} from '../../common/investigation';
import type { EntityKind, RelatedWindow } from '../../common/investigation';
import { groupInvestigationActivity } from './investigation_activity_grouping';

export const REPORT_EVENT_LIMIT = 10_000;
export const REPORT_ARTIFACT_LIMIT_BYTES = 50 * 1024 * 1024;

export type ReportEmailMetadata = NonNullable<InvestigationEventSummary['email']>;

export type ReportEventSummary = InvestigationEventSummary & {
  readonly email?: ReportEmailMetadata;
};

export interface InvestigationReportQuery {
  readonly entities: ReadonlyArray<{ readonly kind: EntityKind; readonly value: string }>;
  readonly at: string;
  readonly window: RelatedWindow;
  readonly excludeId?: string;
}

export interface InvestigationReportData {
  readonly alert: Alert | null;
  /** Scrubbed summary of the source event; full `_source` is never exported. */
  readonly sourceEvent?: ReportEventSummary | null;
  readonly title: string;
  readonly entities: readonly string[];
  readonly events: readonly ReportEventSummary[];
  readonly totalEvents: number;
  readonly generatedAt: Date;
  readonly truncated: boolean;
  /** Qapaqzito export preserves the exact validated answer and citations in the same artifact. */
  readonly assistantAnalysis?: string;
  readonly assistantCitations?: readonly {
    readonly kind: string;
    readonly id: string;
    readonly label: string;
  }[];
  /** Optional SVG created only from numeric values explicitly present in the answer. */
  readonly assistantChartSvg?: string;
  readonly assistantChartData?: {
    readonly headers: readonly string[];
    readonly rows: readonly (readonly (string | number)[])[];
  };
}

export interface ReportProgress {
  readonly phase: 'query' | 'render' | 'package';
  readonly completed: number;
  readonly total: number;
  readonly message: string;
  readonly percent?: number;
}

export type RelatedPageLoader = (
  query: InvestigationReportQuery,
  cursor: string | undefined,
  signal: AbortSignal,
) => Promise<RelatedResponse>;

export class ReportCollectionError extends Error {
  public constructor(public readonly kind: 'forbidden' | 'unavailable' | 'invalid' | 'rejected') {
    super(`No se pudo preparar el informe: ${kind}`);
    this.name = 'ReportCollectionError';
  }
}

const REPORT_PAGE_RETRIES = 2;
const REPORT_RETRY_DELAY_MS = 400;

function waitForReportRetry(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Informe cancelado', 'AbortError'));
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Informe cancelado', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Fetch every authorized search_after page; progress counts returned rows, not elapsed time. */
export async function collectInvestigationReport(input: {
  readonly query: InvestigationReportQuery;
  readonly alert: Alert | null;
  readonly sourceEvent?: InvestigationEventSummary | null;
  readonly title: string;
  readonly entities: readonly string[];
  readonly loadPage: RelatedPageLoader;
  readonly signal: AbortSignal;
  readonly now?: () => Date;
  readonly onProgress?: (progress: ReportProgress) => void;
  readonly maximumEvents?: number;
  /** Test seam; production retries use a short fixed delay. */
  readonly retryDelayMs?: number;
}): Promise<InvestigationReportData> {
  const maximum = Math.min(
    REPORT_EVENT_LIMIT,
    Math.max(1, input.maximumEvents ?? REPORT_EVENT_LIMIT),
  );
  const events = new Map<string, ReportEventSummary>();
  const sourceId = input.sourceEvent?.id;
  if (input.sourceEvent) events.set(input.sourceEvent.id, input.sourceEvent);
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let expectedTotal = 0;
  let totalEvents = 0;
  let sourceFoundInRelated = false;
  let pages = 0;
  input.onProgress?.({
    phase: 'query',
    completed: 0,
    total: 0,
    percent: 0,
    message: 'Solicitando la primera página a Wazuh Indexer',
  });
  do {
    if (input.signal.aborted) throw new DOMException('Informe cancelado', 'AbortError');
    let page: RelatedResponse | null = null;
    for (let attempt = 0; attempt <= REPORT_PAGE_RETRIES; attempt += 1) {
      try {
        const candidate = await input.loadPage(input.query, cursor, input.signal);
        if (candidate.access === 'forbidden') throw new ReportCollectionError('forbidden');
        if (candidate.access === 'ok') {
          page = candidate;
          break;
        }
      } catch (error) {
        if (input.signal.aborted || (error instanceof Error && error.name === 'AbortError'))
          throw error;
        if (error instanceof ReportCollectionError && error.kind === 'forbidden') throw error;
        if (error instanceof QapaqApiError) {
          if (error.status === 401 || error.status === 403) {
            throw new ReportCollectionError('forbidden');
          }
          if (
            error.status === 400 ||
            error.status === 404 ||
            error.status === 422 ||
            (error.status >= 400 &&
              error.status < 500 &&
              error.status !== 408 &&
              error.status !== 425 &&
              error.status !== 429)
          ) {
            throw new ReportCollectionError('rejected');
          }
        }
      }
      if (attempt === REPORT_PAGE_RETRIES) throw new ReportCollectionError('unavailable');
      input.onProgress?.({
        phase: 'query',
        completed: events.size,
        total: Math.min(totalEvents, maximum),
        percent: totalEvents === 0 ? 0 : Math.min(65, Math.floor((events.size / totalEvents) * 65)),
        message: `El Indexer no respondió; reintentando la página (${attempt + 1}/${REPORT_PAGE_RETRIES})`,
      });
      await waitForReportRetry(input.signal, input.retryDelayMs ?? REPORT_RETRY_DELAY_MS);
    }
    if (!page) throw new ReportCollectionError('unavailable');
    if (pages === 0) {
      expectedTotal = page.total;
      sourceFoundInRelated = Boolean(
        sourceId && page.events.some((event) => event.id === sourceId),
      );
      totalEvents = expectedTotal + (input.sourceEvent && !sourceFoundInRelated ? 1 : 0);
    } else if (page.total !== expectedTotal) throw new ReportCollectionError('invalid');
    if (page.events.length === 0 && page.nextCursor) throw new ReportCollectionError('invalid');
    for (const event of page.events) {
      if (sourceId && event.id === sourceId) sourceFoundInRelated = true;
      if (events.size >= maximum) break;
      if (!events.has(event.id)) events.set(event.id, event as ReportEventSummary);
    }
    pages += 1;
    input.onProgress?.({
      phase: 'query',
      completed: events.size,
      total: Math.min(totalEvents, maximum),
      message: `Consultando página ${pages}: ${events.size.toLocaleString('es-PE')} de ${totalEvents.toLocaleString('es-PE')} eventos`,
      percent: Math.min(
        65,
        totalEvents === 0 ? 65 : Math.floor((events.size / Math.min(totalEvents, maximum)) * 65),
      ),
    });
    if (events.size >= maximum) break;
    const nextCursor = page.nextCursor ?? undefined;
    if (nextCursor && seenCursors.has(nextCursor)) throw new ReportCollectionError('invalid');
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);
  if (sourceFoundInRelated) totalEvents = expectedTotal;

  return {
    alert: input.alert,
    sourceEvent: input.sourceEvent,
    title: input.title,
    entities: input.entities,
    events: [...events.values()],
    totalEvents,
    generatedAt: (input.now ?? (() => new Date()))(),
    truncated: events.size < totalEvents,
  };
}

function xml(value: unknown): string {
  return Array.from(String(value ?? ''), (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint === 0x9 ||
      codePoint === 0xa ||
      codePoint === 0xd ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
      ? character
      : '\uFFFD';
  })
    .join('')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    n -= 1;
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26);
  }
  return name;
}

type Cell = string | number;
type Sheet = {
  readonly name: string;
  readonly rows: readonly (readonly Cell[])[] | (() => Iterable<readonly Cell[]>);
  readonly rowCount?: number;
  readonly columnCount?: number;
  readonly autoFilter?: boolean;
};

type WritableSink = {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
};

function sheetRows(sheet: Sheet): Iterable<readonly Cell[]> {
  return typeof sheet.rows === 'function' ? sheet.rows() : sheet.rows;
}

function sheetRowCount(sheet: Sheet): number {
  return sheet.rowCount ?? (typeof sheet.rows === 'function' ? 0 : sheet.rows.length);
}

function sheetColumnCount(sheet: Sheet): number {
  if (sheet.columnCount) return sheet.columnCount;
  return typeof sheet.rows === 'function' ? 1 : Math.max(1, ...sheet.rows.map((row) => row.length));
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Generación cancelada', 'AbortError');
}

function crc32Update(initial: number, bytes: Uint8Array): number {
  let crc = initial;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc >>> 0;
}

function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}
function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

type ZipEntry = { name: Uint8Array; crc: number; size: number; offset: number };

/** ZIP32 stored writer. Each entry uses a data descriptor so bytes can be written before CRC/size are known. */
class ZipStoredWriter {
  private readonly encoder = new TextEncoder();
  private readonly entries: ZipEntry[] = [];
  private offset = 0;

  public constructor(private readonly sink: WritableSink) {}

  private async writeRaw(bytes: Uint8Array): Promise<void> {
    if (
      this.offset + bytes.length > REPORT_ARTIFACT_LIMIT_BYTES ||
      this.offset + bytes.length >= 0xffffffff
    ) {
      throw new Error('XLSX export exceeds the 50 MiB local artifact limit.');
    }
    await this.sink.write(bytes);
    this.offset += bytes.length;
  }

  public async writeFile(path: string, body: string, signal?: AbortSignal): Promise<void> {
    const entry = await this.beginEntry(path, signal);
    await this.writeEntryText(entry, body, signal);
    await this.finishEntry(entry, signal);
  }

  public async beginEntry(path: string, signal?: AbortSignal): Promise<ZipEntry> {
    abortIfNeeded(signal);
    if (this.entries.length >= 0xffff)
      throw new Error('El XLSX excede el límite ZIP32 de archivos.');
    const name = this.encoder.encode(path);
    const localOffset = this.offset;
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    u32(view, 0, 0x04034b50);
    u16(view, 4, 20);
    u16(view, 6, 0x0808); // UTF-8 + data descriptor follows the streamed content.
    u16(view, 8, 0); // Stored, no compression.
    u16(view, 10, 0);
    u16(view, 12, 0);
    u32(view, 14, 0);
    u32(view, 18, 0);
    u32(view, 22, 0);
    u16(view, 26, name.length);
    u16(view, 28, 0);
    local.set(name, 30);
    await this.writeRaw(local);
    return { name, crc: 0xffffffff, size: 0, offset: localOffset };
  }

  public async writeEntryText(entry: ZipEntry, text: string, signal?: AbortSignal): Promise<void> {
    abortIfNeeded(signal);
    const bytes = this.encoder.encode(text);
    if (entry.size + bytes.length > 0xffffffff)
      throw new Error('Una hoja XLSX excede el límite ZIP32.');
    entry.crc = crc32Update(entry.crc, bytes);
    entry.size += bytes.length;
    await this.writeRaw(bytes);
  }

  public async finishEntry(entry: ZipEntry, signal?: AbortSignal): Promise<void> {
    abortIfNeeded(signal);
    const checksum = (entry.crc ^ 0xffffffff) >>> 0;
    const descriptor = new Uint8Array(16);
    const descriptorView = new DataView(descriptor.buffer);
    u32(descriptorView, 0, 0x08074b50);
    u32(descriptorView, 4, checksum);
    u32(descriptorView, 8, entry.size);
    u32(descriptorView, 12, entry.size);
    await this.writeRaw(descriptor);
    this.entries.push({ ...entry, crc: checksum });
  }

  public async finish(signal?: AbortSignal): Promise<void> {
    abortIfNeeded(signal);
    const centralOffset = this.offset;
    let centralSize = 0;
    for (const entry of this.entries) {
      const directory = new Uint8Array(46 + entry.name.length);
      const view = new DataView(directory.buffer);
      u32(view, 0, 0x02014b50);
      u16(view, 4, 20);
      u16(view, 6, 20);
      u16(view, 8, 0x0808);
      u16(view, 10, 0);
      u16(view, 12, 0);
      u16(view, 14, 0);
      u32(view, 16, entry.crc);
      u32(view, 20, entry.size);
      u32(view, 24, entry.size);
      u16(view, 28, entry.name.length);
      u16(view, 30, 0);
      u16(view, 32, 0);
      u16(view, 34, 0);
      u16(view, 36, 0);
      u32(view, 38, 0);
      u32(view, 42, entry.offset);
      directory.set(entry.name, 46);
      await this.writeRaw(directory);
      centralSize += directory.length;
    }
    if (centralSize > 0xffffffff || centralOffset > 0xffffffff) {
      throw new Error('El directorio XLSX excede el límite ZIP32.');
    }
    const end = new Uint8Array(22);
    const view = new DataView(end.buffer);
    u32(view, 0, 0x06054b50);
    u16(view, 4, 0);
    u16(view, 6, 0);
    u16(view, 8, this.entries.length);
    u16(view, 10, this.entries.length);
    u32(view, 12, centralSize);
    u32(view, 16, centralOffset);
    u16(view, 20, 0);
    await this.writeRaw(end);
  }
}

function workbookFiles(sheets: readonly Sheet[]): { path: string; body: string }[] {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, i) => `<sheet name="${xml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF263444"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  return [
    { path: '[Content_Types].xml', body: contentTypes },
    {
      path: '_rels/.rels',
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    { path: 'xl/workbook.xml', body: workbook },
    { path: 'xl/_rels/workbook.xml.rels', body: rels },
    { path: 'xl/styles.xml', body: styles },
  ];
}

async function buildInvestigationSheets(
  input: InvestigationReportData,
  onProgress?: (progress: ReportProgress) => void,
  signal?: AbortSignal,
): Promise<Sheet[]> {
  const eventHeader: readonly Cell[] = [
    'Fecha y hora UTC',
    'Nivel',
    'Origen',
    'Regla',
    'Descripci\u00f3n',
    'Entidades coincidentes',
    'Internet Message ID',
    'Network Message ID',
    'Buz\u00f3n',
    'Destinatarios',
    'Total destinatarios',
    'Lista de destinatarios truncada',
    'Operaci\u00f3n de auditor\u00eda',
    'ID de evento',
  ];
  const total = input.events.length;
  onProgress?.({
    phase: 'render',
    completed: 0,
    total,
    percent: 0,
    message: 'Preparando las hojas del libro XLSX',
  });
  const si = 'S' + String.fromCharCode(237);
  const eventRows = (): Iterable<readonly Cell[]> =>
    (function* () {
      yield eventHeader;
      for (const event of input.events) {
        abortIfNeeded(signal);
        const email = emailMetadataOf(event);
        yield [
          event.at,
          event.level,
          event.vendor,
          event.ruleId,
          event.description,
          event.matched.join(' | '),
          email?.internetMessageId ?? '',
          email?.networkMessageId ?? '',
          email?.mailboxOwnerUpn ?? '',
          email?.recipients?.join(' | ') ?? '',
          email?.recipientCount ?? '',
          email?.recipientsTruncated ? si : 'No',
          email?.operation ?? '',
          event.id,
        ];
      }
    })();
  const groups = groupInvestigationActivity(input.events);
  const exactEmailGroups = groupExactEmailMessages(input.events);
  const investigationSheets: Sheet[] = [
    {
      name: 'Resumen',
      rows: [
        ['QAPAQ SecOps · Informe de investigación'],
        ['Investigación', input.title],
        ['Generado (UTC)', input.generatedAt.toISOString()],
        ['Eventos exportados', input.events.length],
        ['Eventos encontrados', input.totalEvents],
        ['Grupos con identificador de mensaje exacto', exactEmailGroups.length],
        [
          'Informe truncado por límite',
          input.truncated ? 'Sí · refinar filtros para completar' : 'No',
        ],
        ['Alerta QAPAQ', input.alert?.id ?? ''],
        ['Evento Wazuh de origen', input.sourceEvent?.id ?? ''],
        ['Entidades', input.entities.join(' | ')],
        [
          'Criterio de actividad',
          'Entidad coincidente y proximidad temporal; no confirma causalidad ni hilo de correo.',
        ],
        [
          'Criterio de mensaje',
          'NetworkMessageId exacto; si no existe, InternetMessageId exacto. No determina dirección ni hilo.',
        ],
      ],
    },
    {
      name: 'Eventos',
      rows: eventRows,
      rowCount: total + 1,
      columnCount: eventHeader.length,
      autoFilter: true,
    },
    {
      name: 'Actividad agrupada',
      autoFilter: true,
      rows: () =>
        (function* () {
          yield [
            'Entidad coincidente',
            'Primera actividad UTC',
            '\u00daltima actividad UTC',
            'Eventos',
            'Or\u00edgenes',
            'Reglas',
            'IDs de evento',
            'Interpretaci\u00f3n',
          ];
          for (const group of groups) {
            yield [
              group.entity,
              group.firstAt,
              group.lastAt,
              group.events.length,
              [...new Set(group.events.map((event) => event.vendor))].sort().join(' | '),
              [...new Set(group.events.map((event) => event.ruleId))].sort().join(' | '),
              group.events.map((event) => event.id).join(' | '),
              'Proximidad temporal; no determina causalidad ni hilo de correo',
            ];
          }
        })(),
      rowCount: groups.length + 1,
      columnCount: 8,
    },
    {
      name: 'IDs exactos de mensaje',
      autoFilter: true,
      rows: () =>
        (function* () {
          yield [
            'Tipo de identificador',
            'Identificador exacto',
            'Direcci\u00f3n seg\u00fan operaciones expl\u00edcitas',
            'Eventos',
            'Buzones auditados (MailboxOwnerUPN)',
            'Destinatarios presentes en el DTO allowlisted',
            'Destinatarios distintos observados (conteo mínimo si hay recorte)',
            'Lista de destinatarios truncada',
            'Operaciones auditadas',
            'IDs de evento',
            'Interpretaci\u00f3n',
          ];
          for (const group of exactEmailGroups) {
            const evidence = summarizeExactEmailMessageGroup(group);
            yield [
              group.idType,
              group.id,
              evidence.direction,
              group.events.length,
              evidence.auditedMailboxes.join(' | '),
              evidence.recipients.join(' | '),
              evidence.recipientCount,
              evidence.recipientsTruncated ? 'S\u00ed' : 'No',
              evidence.operations.join(' | '),
              group.events.map((event) => event.id).join(' | '),
              'Coincidencia por ID exacto; no prueba causalidad ni hilo',
            ];
          }
        })(),
      rowCount: exactEmailGroups.length + 1,
      columnCount: 11,
    },
  ];
  const sheets: Sheet[] =
    input.assistantAnalysis === undefined || input.events.length > 0 || input.alert !== null
      ? investigationSheets
      : [];
  if (input.assistantAnalysis !== undefined) {
    sheets.unshift({
      name: 'Análisis Qapaqzito',
      rows: [
        ['QAPAQ SecOps · Análisis de Qapaqzito'],
        ['Título', input.title],
        ['Generado (UTC)', input.generatedAt.toISOString()],
        ['Respuesta validada'],
        ...input.assistantAnalysis.split(/\r?\n/u).map((line) => [line]),
        [],
        ['Fuentes citadas'],
        ['Tipo', 'ID', 'Referencia'],
        ...(input.assistantCitations ?? []).map((citation) => [
          citation.kind,
          citation.id,
          citation.label,
        ]),
      ],
    });
    if (input.assistantChartSvg) {
      sheets.unshift({
        name: 'Datos del gráfico',
        rows: [
          ['Datos numéricos explícitos de Qapaqzito'],
          ['El gráfico visual se incluye en el PDF imprimible.'],
          [...(input.assistantChartData?.headers ?? [])],
          ...(input.assistantChartData?.rows ?? []).map((row) => [...row]),
        ],
      });
    }
  }
  abortIfNeeded(signal);
  return sheets;
}

function worksheetRow(row: readonly Cell[], rowIndex: number): string {
  const cells = row
    .map((value, colIndex) => {
      const ref = `${columnName(colIndex)}${rowIndex}`;
      const style = rowIndex === 1 ? ' s="1"' : '';
      if (typeof value === 'number' && Number.isFinite(value)) {
        return `<c r="${ref}"${style}><v>${value}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
    })
    .join('');
  return `<row r="${rowIndex}">${cells}</row>`;
}

async function writeWorksheet(
  zip: ZipStoredWriter,
  sheet: Sheet,
  sheetIndex: number,
  rowOffset: number,
  totalRows: number,
  signal?: AbortSignal,
  onProgress?: (progress: ReportProgress) => void,
): Promise<void> {
  const rowsTotal = sheetRowCount(sheet);
  const columns = sheetColumnCount(sheet);
  const lastRow = Math.max(1, rowsTotal);
  const dimension = `A1:${columnName(columns - 1)}${lastRow}`;
  const entry = await zip.beginEntry(`xl/worksheets/sheet${sheetIndex}.xml`, signal);
  await zip.writeEntryText(
    entry,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><sheetData>`,
    signal,
  );
  let rowIndex = 0;
  let rowParts: string[] = [];
  const flush = async () => {
    if (rowParts.length === 0) return;
    abortIfNeeded(signal);
    const chunk = rowParts.join('');
    rowParts = [];
    await zip.writeEntryText(entry, chunk, signal);
    onProgress?.({
      phase: 'render',
      completed: rowOffset + rowIndex,
      total: totalRows,
      percent: 75 + Math.floor(((rowOffset + rowIndex) / Math.max(1, totalRows)) * 15),
      message: `Escribiendo hoja ${sheetIndex}: ${rowIndex.toLocaleString('es-PE')} de ${rowsTotal.toLocaleString('es-PE')} filas`,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };
  for (const row of sheetRows(sheet)) {
    abortIfNeeded(signal);
    rowIndex += 1;
    rowParts.push(worksheetRow(row, rowIndex));
    if (rowParts.length >= 250) await flush();
  }
  await flush();
  await zip.writeEntryText(
    entry,
    `</sheetData>${sheet.autoFilter ? `<autoFilter ref="A1:${columnName(columns - 1)}${lastRow}"/>` : ''}</worksheet>`,
    signal,
  );
  await zip.finishEntry(entry, signal);
}

/** Stream the workbook to a file destination. Only ZIP headers and the bounded central directory stay buffered. */
export async function writeInvestigationXlsx(
  input: InvestigationReportData,
  sink: WritableSink,
  onProgress?: (progress: ReportProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const sheets = await buildInvestigationSheets(input, onProgress, signal);
    const zip = new ZipStoredWriter(sink);
    for (const file of workbookFiles(sheets)) await zip.writeFile(file.path, file.body, signal);
    const totalRows = sheets.reduce((sum, sheet) => sum + sheetRowCount(sheet), 0);
    let rowOffset = 0;
    for (const [index, sheet] of sheets.entries()) {
      await writeWorksheet(zip, sheet, index + 1, rowOffset, totalRows, signal, onProgress);
      rowOffset += sheetRowCount(sheet);
    }
    await zip.finish(signal);
    await sink.close();
    onProgress?.({
      phase: 'package',
      completed: 1,
      total: 1,
      percent: 100,
      message: 'Libro XLSX escrito en el destino seleccionado',
    });
  } catch (error) {
    try {
      await sink.abort?.(error);
    } catch {
      // Keep the generation/write failure as the primary error.
    }
    throw error;
  }
}

/** Memory fallback for browsers without File System Access; this deliberately buffers the complete XLSX Blob. */
export async function createInvestigationXlsx(
  input: InvestigationReportData,
  onProgress?: (progress: ReportProgress) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const parts: Uint8Array[] = [];
  const sink: WritableSink = {
    async write(chunk) {
      parts.push(chunk.slice());
    },
    async close() {},
    async abort() {
      parts.length = 0;
    },
  };
  await writeInvestigationXlsx(input, sink, onProgress, signal);
  return new Blob(parts, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

function html(value: unknown): string {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function emailMetadataOf(event: InvestigationEventSummary): ReportEmailMetadata | undefined {
  return event.email;
}

/** Print-ready report; the browser's native print dialog can save this exact view as PDF. */
function eventPrintRow(input: InvestigationReportData, event: ReportEventSummary): string {
  const email = emailMetadataOf(event);
  const mailValues = [
    email?.internetMessageId ? `InternetMessageId: ${email.internetMessageId}` : '',
    email?.networkMessageId ? `NetworkMessageId: ${email.networkMessageId}` : '',
    email?.mailboxOwnerUpn ? `Buzón: ${email.mailboxOwnerUpn}` : '',
    email?.recipients?.length
      ? `Destinatarios: ${email.recipients.join(', ')}${email.recipientsTruncated ? ` (lista truncada; ${email.recipientCount ?? 'al menos'} total)` : ''}`
      : '',
    email?.recipientsTruncated && !email.recipients?.length
      ? `Destinatarios: lista truncada (${email.recipientCount ?? 'total desconocido'})`
      : '',
    email?.operation ? `Operación: ${email.operation}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return `<tr><td>${event.id === input.sourceEvent?.id ? 'Origen' : 'Relacionado'}</td><td>${html(event.at)}</td><td>${html(event.level)}</td><td>${html(event.vendor)}</td><td>${html(event.ruleId)}</td><td>${html(event.description)}</td><td>${html(event.matched.join(' · '))}</td><td>${html(mailValues)}</td><td class="mono">${html(event.id)}</td></tr>`;
}

function activityPrintRow(group: ReturnType<typeof groupInvestigationActivity>[number]): string {
  const vendors = [...new Set(group.events.map((event) => event.vendor))].sort().join(', ');
  return `<tr><td>${html(group.entity)}</td><td>${html(group.firstAt)}</td><td>${html(group.lastAt)}</td><td>${group.events.length}</td><td>${html(vendors)}</td></tr>`;
}

function exactEmailPrintRow(group: ReturnType<typeof groupExactEmailMessages>[number]): string {
  const evidence = summarizeExactEmailMessageGroup(group);
  const recipients = evidence.recipients.join(', ') || 'No provistos en los eventos';
  const recipientCount = evidence.recipientsTruncated
    ? `al menos ${evidence.recipientCount.toLocaleString('es-PE')}`
    : evidence.recipientCount.toLocaleString('es-PE');
  const truncation = `${evidence.recipientsTruncated ? 'Sí; la lista está truncada' : 'No'} (${recipientCount} destinatarios distintos observados)`;
  return `<tr><td>${html(group.idType)}</td><td class="mono">${html(group.id)}</td><td>${html(evidence.direction)}</td><td>${group.events.length}</td><td>${html(evidence.auditedMailboxes.join(', ') || 'No provisto')}</td><td>${html(recipients)}<br/><small>Lista truncada: ${html(truncation)}</small></td><td>${html(evidence.operations.join(', ') || 'No provista')}</td><td>${html(group.events.map((event) => event.id).join(' · '))}</td></tr>`;
}

interface InvestigationPrintRows {
  readonly events: string;
  readonly activity: string;
  readonly exactEmail: string;
}

function investigationPrintHtmlWithRows(
  input: InvestigationReportData,
  groups: ReturnType<typeof groupInvestigationActivity>,
  exactEmailGroups: ReturnType<typeof groupExactEmailMessages>,
  prepared?: InvestigationPrintRows,
): string {
  if (input.assistantAnalysis !== undefined) {
    const hasInvestigation = Boolean(input.alert || input.sourceEvent || input.events.length > 0);
    const eventRows =
      prepared?.events ?? input.events.map((event) => eventPrintRow(input, event)).join('');
    const activityRows = prepared?.activity ?? groups.map(activityPrintRow).join('');
    const exactEmailRows =
      prepared?.exactEmail ?? exactEmailGroups.map(exactEmailPrintRow).join('');
    const citations = (input.assistantCitations ?? [])
      .map(
        (citation) =>
          `<li><strong>${html(citation.kind)}</strong> · ${html(citation.label)} <code>${html(citation.id)}</code></li>`,
      )
      .join('');
    const investigation = !hasInvestigation
      ? ''
      : `<h2>Evidencia de investigación</h2><div class="meta"><strong>Alerta QAPAQ:</strong> ${html(input.alert?.id ?? '—')}<br/><strong>Eventos:</strong> ${input.events.length.toLocaleString('es-PE')} de ${input.totalEvents.toLocaleString('es-PE')}${input.truncated ? ' (límite de exportación)' : ''}<br/><strong>Entidades:</strong> ${html(input.entities.join(' · '))}</div><p class="notice">La actividad agrupada muestra coincidencias y proximidad temporal; no prueba causalidad ni un hilo de correo. Solo las operaciones de envío documentadas permiten clasificar salida; el feed actual no acredita recepción.</p><h3>Actividad agrupada por entidad</h3><table><thead><tr><th>Entidad</th><th>Primera actividad UTC</th><th>Última actividad UTC</th><th>Eventos</th><th>Orígenes</th></tr></thead><tbody>${activityRows || '<tr><td colspan="5">Sin grupos</td></tr>'}</tbody></table><h3>Coincidencias por ID exacto de mensaje</h3><table><thead><tr><th>Tipo</th><th>ID exacto</th><th>Dirección según operaciones</th><th>Eventos</th><th>Buzones auditados</th><th>Destinatarios del DTO</th><th>Operaciones</th><th>IDs de evento</th></tr></thead><tbody>${exactEmailRows || '<tr><td colspan="8">Sin coincidencias</td></tr>'}</tbody></table><h3>Línea de tiempo (${input.events.length.toLocaleString('es-PE')} eventos)</h3><table><thead><tr><th>Tipo</th><th>Fecha UTC</th><th>Nivel</th><th>Origen</th><th>Regla</th><th>Descripción</th><th>Entidades</th><th>Metadatos M365</th><th>ID</th></tr></thead><tbody>${eventRows || '<tr><td colspan="9">Sin eventos autorizados en la ventana seleccionada.</td></tr>'}</tbody></table>`;
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${html(input.title)} · QAPAQ SecOps</title><style>body{font:14px/1.55 Arial,sans-serif;color:#17212b;max-width:1100px;margin:36px auto;padding:0 24px}header{border-bottom:4px solid #df8b26;padding:0 0 18px;margin-bottom:22px}h1{font-size:25px;margin:0 0 8px;color:#263444}h2{font-size:17px;color:#263444;margin:24px 0 8px}h3{font-size:14px;color:#263444;margin:20px 0 8px}.meta,.notice{padding:12px 14px;background:#f2f5f8;border-left:4px solid #df8b26}.analysis{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 Arial,sans-serif}.chart{margin:20px 0}.chart svg{max-width:100%;height:auto}figcaption,small{color:#536477;font-size:11px}li{margin:6px 0}code{font:11px monospace}table{width:100%;border-collapse:collapse;margin-top:10px;table-layout:fixed;font-size:11px}th{background:#263444;color:white;text-align:left}th,td{padding:6px;border:1px solid #cbd2d9;vertical-align:top;overflow-wrap:anywhere}.foot{margin-top:32px;border-top:1px solid #cbd2d9;padding-top:10px;color:#536477;font-size:11px}@page{size:A4 landscape;margin:14mm}@media print{body{margin:0;max-width:none;padding:0}thead{display:table-header-group}tr{break-inside:avoid}}</style></head><body><header><h1>QAPAQ SecOps · ${hasInvestigation ? 'Informe profesional de investigación' : 'Informe de análisis Qapaqzito'}</h1><div>${html(input.title)}</div></header><div class="meta"><strong>Generado (UTC):</strong> ${html(input.generatedAt.toISOString())}</div><p class="notice">Respuesta asistida por IA. Revisa las fuentes y valida los hallazgos antes de compartir o tomar decisiones.</p>${input.assistantChartSvg ? `<figure class="chart">${input.assistantChartSvg}<figcaption>Gráfico derivado solo de los valores numéricos explícitos de la respuesta.</figcaption></figure>` : ''}<h2>Análisis de Qapaqzito</h2><pre class="analysis">${html(input.assistantAnalysis)}</pre><h2>Fuentes citadas</h2><ul>${citations || '<li>La respuesta no incluyó fuentes citadas.</li>'}</ul>${investigation}<footer class="foot">QAPAQ SecOps · Evidencia consultada con la identidad del analista; contiene solo campos autorizados del contrato de investigación.</footer><script>window.addEventListener('load',()=>window.print());</script></body></html>`;
  }
  const rows =
    prepared?.events ?? input.events.map((event) => eventPrintRow(input, event)).join('');
  const blocks = prepared?.activity ?? groups.map(activityPrintRow).join('');
  const emailBlocks = prepared?.exactEmail ?? exactEmailGroups.map(exactEmailPrintRow).join('');
  const qapaqzitoSection =
    input.assistantAnalysis === undefined
      ? ''
      : `<h2>Análisis de Qapaqzito</h2><p class="note">Respuesta asistida por IA; debe revisarse antes de compartir o tomar decisiones.</p>${input.assistantChartSvg ? `<figure>${input.assistantChartSvg}<figcaption>Visualización derivada exclusivamente de la tabla numérica incluida en la respuesta.</figcaption></figure>` : ''}<pre class="analysis">${html(input.assistantAnalysis)}</pre><h3>Fuentes citadas</h3><ul>${(input.assistantCitations ?? []).map((citation) => `<li>${html(citation.kind)} · ${html(citation.label)} (ID ${html(citation.id)})</li>`).join('') || '<li>La respuesta no incluyó fuentes citadas.</li>'}</ul>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${html(input.title)} · Informe QAPAQ SecOps</title><style>body{font:12px/1.45 Arial,sans-serif;color:#17212b;margin:32px}header{border-bottom:3px solid #df8b26;padding-bottom:16px;margin-bottom:24px}h1{font-size:24px;margin:0 0 8px}h2{font-size:16px;margin:28px 0 8px;color:#25384b}.meta{display:grid;grid-template-columns:180px 1fr;gap:5px 12px}.meta strong{color:#536477}table{width:100%;border-collapse:collapse;margin-top:10px;table-layout:fixed}th{background:#263444;color:white;text-align:left}th,td{padding:6px;border:1px solid #cbd2d9;vertical-align:top;overflow-wrap:anywhere}.mono{font-family:monospace;font-size:10px}.note{background:#f2f5f8;padding:10px;border-left:3px solid #df8b26}.analysis{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.55 Arial,sans-serif}.foot{margin-top:24px;color:#536477;font-size:10px}@page{size:A4 landscape;margin:12mm}@media print{body{margin:0}thead{display:table-header-group}tr{break-inside:avoid}h2{break-after:avoid}}</style></head><body><header><h1>QAPAQ SecOps · ${input.assistantAnalysis === undefined ? 'Informe de investigación' : 'Análisis asistido por Qapaqzito'}</h1><div>${html(input.title)}</div></header><section class="meta"><strong>Generado (UTC)</strong><span>${html(input.generatedAt.toISOString())}</span><strong>Alerta QAPAQ</strong><span>${html(input.alert?.id ?? '—')}</span><strong>Evento Wazuh de origen</strong><span>${html(input.sourceEvent?.id ?? '—')}</span><strong>Eventos incluidos</strong><span>${input.events.length.toLocaleString('es-PE')} de ${input.totalEvents.toLocaleString('es-PE')}${input.truncated ? ' · informe limitado a 10.000 eventos' : ''}</span><strong>Entidades analizadas</strong><span>${html(input.entities.join(' · '))}</span></section>${qapaqzitoSection}<p class="note">La actividad por entidad y proximidad no establece causalidad. Los grupos por NetworkMessageId o InternetMessageId son coincidencias exactas; no prueban causalidad ni un hilo. Solo las operaciones de envío documentadas permiten clasificar salida; el feed actual no acredita recepción. Buzones y destinatarios proceden únicamente del DTO allowlisted; un buzón auditado no identifica necesariamente al actor humano. Los campos sensibles excluidos por contrato no se incorporan.</p><h2>Actividad agrupada por entidad y proximidad</h2><table><thead><tr><th>Entidad</th><th>Primera actividad UTC</th><th>Última actividad UTC</th><th>Eventos</th><th>Orígenes</th></tr></thead><tbody>${blocks || '<tr><td colspan="5">Sin bloques de actividad</td></tr>'}</tbody></table><h2>Coincidencias por identificador exacto de mensaje</h2><table><thead><tr><th>Campo</th><th>Identificador exacto</th><th>Dirección según operaciones</th><th>Eventos</th><th>Buzones auditados</th><th>Destinatarios del DTO</th><th>Operaciones auditadas</th><th>IDs de evento</th></tr></thead><tbody>${emailBlocks || '<tr><td colspan="8">Sin identificadores exactos compartidos</td></tr>'}</tbody></table><h2>Línea de tiempo · ${input.events.length.toLocaleString('es-PE')} eventos</h2><table><thead><tr><th>Tipo</th><th>Fecha y hora UTC</th><th>Nivel</th><th>Origen</th><th>Regla</th><th>Descripción</th><th>Entidades</th><th>Metadatos M365 de auditoría</th><th>ID</th></tr></thead><tbody>${rows || '<tr><td colspan="9">Sin eventos</td></tr>'}</tbody></table><footer class="foot">QAPAQ SecOps · Evidencia consultada con la identidad del analista. Exportación limitada a los campos visibles del contrato de investigación.</footer><script>window.addEventListener('load',()=>window.print());</script></body></html>`;
}

export function investigationPrintHtml(input: InvestigationReportData): string {
  return investigationPrintHtmlWithRows(
    input,
    groupInvestigationActivity(input.events),
    groupExactEmailMessages(input.events),
  );
}

/** Chunked print rendering supports progress updates and cancellation before opening print UI. */
export async function investigationPrintHtmlWithProgress(
  input: InvestigationReportData,
  signal: AbortSignal,
  onProgress?: (progress: ReportProgress) => void,
): Promise<string> {
  const groups = groupInvestigationActivity(input.events);
  const exactEmailGroups = groupExactEmailMessages(input.events);
  const total = input.events.length + groups.length + exactEmailGroups.length;
  const progress = { completed: 0 };
  const render = async <T>(items: readonly T[], write: (item: T) => string): Promise<string> => {
    const chunks: string[] = [];
    const chunkSize = 250;
    for (let offset = 0; offset < items.length; offset += chunkSize) {
      abortIfNeeded(signal);
      const end = Math.min(offset + chunkSize, items.length);
      chunks.push(items.slice(offset, end).map(write).join(''));
      const completed = progress.completed + end;
      onProgress?.({
        phase: 'render',
        completed,
        total,
        percent: 65 + Math.floor((completed / Math.max(1, total)) * 25),
        message: `Preparando expediente imprimible: ${completed.toLocaleString('es-PE')} de ${total.toLocaleString('es-PE')} filas`,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    progress.completed += items.length;
    return chunks.join('');
  };
  const rows: InvestigationPrintRows = {
    events: await render(input.events, (event) => eventPrintRow(input, event)),
    activity: await render(groups, activityPrintRow),
    exactEmail: await render(exactEmailGroups, exactEmailPrintRow),
  };
  abortIfNeeded(signal);
  return investigationPrintHtmlWithRows(input, groups, exactEmailGroups, rows);
}

export function writeInvestigationPrintWindow(
  target: Window,
  input: InvestigationReportData,
): void {
  target.document.open();
  target.document.write(investigationPrintHtml(input));
  target.document.close();
}

export async function writeInvestigationPrintWindowWithProgress(
  target: Window,
  input: InvestigationReportData,
  signal: AbortSignal,
  onProgress?: (progress: ReportProgress) => void,
): Promise<void> {
  const groups = groupInvestigationActivity(input.events);
  const exactEmailGroups = groupExactEmailMessages(input.events);
  const emptyRows: InvestigationPrintRows = { events: '', activity: '', exactEmail: '' };
  const shell = investigationPrintHtmlWithRows(input, [], [], emptyRows).replace(
    /<script>window\.addEventListener\('load',\(\)=>window\.print\(\)\);<\/script>/u,
    '',
  );
  if (shell.includes('window.print')) throw new Error('No se pudo preparar la vista imprimible.');
  target.document.open();
  target.document.write(shell);
  target.document.close();
  const bodies = target.document.querySelectorAll('tbody');
  const expectedSections = (shell.match(/<tbody>/gu) ?? []).length;
  if (bodies.length !== expectedSections)
    throw new Error('La vista imprimible no tiene las secciones esperadas.');
  bodies.forEach((body) => {
    body.textContent = '';
  });

  const total = input.events.length + groups.length + exactEmailGroups.length;
  let completed = 0;
  const render = async <T>(
    items: readonly T[],
    section: HTMLTableSectionElement,
    write: (item: T) => string,
  ): Promise<void> => {
    const chunkSize = 250;
    for (let offset = 0; offset < items.length; offset += chunkSize) {
      abortIfNeeded(signal);
      const end = Math.min(offset + chunkSize, items.length);
      const chunk = items.slice(offset, end).map(write).join('');
      section.insertAdjacentHTML('beforeend', chunk);
      completed += end - offset;
      onProgress?.({
        phase: 'render',
        completed,
        total,
        percent: 65 + Math.floor((completed / Math.max(1, total)) * 25),
        message: `Vista previa: ${completed.toLocaleString('es-PE')} de ${total.toLocaleString('es-PE')} filas escritas`,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };

  await render(groups, bodies[0]!, activityPrintRow);
  await render(exactEmailGroups, bodies[1]!, exactEmailPrintRow);
  await render(input.events, bodies[2]!, (event) => eventPrintRow(input, event));
  abortIfNeeded(signal);
  onProgress?.({
    phase: 'package',
    completed: 1,
    total: 1,
    percent: 100,
    message: 'Vista imprimible lista; revisa el contenido antes de guardar como PDF.',
  });
  target.setTimeout(() => target.print(), 0);
}

export function downloadInvestigationXlsx(input: InvestigationReportData): Promise<void> {
  return createInvestigationXlsx(input).then((blob) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `qapaq-investigacion-${(input.alert?.id ?? 'grupo').replace(/[^A-Za-z0-9_-]/gu, '_')}.xlsx`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  });
}
