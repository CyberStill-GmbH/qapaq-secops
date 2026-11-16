/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import type { Alert, InvestigationEventSummary } from '../../common';
import {
  groupInvestigationActivity,
  investigationActivityCsvRows,
} from './investigation_activity_grouping';

export interface InvestigationExport {
  readonly alert: Alert | null;
  readonly title: string;
  readonly entities: readonly string[];
  readonly events: readonly InvestigationEventSummary[];
  readonly totalEvents?: number;
  readonly generatedAt?: Date;
}

export interface InvestigationCsvProgress {
  readonly completed: number;
  readonly total: number;
}

function spreadsheetSafe(value: unknown): string {
  let text = value == null ? '' : String(value);
  // Excel and other spreadsheet apps can execute formulas from imported CSV cells.
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/gu, '""')}"`;
}

function investigationCsvRows(input: InvestigationExport): unknown[][] {
  const rows: unknown[][] = [
    ['QAPAQ SecOps · Informe de investigación', input.title, '', '', '', '', '', '', ''],
    ['Generado (UTC)', (input.generatedAt ?? new Date()).toISOString(), '', '', '', '', '', '', ''],
    [
      'Eventos relacionados exportados',
      input.events.length,
      'Eventos encontrados',
      input.totalEvents ?? input.events.length,
      '',
      '',
      '',
      '',
      '',
    ],
    [
      'Alerta',
      'Fecha UTC',
      'Prioridad',
      'Estado',
      'Origen',
      'Regla',
      'Descripción',
      'Entidades',
      'Referencia',
    ],
  ];
  if (input.alert) {
    rows.push([
      'Alerta QAPAQ',
      input.alert.occurredAt,
      input.alert.priority,
      input.alert.status,
      'QAPAQ SecOps',
      '',
      input.alert.title,
      input.alert.entities.map((entity) => `${entity.kind}:${entity.label}`).join(' | '),
      input.alert.id,
    ]);
  }
  for (const event of input.events) {
    rows.push([
      'Evento SIEM',
      event.at,
      `Nivel ${event.level}`,
      '',
      event.vendor,
      event.ruleId,
      event.description,
      event.matched.join(' | '),
      event.id,
    ]);
  }
  rows.push(['Entidades investigadas', '', '', '', '', '', '', input.entities.join(' | '), '']);
  const groups = groupInvestigationActivity(input.events);
  rows.push(
    [],
    ['Bloques temporales de actividad', '', '', '', '', '', '', '', ''],
    [
      'Tipo',
      'Entidad coincidente',
      'Primera actividad UTC',
      'Última actividad UTC',
      'Eventos',
      'Orígenes',
      'Reglas',
      'IDs de evento',
      'Interpretación',
    ],
    ...investigationActivityCsvRows(groups).map((row) => [
      ...row,
      'Proximidad temporal; no determina causalidad ni hilo de correo',
    ]),
  );
  return rows;
}

function abortIfCsvNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Informe cancelado', 'AbortError');
}

function yieldCsv(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function csvLine(row: readonly unknown[]): string {
  return row.map(spreadsheetSafe).join(';');
}

export function investigationCsv(input: InvestigationExport): string {
  const rows = investigationCsvRows(input);
  return `\uFEFF${rows.map(csvLine).join('\r\n')}\r\n`;
}

/** Serialize large CSVs in chunks so the UI can show real row progress and respond to cancel. */
export async function investigationCsvWithProgress(
  input: InvestigationExport,
  signal: AbortSignal,
  onProgress?: (progress: InvestigationCsvProgress) => void,
): Promise<string> {
  const rows = investigationCsvRows(input);
  const chunks: string[] = ['\uFEFF'];
  const chunkSize = 250;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    abortIfCsvNeeded(signal);
    const end = Math.min(offset + chunkSize, rows.length);
    if (offset > 0) chunks.push('\r\n');
    chunks.push(rows.slice(offset, end).map(csvLine).join('\r\n'));
    onProgress?.({ completed: end, total: rows.length });
    await yieldCsv();
  }
  abortIfCsvNeeded(signal);
  return `${chunks.join('')}\r\n`;
}

export function downloadInvestigationCsv(input: InvestigationExport): void {
  const blob = new Blob([investigationCsv(input)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `qapaq-investigacion-${(input.alert?.id ?? 'entidad').replace(/[^A-Za-z0-9_-]/gu, '_')}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
