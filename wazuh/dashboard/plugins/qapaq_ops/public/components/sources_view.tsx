/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  EuiBasicTable,
  EuiButtonEmpty,
  EuiDescriptionList,
  EuiFlexGrid,
  EuiFlexItem,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import {
  CAPABILITIES,
  SOURCE_REASON_LABEL,
  SOURCE_STATE_LABEL,
  SOURCE_TONE,
  SourceHealth,
} from '../../common';
import { QapaqPage, useChanges, useConsole } from './console_context';
import { EmptyLine, ErrorCallout, HealthMark, Mono, Timestamp, useAsync } from './primitives';

function minutes(ms: number): string {
  const value = Math.round(ms / 60000);
  return value === 1 ? '1 min' : `${value} min`;
}

export function SourcesView() {
  const { can } = useConsole();
  if (!can(CAPABILITIES.sourcesRead)) {
    return (
      <QapaqPage title="Salud de fuentes">
        <EmptyLine>Tu rol no incluye la lectura de la salud de las fuentes.</EmptyLine>
      </QapaqPage>
    );
  }
  return <SourcesContent />;
}

function SourcesContent() {
  const { api } = useConsole();
  const health = useAsync(
    () => api.get<{ checkedAt: string; sources: SourceHealth[] }>('/sources/health'),
    [api],
  );
  useChanges(['source'], () => health.reload());

  return (
    <QapaqPage
      title="Salud de fuentes"
      description="Estado de la ingesta que alimenta la cola: cuándo se leyó por última vez y por qué está así."
      actions={
        <EuiButtonEmpty
          size="s"
          iconType="refresh"
          onClick={health.reload}
          isLoading={health.loading}
        >
          Actualizar
        </EuiButtonEmpty>
      }
    >
      {health.error != null && <ErrorCallout error={health.error} onRetry={health.reload} />}
      {health.data && (
        <>
          <EuiText size="xs" color="subdued">
            <p>
              Comprobado <Timestamp iso={health.data.checkedAt} />
            </p>
          </EuiText>
          <EuiSpacer size="m" />
          {health.data.sources.length === 0 ? (
            <EmptyLine>No hay fuentes configuradas para este tenant.</EmptyLine>
          ) : (
            <EuiFlexGrid columns={2} gutterSize="m" responsive>
              {health.data.sources.map((source) => (
                <EuiFlexItem key={`${source.sourceId}:${source.dataset}`}>
                  <SourceCard source={source} />
                </EuiFlexItem>
              ))}
            </EuiFlexGrid>
          )}
        </>
      )}
    </QapaqPage>
  );
}

type SubscriptionItem = NonNullable<SourceHealth['subscriptions']>['items'][number];

function SourceCard({ source }: { source: SourceHealth }) {
  return (
    <EuiPanel hasBorder paddingSize="m" className="qapaqSourceCard">
      <EuiTitle size="xs">
        <h2>{source.displayName}</h2>
      </EuiTitle>
      <EuiSpacer size="xs" />
      <HealthMark tone={SOURCE_TONE[source.state]} label={SOURCE_STATE_LABEL[source.state]} />
      <EuiText size="xs" color="subdued">
        <p>{SOURCE_REASON_LABEL[source.reason] ?? source.reason}</p>
      </EuiText>
      <EuiSpacer size="m" />
      <EuiDescriptionList
        type="responsiveColumn"
        compressed
        className="qapaqFacts"
        listItems={[
          { title: 'Fuente', description: <Mono>{`${source.sourceId} · ${source.dataset}`}</Mono> },
          { title: 'Último intento', description: <Timestamp iso={source.lastAttemptAt} /> },
          {
            title: 'Última lectura correcta',
            description: <Timestamp iso={source.lastSuccessAt} />,
          },
          { title: 'Último evento recibido', description: <Timestamp iso={source.lastEventAt} /> },
          {
            title: 'Fallos consecutivos',
            description: (
              <span className="qapaqTabular">
                {source.consecutiveFailures}
                {source.lastErrorClass ? ` · ${source.lastErrorClass}` : ''}
              </span>
            ),
          },
          {
            title: 'Política',
            description: `cada ${minutes(source.policy.intervalMs)} · degradada a ${minutes(
              source.policy.degradeAfterMs,
            )} · caída a ${minutes(source.policy.failAfterMs)}`,
          },
        ]}
      />
      {source.subscriptions && (
        <>
          <EuiSpacer size="m" />
          <EuiTitle size="xxs">
            <h3>Actividad por flujo (últimas {source.subscriptions.windowHours} h)</h3>
          </EuiTitle>
          <EuiSpacer size="s" />
          <EuiBasicTable<SubscriptionItem>
            compressed
            responsive
            items={[...source.subscriptions.items]}
            columns={[
              { field: 'stream', name: 'Flujo', render: (value: string) => <Mono>{value}</Mono> },
              {
                field: 'eventsInWindow',
                name: 'Eventos',
                align: 'right',
                render: (value: number) => <span className="qapaqTabular">{value}</span>,
              },
              {
                field: 'lastEventAt',
                name: 'Último',
                render: (value: string | null) => <Timestamp iso={value} />,
              },
            ]}
          />
        </>
      )}
      {source.transitions.length > 0 && (
        <>
          <EuiSpacer size="m" />
          <EuiTitle size="xxs">
            <h3>Cambios recientes</h3>
          </EuiTitle>
          <EuiSpacer size="s" />
          <ol className="qapaqTimeline">
            {source.transitions.map((transition) => (
              <li key={transition.id} className="qapaqTimeline__item">
                <span className="qapaqTimeline__time">
                  <Timestamp iso={transition.at} />
                </span>
                <span className="qapaqTimeline__body">
                  <span>
                    {SOURCE_STATE_LABEL[transition.fromState]} →{' '}
                    {SOURCE_STATE_LABEL[transition.toState]}
                  </span>
                  <span className="qapaqCellMeta">
                    {SOURCE_REASON_LABEL[transition.reason] ?? transition.reason}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </EuiPanel>
  );
}
