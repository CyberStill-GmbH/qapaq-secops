/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Alert, RelatedWindow } from '../../common';
import type { QapaqApiClient } from '../api/client';
import { fetchEvent, fetchRelated } from '../api/investigation';
import type { QapaqzitoCitation } from './chat_client';
import {
  QapaqzitoInvestigationError,
  qapaqzitoChartSeries,
  qapaqzitoNumericColumns,
  qapaqzitoNumericTable,
  qapaqzitoReportData,
  collectQapaqzitoInvestigationReport,
} from './qapaqzito_report';
import {
  createInvestigationXlsx,
  ReportCollectionError,
  writeInvestigationPrintWindowWithProgress,
  writeInvestigationXlsx,
} from '../components/investigation_report';

type Format = 'pdf' | 'xlsx';
type ReportKind = 'answer' | 'investigation';

type ReportFileWritable = {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
};

type ReportFileHandle = { createWritable(): Promise<ReportFileWritable> };

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<ReportFileHandle>;
};

export function QapaqzitoReportActions({
  api,
  basePath,
  text,
  citations,
  title,
  messageId,
}: {
  readonly api: QapaqApiClient;
  readonly basePath: string;
  readonly text: string;
  readonly citations: readonly QapaqzitoCitation[];
  readonly title?: string;
  readonly messageId: number;
}) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<Format>('pdf');
  const [requestedKind, setKind] = useState<ReportKind>(() =>
    citations.some((citation) => citation.kind === 'alert' || citation.kind === 'event')
      ? 'investigation'
      : 'answer',
  );
  const [windowRange, setWindowRange] = useState<RelatedWindow>('24h');
  const [citationId, setCitationId] = useState('');
  const [includeChart, setIncludeChart] = useState(false);
  const [chartColumn, setChartColumn] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [progressPercent, setProgressPercent] = useState<number | undefined>();
  const [status, setStatus] = useState('');
  const [failed, setFailed] = useState(false);
  const activeRun = useRef<AbortController | null>(null);
  const startingExport = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      activeRun.current?.abort();
    },
    [],
  );
  const chart = useMemo(() => qapaqzitoNumericTable(text), [text]);
  const chartColumns = chart ? qapaqzitoNumericColumns(chart) : [];
  const series = chart ? qapaqzitoChartSeries(chart, chartColumn) : null;
  const evidenceCitations = useMemo(
    () =>
      citations.filter(
        (citation, index) =>
          (citation.kind === 'alert' || citation.kind === 'event') &&
          citations.findIndex(
            (other) => other.kind === citation.kind && other.id === citation.id,
          ) === index,
      ),
    [citations],
  );
  const kind = evidenceCitations.length > 0 ? requestedKind : 'answer';
  const selectedCitation =
    evidenceCitations.find((citation) => `${citation.kind}:${citation.id}` === citationId) ??
    evidenceCitations[0] ??
    null;

  const exportReport = async () => {
    if (busy || startingExport.current) return;
    startingExport.current = true;
    setFailed(false);
    const filename = `qapaq-qapaqzito-${kind === 'investigation' ? 'investigacion' : 'respuesta'}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    const picker =
      format === 'xlsx' && typeof (window as SavePickerWindow).showSaveFilePicker === 'function';
    let outputHandle: ReportFileHandle | null = null;
    if (picker) {
      try {
        outputHandle = await (window as SavePickerWindow).showSaveFilePicker!({
          suggestedName: filename,
          types: [
            {
              description: 'Libro Excel de QAPAQ SecOps',
              accept: {
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
              },
            },
          ],
        });
      } catch (error) {
        if (!mounted.current) return;
        if (error instanceof Error && error.name === 'AbortError') {
          setStatus('Selecci\u00f3n del destino cancelada. No se gener\u00f3 ning\u00fan archivo.');
          startingExport.current = false;
          return;
        }
        setStatus('No se pudo abrir el selector de archivos del navegador.');
        setFailed(true);
        startingExport.current = false;
        return;
      }
    }
    if (!mounted.current) return;
    const printWindow = format === 'pdf' ? window.open('', '_blank') : null;
    if (format === 'pdf' && !printWindow) {
      setStatus('Permite la ventana emergente para previsualizar e imprimir el PDF.');
      setFailed(true);
      startingExport.current = false;
      return;
    }
    if (printWindow) {
      printWindow.document.open();
      printWindow.document.write(
        '<!doctype html><html lang="es"><meta charset="utf-8"><title>Preparando informe QAPAQ</title><body style="font:16px Arial;padding:32px;color:#263444">Preparando el informe con la respuesta y fuentes citadas…</body></html>',
      );
      printWindow.document.close();
    }
    setBusy(true);
    startingExport.current = false;
    setStatus('');
    setProgressPercent(undefined);
    setProgress('Preparando el contenido validado…');
    const controller = new AbortController();
    activeRun.current = controller;
    try {
      const report =
        kind === 'investigation'
          ? await collectQapaqzitoInvestigationReport({
              citation: selectedCitation,
              window: windowRange,
              analysis: text,
              citations,
              includeChart,
              chartColumn: series?.column,
              loadAlert: async (id) =>
                (await api.get<{ alert: Alert }>(`/alerts/${encodeURIComponent(id)}`)).alert,
              loadEvent: (id) =>
                fetchEvent(basePath, id, (url, init) =>
                  globalThis.fetch(url, { ...init, signal: controller.signal }),
                ),
              loadPage: (query, cursor, signal) =>
                fetchRelated(
                  basePath,
                  {
                    entities: query.entities,
                    at: query.at,
                    window: query.window,
                    ...(query.excludeId ? { exclude: query.excludeId } : {}),
                    ...(cursor ? { cursor } : {}),
                  },
                  globalThis.fetch.bind(globalThis),
                  signal,
                ),
              signal: controller.signal,
              onProgress: (next) => {
                if (!mounted.current || controller.signal.aborted) return;
                setProgress(next.message);
                if (next.percent !== undefined) {
                  setProgressPercent((current) => Math.max(current ?? 0, next.percent!));
                }
                if (
                  next.phase === 'query' &&
                  printWindow &&
                  !printWindow.closed &&
                  printWindow.document.body
                ) {
                  printWindow.document.body.textContent = next.message;
                }
              },
            })
          : qapaqzitoReportData({
              text,
              citations,
              title,
              includeChart,
              chartColumn: series?.column,
              now: new Date(),
            });
      if (controller.signal.aborted) throw new DOMException('Informe cancelado', 'AbortError');
      if (format === 'pdf' && printWindow) {
        await writeInvestigationPrintWindowWithProgress(
          printWindow,
          report,
          controller.signal,
          (next) => {
            if (!mounted.current || controller.signal.aborted) return;
            setProgress(next.message);
            if (next.percent !== undefined) {
              setProgressPercent((current) => Math.max(current ?? 0, next.percent!));
            }
          },
        );
      } else {
        if (outputHandle) {
          const writable = await outputHandle.createWritable();
          await writeInvestigationXlsx(
            report,
            writable,
            (next) => {
              if (!mounted.current || controller.signal.aborted) return;
              setProgress(next.message);
              if (next.percent !== undefined) {
                setProgressPercent((current) => Math.max(current ?? 0, next.percent!));
              }
            },
            controller.signal,
          );
        } else {
          const blob = await createInvestigationXlsx(
            report,
            (next) => {
              if (!mounted.current || controller.signal.aborted) return;
              setProgress(next.message);
              if (next.percent !== undefined) {
                setProgressPercent((current) => Math.max(current ?? 0, next.percent!));
              }
            },
            controller.signal,
          );
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = filename;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 1500);
        }
      }
      if (!mounted.current) return;
      setProgress(
        format === 'pdf'
          ? 'Vista imprimible completa. Revisa el contenido antes de guardarlo como PDF.'
          : 'Libro Excel completo. Revisa el archivo antes de compartirlo.',
      );
      setProgressPercent(100);
      setStatus(
        format === 'pdf'
          ? 'Vista de impresión lista; elige “Guardar como PDF” en el diálogo del navegador.'
          : outputHandle
            ? 'Libro Excel escrito por partes en el archivo elegido.'
            : 'Libro Excel descargado. Este navegador lo preparó en memoria (límite: 50 MiB).',
      );
    } catch (error) {
      if (printWindow && !printWindow.closed) printWindow.close();
      if (!mounted.current) return;
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        setStatus('Preparación cancelada.');
      } else {
        setFailed(true);
        if (error instanceof QapaqzitoInvestigationError) {
          const messages: Record<QapaqzitoInvestigationError['reason'], string> = {
            'no-citation':
              'Esta respuesta no tiene una alerta o evento citado para iniciar una investigación.',
            forbidden:
              'Tu sesión no tiene acceso a la evidencia citada; no se generó un expediente parcial.',
            'not-found': 'La evidencia citada ya no está disponible para tu sesión.',
            unavailable:
              'Wazuh Indexer o la API de investigación no respondió. No se generó un expediente parcial; reintenta y, si persiste, revisa Salud de fuentes.',
            'no-entities':
              'La evidencia no contiene entidades consultables; no se inventaron filtros.',
          };
          setStatus(messages[error.reason]);
        } else if (error instanceof ReportCollectionError) {
          const messages = {
            forbidden:
              'Tu sesión no tiene acceso a todos los eventos relacionados. No se generó un expediente parcial.',
            unavailable:
              'La consulta de eventos no se pudo completar. Reintenta o revisa Salud de fuentes; no se generó un expediente parcial.',
            invalid:
              'Los resultados de investigación no fueron consistentes. Vuelve a consultar la evidencia antes de generar el informe.',
            rejected:
              'La API rechazó la consulta. Vuelve a abrir la evidencia y revisa el alcance del informe.',
          };
          setStatus(messages[error.kind]);
        } else
          setStatus(
            error instanceof Error
              ? `No se pudo preparar el informe: ${error.message}`
              : 'No se pudo preparar el informe. Inténtalo de nuevo.',
          );
      }
    } finally {
      activeRun.current = null;
      startingExport.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <div className="qapaqQapaqzito__reportExport">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? 'Cerrar informe' : 'Crear informe'}
      </button>
      {open && (
        <section className="qapaqQapaqzito__reportPanel" aria-label="Exportar análisis de Qapaqzito">
          <h4>Informe para revisión SOC</h4>
          <p>
            El expediente profesional consulta la alerta/evento citado y reúne los eventos
            relacionados que tu sesión puede ver. Exportar respuesta conserva solo el texto de
            Qapaqzito.
          </p>
          <fieldset disabled={busy}>
            <legend>Contenido del informe</legend>
            <label>
              <input
                type="radio"
                name={`qapaqzito-report-kind-${messageId}`}
                checked={kind === 'investigation'}
                onChange={() => setKind('investigation')}
                disabled={evidenceCitations.length === 0}
              />{' '}
              Investigación con evidencia
            </label>
            <label>
              <input
                type="radio"
                name={`qapaqzito-report-kind-${messageId}`}
                checked={kind === 'answer'}
                onChange={() => setKind('answer')}
              />{' '}
              Solo respuesta de Qapaqzito
            </label>
          </fieldset>
          {kind === 'investigation' && evidenceCitations.length > 0 && (
            <>
              <label>
                Alerta o evento de referencia
                <select
                  disabled={busy}
                  aria-label="Evidencia para la investigación"
                  value={selectedCitation ? `${selectedCitation.kind}:${selectedCitation.id}` : ''}
                  onChange={(event) => setCitationId(event.target.value)}
                >
                  {evidenceCitations.map((citation) => (
                    <option
                      key={`${citation.kind}:${citation.id}`}
                      value={`${citation.kind}:${citation.id}`}
                    >
                      {citation.kind === 'alert' ? 'Alerta' : 'Evento'} · {citation.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Ventana de actividad
                <select
                  disabled={busy}
                  aria-label="Ventana de actividad"
                  value={windowRange}
                  onChange={(event) => setWindowRange(event.target.value as RelatedWindow)}
                >
                  <option value="1h">±1 hora</option>
                  <option value="24h">±24 horas</option>
                  <option value="7d">±7 días</option>
                </select>
              </label>
            </>
          )}
          {evidenceCitations.length === 0 && (
            <p className="qapaqQapaqzito__reportHint">
              Qapaqzito no citó una alerta o evento en esta respuesta. Puedes exportar el texto; para un
              expediente de investigación, abre Qapaqzito desde una alerta o evento.
            </p>
          )}
          <fieldset disabled={busy}>
            <legend>Formato</legend>
            <label>
              <input
                type="radio"
                name={`qapaqzito-report-format-${messageId}`}
                checked={format === 'pdf'}
                onChange={() => setFormat('pdf')}
              />{' '}
              PDF imprimible
            </label>
            <label>
              <input
                type="radio"
                name={`qapaqzito-report-format-${messageId}`}
                checked={format === 'xlsx'}
                onChange={() => setFormat('xlsx')}
              />{' '}
              Excel (.xlsx)
            </label>
          </fieldset>
          {chart ? (
            <label className="qapaqQapaqzito__chartToggle">
              <input
                type="checkbox"
                disabled={busy}
                checked={includeChart}
                onChange={(event) => setIncludeChart(event.target.checked)}
              />
              Incluir gráfico basado en la tabla numérica de la respuesta
            </label>
          ) : (
            <p className="qapaqQapaqzito__reportHint">
              Esta respuesta no contiene una tabla numérica completa; no se inventarán valores para
              generar gráficos.
            </p>
          )}
          <div className="qapaqQapaqzito__reportPreview">
            <strong>Vista previa</strong>
            <p>
              {text.slice(0, 360)}
              {text.length > 360 ? '…' : ''}
            </p>
            <small>
              {citations.length} fuente(s) citada(s) · {new Date().toLocaleString('es-PE')}
            </small>
            {chart && includeChart && series && (
              <>
                <label>
                  M?trica del gr?fico
                  <select
                    disabled={busy}
                    value={series.column}
                    onChange={(event) => setChartColumn(Number(event.target.value))}
                  >
                    {chartColumns.map((column) => (
                      <option key={column} value={column}>
                        {chart.headers[column]}
                      </option>
                    ))}
                  </select>
                </label>
                <div
                  className="qapaqQapaqzito__chartPreview"
                  role="img"
                  aria-label={`Gr?fico de ${series.label}`}
                >
                  {series.rows.map((row, index) => (
                    <div className="qapaqQapaqzito__chartRow" key={`${row.label}-${index}`}>
                      <span>{row.label}</span>
                      <i style={{ width: `${row.widthPercent}%` }} />
                      <b>{row.value === null ? 'Sin dato' : row.value}</b>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            type="button"
            disabled={busy || (kind === 'investigation' && evidenceCitations.length === 0)}
            onClick={() => void exportReport()}
          >
            {busy
              ? 'Generando…'
              : kind === 'investigation'
                ? format === 'pdf'
                  ? 'Generar expediente PDF'
                  : 'Generar expediente Excel'
                : format === 'pdf'
                  ? 'Exportar respuesta a PDF'
                  : 'Exportar respuesta a Excel'}
          </button>
          {busy && (
            <>
              <p role="status" aria-live="polite">
                {progress}
              </p>
              <progress
                aria-label="Avance de generacion del informe"
                max={100}
                value={progressPercent}
              />{' '}
              <span>{progressPercent}%</span>
              <button type="button" onClick={() => activeRun.current?.abort()}>
                Cancelar
              </button>
            </>
          )}
          {status && <p role="status">{status}</p>}
        </section>
      )}
    </div>
  );
}
