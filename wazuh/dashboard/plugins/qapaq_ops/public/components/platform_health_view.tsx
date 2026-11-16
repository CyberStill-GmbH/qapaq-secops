/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { EuiBasicTable, EuiButtonEmpty, EuiCallOut, EuiSpacer } from '@elastic/eui';
import {
  currentSourceState,
  HealthTone,
  PLATFORM_HEALTH_DOC,
  PLATFORM_SOURCE_LABEL,
  PLATFORM_STATE_LABEL,
  PlatformProblem,
  PlatformSourceState,
} from '../../common';
import { fetchOverview } from '../api/overview';
import { QapaqSection } from './console_context';
import { DataZone, EmptyLine, ErrorCallout, HealthMark, Mono, Timestamp, useAsync } from './primitives';

const STATE_TONE: Record<PlatformSourceState, HealthTone> = {
  ok: 'ok',
  silent: 'warn',
  failing: 'fail',
  disabled: 'neutral',
  unknown: 'neutral',
};

const SEVERITY_TONE: Record<PlatformProblem['severity'], HealthTone> = {
  critical: 'fail',
  warning: 'warn',
  info: 'info',
};

const SEVERITY_LABEL: Record<PlatformProblem['severity'], string> = {
  critical: 'Crítico',
  warning: 'Aviso',
  info: 'Info',
};

/**
 * «Salud de la plataforma»: último `source_status` por fuente y problemas abiertos del monitor QAPAQ
 * (docs/20). Lee `wazuh-alerts-*` con la identidad de quien mira (ruta del resumen).
 */
export function PlatformHealthSection({ basePath }: { basePath: string }) {
  const overview = useAsync(() => fetchOverview(basePath), [basePath]);
  const health = overview.data?.platformHealth ?? null;
  const now = Date.now();
  const sources = health
    ? Object.keys(health.sources)
        .sort()
        .map((source) => currentSourceState(health, source, now)!)
    : [];

  return (
    <QapaqSection
      title="Salud de la plataforma"
      description="Monitor QAPAQ: estado de cada fuente y colector, y los problemas que siguen abiertos. Un estado de más de 2 h se muestra como «sin dato reciente»."
      actions={
        <>
          <EuiButtonEmpty size="s" iconType="refresh" onClick={overview.reload}>
            Actualizar
          </EuiButtonEmpty>
          <EuiButtonEmpty
            size="s"
            iconType="help"
            href={PLATFORM_HEALTH_DOC}
            target="_blank"
            rel="noopener noreferrer"
          >
            Cómo funciona (docs/20)
          </EuiButtonEmpty>
        </>
      }
    >
      {overview.error ? (
        <ErrorCallout error={overview.error} onRetry={overview.reload} />
      ) : overview.loading && !overview.data ? (
        <EmptyLine>Consultando el monitor de plataforma…</EmptyLine>
      ) : !health ? (
        <EmptyLine>
          Esta versión del dashboard no recibió datos del monitor. Recarga la página.
        </EmptyLine>
      ) : health.access !== 'ok' ? (
        <EuiCallOut
          size="s"
          color="warning"
          iconType="lock"
          title={
            health.access === 'forbidden'
              ? 'Tu rol no puede leer wazuh-alerts-*: no se puede mostrar la salud de la plataforma.'
              : 'El Indexer no respondió a la consulta del monitor.'
          }
        />
      ) : sources.length === 0 ? (
        <EmptyLine>
          El monitor de plataforma no publicó estados en las últimas 24 h
          (rule.groups: qapaq_platform_health). Revisa que el servicio de monitoreo esté activo.
        </EmptyLine>
      ) : (
        <DataZone>
          <ul className="qapaqPlatformSources">
            {sources.map((item) => (
              <li key={item.source} className="qapaqPlatformSource" data-state={item.state}>
                <span className="qapaqPlatformSource__name">
                  {PLATFORM_SOURCE_LABEL[item.source] ?? item.source}
                </span>
                <HealthMark tone={STATE_TONE[item.state]} label={PLATFORM_STATE_LABEL[item.state]} />
                <span className="qapaqPlatformSource__time">
                  <Timestamp iso={item.at || null} />
                </span>
                {item.summary && item.state !== 'ok' && (
                  <span className="qapaqPlatformSource__summary">{item.summary}</span>
                )}
              </li>
            ))}
          </ul>
          <EuiSpacer size="l" />
          <EuiBasicTable<PlatformProblem>
            items={health.problems as PlatformProblem[]}
            tableCaption="Problemas abiertos del monitor de plataforma"
            noItemsMessage="Sin problemas abiertos: cada alerta del monitor tiene su recuperación."
            responsive
            columns={[
              {
                field: 'severity',
                name: 'Severidad',
                width: '120px',
                render: (value: PlatformProblem['severity']) => (
                  <HealthMark tone={SEVERITY_TONE[value]} label={SEVERITY_LABEL[value]} />
                ),
              },
              {
                field: 'summary',
                name: 'Problema',
                render: (value: string, item: PlatformProblem) => (
                  <span className="qapaqCellTitle">
                    <span>{value || item.check}</span>
                    <span className="qapaqCellMeta">
                      {PLATFORM_SOURCE_LABEL[item.source] ?? item.source} · {item.check}
                      {item.value
                        ? ` · ${item.value}${item.unit ? ` ${item.unit}` : ''}${
                            item.threshold ? ` (umbral ${item.threshold})` : ''
                          }`
                        : ''}
                    </span>
                  </span>
                ),
              },
              {
                field: 'since',
                name: 'Desde',
                width: '140px',
                render: (value: string | null, item: PlatformProblem) => (
                  <Timestamp iso={value || item.at || null} />
                ),
              },
              {
                field: 'key',
                name: 'Clave',
                width: '200px',
                render: (value: string) => <Mono>{value}</Mono>,
              },
            ]}
          />
        </DataZone>
      )}
    </QapaqSection>
  );
}
