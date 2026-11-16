/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { EuiButton, EuiCallOut, EuiFieldText, EuiFormRow, EuiLoadingContent } from '@elastic/eui';
import {
  AiDigest,
  digestRangeError,
  formatCount,
  formatMicroUsd,
  localDay,
  PRIORITIES,
} from '../../common';
import { getAiDigest, isAnalystUnavailable } from '../api/ai_investigations';
import { digestFilename, printAnalystReport } from './ai_analyst_download';
import { AiTile } from './ai_analyst_parts';
import { useConsole } from './console_context';
import { ErrorCallout, Mono, PriorityMark } from './primitives';

/** Periodos rápidos: días hacia atrás desde hoy (0 = solo hoy). */
const PRESETS: ReadonlyArray<{ label: string; days: number }> = [
  { label: 'Hoy', days: 0 },
  { label: 'Últimos 7 días', days: 6 },
  { label: 'Últimos 30 días', days: 29 },
];

/** Escalón 0–20 de una barra, sin estilos en línea. */
function barStep(value: number | null, max: number): number {
  if (value === null || max <= 0) return 0;
  return Math.max(value > 0 ? 1 : 0, Math.round((value / max) * 20));
}

/** Totales del periodo. Un conteo que no llegó es «Sin dato», no cero. */
export function AiDigestView({
  digest,
  onDownload,
}: {
  digest: AiDigest;
  onDownload?: () => void;
}) {
  const hasText = digest.markdown.trim().length > 0;
  const priorityMax = Math.max(0, ...PRIORITIES.map((priority) => digest.byPriority[priority] ?? 0));
  return (
    <section className="qapaqAiDigest" aria-label="Resumen del periodo">
      <div className="qapaqAiDigest__head">
        <p className="qapaqCellMeta">
          Periodo: <Mono>{digest.from ?? 'Sin dato'}</Mono> a <Mono>{digest.to ?? 'Sin dato'}</Mono>
        </p>
        {hasText ? (
          onDownload && (
            <EuiButton size="s" iconType="download" onClick={onDownload}>
              Guardar resumen como PDF
            </EuiButton>
          )
        ) : (
          <p className="qapaqMuted">El servicio no entregó el texto del resumen para descargar.</p>
        )}
      </div>
      <div className="qapaqAiDigest__tiles">
        <AiTile label="Investigaciones" value={formatCount(digest.totals.runs)} />
        <AiTile label="Escaladas" value={formatCount(digest.totals.escalated)} />
        <AiTile label="Cerradas como benignas" value={formatCount(digest.totals.closedBenign)} />
        <AiTile label="Requieren revisión" value={formatCount(digest.totals.requiresReview)} />
        <AiTile label="Resueltas sin IA" value={formatCount(digest.totals.withoutInference)} />
        <AiTile label="Fallidas" value={formatCount(digest.totals.failed)} />
        <AiTile
          label="Costo del periodo"
          value={formatMicroUsd(digest.estimatedMicroUsd)}
          hint="facturación no conectada"
        />
      </div>
      <div className="qapaqSplit">
        <section className="qapaqPanel" aria-labelledby="qapaqAiDigestPriority">
          <div className="qapaqPanel__header">
            <h2 id="qapaqAiDigestPriority">Por prioridad</h2>
          </div>
          <ul className="qapaqAiBars">
            {PRIORITIES.map((priority) => (
              <li key={priority}>
                <PriorityMark priority={priority} />
                <span className="qapaqAiBars__track" aria-hidden="true">
                  <span
                    className="qapaqAiBars__fill"
                    data-priority={priority.toLowerCase()}
                    data-step={barStep(digest.byPriority[priority], priorityMax)}
                  />
                </span>
                <span className="qapaqTabular">{formatCount(digest.byPriority[priority])}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="qapaqPanel" aria-labelledby="qapaqAiDigestRules">
          <div className="qapaqPanel__header">
            <h2 id="qapaqAiDigestRules">Reglas con más investigaciones</h2>
          </div>
          {digest.topRules.length === 0 ? (
            <p className="qapaqPanel__empty">El resumen no incluye reglas para este periodo.</p>
          ) : (
            <ol className="qapaqAiRules">
              {digest.topRules.map((rule) => (
                <li key={rule.ruleId}>
                  <span>
                    Regla <Mono>{rule.ruleId}</Mono>
                  </span>
                  <span className="qapaqTabular">{formatCount(rule.count)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </section>
  );
}

export function AiReportsTab() {
  const { api, basePath } = useConsole();
  const [from, setFrom] = useState(() => localDay(new Date(), -6));
  const [to, setTo] = useState(() => localDay(new Date()));
  const [digest, setDigest] = useState<AiDigest | null>(null);
  const [loaded, setLoaded] = useState<{ from: string; to: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const rangeError = digestRangeError(from, to);

  const load = async (range: { from: string; to: string } = { from, to }) => {
    if (digestRangeError(range.from, range.to) || busy) return;
    setBusy(true);
    setError(null);
    try {
      setDigest(await getAiDigest(api, range.from, range.to));
      setLoaded(range);
    } catch (failure) {
      setDigest(null);
      setLoaded(null);
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const preset = (days: number) => {
    const range = { from: localDay(new Date(), -days), to: localDay(new Date()) };
    setFrom(range.from);
    setTo(range.to);
    void load(range);
  };

  return (
    <div className="qapaqAiReports">
      <section className="qapaqPanel" aria-labelledby="qapaqAiReportsTitle">
        <div className="qapaqPanel__header">
          <h2 id="qapaqAiReportsTitle">Resumen de un periodo</h2>
          <span className="qapaqPanel__meta">Totales del analista para compartir con el equipo</span>
        </div>
        <div className="qapaqAiReports__presets" role="group" aria-label="Periodos rápidos">
          {PRESETS.map((item) => (
            <button
              key={item.label}
              type="button"
              className="qapaqAiChip"
              disabled={busy}
              onClick={() => preset(item.days)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <form
          className="qapaqAi__range"
          onSubmit={(event) => {
            event.preventDefault();
            void load();
          }}
        >
          <EuiFormRow label="Desde" display="rowCompressed">
            <EuiFieldText
              compressed
              type="date"
              value={from}
              max={to || undefined}
              onChange={(event) => setFrom(event.target.value)}
            />
          </EuiFormRow>
          <EuiFormRow
            label="Hasta"
            display="rowCompressed"
            isInvalid={rangeError !== null}
            error={rangeError ?? undefined}
          >
            <EuiFieldText
              compressed
              type="date"
              value={to}
              min={from || undefined}
              isInvalid={rangeError !== null}
              onChange={(event) => setTo(event.target.value)}
            />
          </EuiFormRow>
          <EuiButton size="s" type="submit" isLoading={busy} isDisabled={rangeError !== null}>
            Generar resumen
          </EuiButton>
        </form>
        <p className="qapaqAi__note">
          El informe de una investigación concreta se guarda desde su expediente («Guardar informe
          como PDF»). El navegador permite revisar el documento y guardarlo como PDF.
        </p>
      </section>
      {error != null &&
        (isAnalystUnavailable(error) ? (
          <EuiCallOut
            size="s"
            color="warning"
            iconType="offline"
            title="Los informes del analista no están publicados en este entorno"
          />
        ) : (
          <ErrorCallout error={error} onRetry={() => void load()} />
        ))}
      {busy && !digest && <EuiLoadingContent lines={4} />}
      {digest && loaded && (
        <AiDigestView
          digest={digest}
          onDownload={() => {
            setError(null);
            try {
              printAnalystReport(digestFilename(loaded.from, loaded.to), digest.markdown, basePath);
            } catch (failure) {
              setError(failure);
            }
          }}
        />
      )}
      {!digest && error == null && !busy && (
        <p className="qapaqAiEmpty">
          Elige un periodo rápido o un rango de fechas y pulsa «Generar resumen».
        </p>
      )}
    </div>
  );
}
