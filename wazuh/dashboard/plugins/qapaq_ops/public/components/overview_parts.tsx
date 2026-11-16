/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { EuiButtonGroup, EuiLoadingContent, EuiToolTip } from '@elastic/eui';
import {
  CAPABILITIES,
  dashboardHref,
  HEALTH_TONE,
  IntegrationSpec,
  LEVEL_BAND_LABEL,
  LEVEL_BANDS,
  LevelBand,
  LevelCounts,
  OperationsHealth,
  OverviewResponse,
  PRIORITY_STEP,
  PROVIDER_DASHBOARDS,
  PROVIDER_IDS,
  ProviderId,
  SourceHealth,
  TrendBucket,
} from '../../common';
import { fetchOverview, probeRespond } from '../api/overview';
import { QapaqzitoConfig, fetchQapaqzitoConfig } from '../qapaqzito/chat_client';
import { useConsole } from './console_context';
import { AsyncState, Timestamp, useAsync } from './primitives';
import { ServiceStatus } from './service_status';

/** Color de cada banda: los mismos pasos que la prioridad QAPAQ (doc 02 §2.5), no la paleta de marca. */
export const LEVEL_COLOR: Readonly<Record<LevelBand, string>> = {
  low: PRIORITY_STEP.P4.color,
  medium: PRIORITY_STEP.P3.color,
  high: PRIORITY_STEP.P2.color,
  critical: PRIORITY_STEP.P1.color,
};

const NUMBER = new Intl.NumberFormat('es-PE');
export const formatNumber = (value: number): string => NUMBER.format(value);

/** Recarga periódica mientras la pestaña está visible. */
export function useInterval(callback: () => void, ms: number): void {
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') callback();
    }, ms);
    return () => window.clearInterval(timer);
  }, [callback, ms]);
}

export interface PlatformData {
  readonly overview: AsyncState<OverviewResponse>;
  readonly sources: AsyncState<SourceHealth[] | null>;
  readonly operations: AsyncState<OperationsHealth | null>;
  readonly qapaqzito: AsyncState<QapaqzitoConfig | null>;
  readonly respond: AsyncState<boolean>;
  readonly reload: () => void;
}

/**
 * Todo lo que «Resumen del SOC» e «Integraciones» necesitan, cada fuente con su propio estado:
 * una que falla (o que el rol no puede leer) no tumba a las demás.
 */
export function usePlatformData(basePath: string): PlatformData {
  const { api, can } = useConsole();
  const overview = useAsync(() => fetchOverview(basePath), [basePath]);
  const sources = useAsync(
    () =>
      can(CAPABILITIES.sourcesRead)
        ? api
            .get<{ sources: SourceHealth[] }>('/sources/health')
            .then((response) => response.sources)
        : Promise.resolve(null),
    [api],
  );
  const operations = useAsync(
    () =>
      can(CAPABILITIES.observabilitySoc) || can(CAPABILITIES.observabilityPlatform)
        ? api.get<OperationsHealth>('/operations/health')
        : Promise.resolve(null),
    [api],
  );
  const qapaqzito = useAsync(() => fetchQapaqzitoConfig(api).catch(() => null), [api]);
  const respond = useAsync(() => probeRespond(basePath), [basePath]);
  const reload = useMemo(
    () => () => {
      overview.reload();
      sources.reload();
      operations.reload();
      qapaqzito.reload();
      respond.reload();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overview.reload, sources.reload, operations.reload, qapaqzito.reload, respond.reload],
  );
  return { overview, sources, operations, qapaqzito, respond, reload };
}

/* ------------------------------------------------------------------- Piezas */

export function StatusPill({ status }: { status: ServiceStatus }) {
  const mark = HEALTH_TONE[status.tone];
  return (
    <span className="qapaqPill" data-tone={status.tone}>
      <span aria-hidden="true" className="qapaqPill__mark" style={{ color: mark.color }}>
        {mark.glyph}
      </span>
      <span>{status.label}</span>
    </span>
  );
}

export function Monogram({ text }: { text: string }) {
  return (
    <span className="qapaqMonogram" aria-hidden="true" data-length={text.length}>
      {text}
    </span>
  );
}

export interface Metric {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly hint?: string;
  readonly emphasis?: 'danger' | 'warning';
  /** Consulta KQL de las alertas que cuenta la métrica; la tarjeta la convierte en enlace. */
  readonly drill?: { readonly kql: string; readonly from: string };
  /** Destino del valor: la lista de alertas contadas, para investigarlas una a una. */
  readonly href?: string;
}

export function MetricList({ metrics }: { metrics: readonly Metric[] }) {
  if (metrics.length === 0) return null;
  return (
    <dl className="qapaqMetrics">
      {metrics.map((metric) => (
        <div key={metric.label} className="qapaqMetrics__item" data-emphasis={metric.emphasis}>
          <dt>{metric.label}</dt>
          <dd className="qapaqTabular" title={metric.hint}>
            {metric.href ? (
              <a
                className="qapaqMetrics__link"
                href={metric.href}
                aria-label={`${metric.label}: investigar estas alertas`}
              >
                {metric.value}
              </a>
            ) : (
              metric.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function SeverityBar({ levels, label }: { levels: LevelCounts; label: string }) {
  const total = LEVEL_BANDS.reduce((sum, band) => sum + levels[band], 0);
  const summary = LEVEL_BANDS.map(
    (band) => `${LEVEL_BAND_LABEL[band]} ${formatNumber(levels[band])}`,
  ).join(', ');
  return (
    <div className="qapaqSeverityBar" role="img" aria-label={`${label}: ${summary}`}>
      {total === 0 ? (
        <span className="qapaqSeverityBar__empty" />
      ) : (
        LEVEL_BANDS.map((band) =>
          levels[band] > 0 ? (
            <span
              key={band}
              className="qapaqSeverityBar__segment"
              style={{ flexGrow: levels[band], backgroundColor: LEVEL_COLOR[band] }}
              title={`${LEVEL_BAND_LABEL[band]}: ${formatNumber(levels[band])}`}
            />
          ) : null,
        )
      )}
    </div>
  );
}

export function LevelLegend({ levels }: { levels?: LevelCounts }) {
  return (
    <ul className="qapaqLegend">
      {[...LEVEL_BANDS].reverse().map((band) => (
        <li key={band}>
          <span
            aria-hidden="true"
            className="qapaqLegend__swatch"
            style={{ backgroundColor: LEVEL_COLOR[band] }}
          />
          <span>{LEVEL_BAND_LABEL[band]}</span>
          {levels && <strong className="qapaqTabular">{formatNumber(levels[band])}</strong>}
        </li>
      ))}
    </ul>
  );
}

const HOUR = new Intl.DateTimeFormat('es-PE', { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('es-PE', { weekday: 'short', day: '2-digit' });

/**
 * Barras apiladas por severidad, en HTML (columnas flex): escala con el contenedor sin
 * deformar el texto y se lee en un teléfono. Cada columna lleva su resumen accesible.
 */
export function TrendChart({
  trend24h,
  trend7d,
}: {
  trend24h: readonly TrendBucket[];
  trend7d: readonly TrendBucket[];
}) {
  const [range, setRange] = useState<'24h' | '7d'>('24h');
  const buckets = range === '24h' ? trend24h : trend7d;
  const totals = buckets.map((bucket) =>
    LEVEL_BANDS.reduce((sum, band) => sum + bucket.levels[band], 0),
  );
  const max = Math.max(1, ...totals);
  const format = (iso: string) => (range === '24h' ? HOUR : DAY).format(new Date(iso));
  const labelEvery = range === '24h' ? 6 : 1;
  return (
    <div className="qapaqTrend">
      <div className="qapaqTrend__toolbar">
        <LevelLegend />
        <EuiButtonGroup
          legend="Rango del gráfico"
          buttonSize="compressed"
          options={[
            { id: '24h', label: '24 h' },
            { id: '7d', label: '7 días' },
          ]}
          idSelected={range}
          onChange={(id) => setRange(id as '24h' | '7d')}
        />
      </div>
      {totals.every((value) => value === 0) ? (
        <p className="qapaqTrend__empty">Sin eventos en este rango.</p>
      ) : (
        <div className="qapaqTrend__plot" role="list" aria-label="Eventos por severidad">
          <span className="qapaqTrend__max qapaqTabular" aria-hidden="true">
            {formatNumber(max)}
          </span>
          {buckets.map((bucket, index) => {
            const summary = `${format(bucket.at)}: ${formatNumber(totals[index])} eventos (${[
              ...LEVEL_BANDS,
            ]
              .reverse()
              .map((band) => `${LEVEL_BAND_LABEL[band]} ${bucket.levels[band]}`)
              .join(', ')})`;
            return (
              <div key={bucket.at} className="qapaqTrend__column" role="listitem">
                <EuiToolTip content={summary} position="top" display="block">
                  <div
                    className="qapaqTrend__stack"
                    tabIndex={0}
                    aria-label={summary}
                    style={{ height: `${(totals[index] / max) * 100}%` }}
                  >
                    {[...LEVEL_BANDS].reverse().map((band) =>
                      bucket.levels[band] > 0 ? (
                        <span
                          key={band}
                          style={{
                            flexGrow: bucket.levels[band],
                            backgroundColor: LEVEL_COLOR[band],
                          }}
                        />
                      ) : null,
                    )}
                  </div>
                </EuiToolTip>
                <span className="qapaqTrend__tick" aria-hidden="true">
                  {index % labelEvery === 0 ? format(bucket.at) : ''}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="qapaqService qapaqService--loading" aria-busy="true">
      <EuiLoadingContent lines={4} />
    </div>
  );
}

/** Enlaces de una integración: su dashboard QAPAQ (proveedores) y sus módulos de Wazuh. */
export function integrationLinks(spec: IntegrationSpec, basePath: string) {
  const links = [...spec.links];
  if ((PROVIDER_IDS as readonly string[]).includes(spec.id)) {
    links.unshift({
      label: 'Ver dashboard',
      href: dashboardHref(PROVIDER_DASHBOARDS[spec.id as ProviderId]),
    });
  }
  return links.map((link) => ({
    ...link,
    href: link.href.startsWith('http') ? link.href : `${basePath}${link.href}`,
  }));
}

export function LastEvent({ iso }: { iso: string | null | undefined }) {
  return (
    <span className="qapaqLastEvent">
      Último evento: <Timestamp iso={iso ?? null} />
    </span>
  );
}
