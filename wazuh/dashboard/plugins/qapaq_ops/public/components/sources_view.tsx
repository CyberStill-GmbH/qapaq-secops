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

/** Streams medidos por la API: suscripciones de Office 365 y proveedores por grupo de regla. */
const STREAM_LABEL: Readonly<Record<string, string>> = {
  'Audit.AzureActiveDirectory': 'Entra ID',
  'Audit.Exchange': 'Exchange',
  'Audit.SharePoint': 'SharePoint',
  'Audit.General': 'Microsoft 365 General',
  'provider.bitdefender': 'Bitdefender GravityZone',
  'provider.snyk': 'Snyk',
  'provider.cloudflare': 'Cloudflare',
  'provider.aws': 'AWS',
};

function minutes(ms: number): string {
  const value = Math.round(ms / 60000);
  return value === 1 ? '1 min' : `${value} min`;
}

function lag(value: number | null): string {
  if (value === null) return 'Sin muestra';
  if (value < 1_000) return `${value} ms`;
  return `${(value / 1_000).toFixed(1)} s`;
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
          { title: 'Último evento de fuente', description: <Timestamp iso={source.lastEventAt} /> },
          {
            title: 'Lag evento → fin de lectura',
            description: (
              <>
                <span className="qapaqTabular">
                  p50 {lag(source.eventLag.p50Ms)} · p95 {lag(source.eventLag.p95Ms)} · p99{' '}
                  {lag(source.eventLag.p99Ms)} · muestras {source.eventLag.sampleCount}/
                  {source.eventLag.sampleWindow}
                  {source.eventLag.clockSkewSamples > 0
                    ? ` · skew ${source.eventLag.clockSkewSamples}`
                    : ''}
                </span>
                <br />
                Medido <Timestamp iso={source.eventLag.measuredAt} />
              </>
            ),
          },
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
      <ProcessingSummary processing={source.processing} />
      <SubscriptionActivity subscriptions={source.subscriptions} />
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

export function ProcessingSummary({ processing }: { processing: SourceHealth['processing'] }) {
  return (
    <>
      <EuiSpacer size="m" />
      <EuiTitle size="xxs">
        <h3>Último sondeo y procesamiento</h3>
      </EuiTitle>
      {processing ? (
        <>
          <EuiText size="xs" color="subdued">
            <p>
              Completado <Timestamp iso={processing.completedAt} /> · estado{' '}
              {processing.outcome === 'success'
                ? 'correcto'
                : processing.outcome === 'retryable_error'
                  ? 'error reintentable'
                  : 'error permanente'}
              {processing.errorClass ? ` · ${processing.errorClass}` : ''}
            </p>
          </EuiText>
          <EuiDescriptionList
            type="responsiveColumn"
            compressed
            className="qapaqFacts"
            listItems={[
              {
                title: 'Documentos devueltos',
                description: <span className="qapaqTabular">{processing.recordsSeen}</span>,
              },
              { title: 'Normalizados', description: processingCount(processing.normalized) },
              {
                title: 'En cuarentena',
                description: <span className="qapaqTabular">{processing.quarantined}</span>,
              },
              {
                title: 'Alertas creadas',
                description: <span className="qapaqTabular">{processing.promoted}</span>,
              },
              { title: 'Duplicados', description: processingCount(processing.duplicates) },
              { title: 'Sin promoción', description: processingCount(processing.notPromoted) },
              { title: 'Bajo umbral QAPAQ', description: processingCount(processing.belowThreshold) },
              {
                title: 'Suprimidos por política',
                description: processingCount(processing.suppressed),
              },
            ]}
          />
          <EuiText size="xs" color="subdued">
            <p>
              “Bajo umbral QAPAQ” no alcanzó el puntaje mínimo; “Suprimidos” coincide con una regla
              benigna o ventana de mantenimiento. “Documentos devueltos” cuenta los resultados del
              sondeo, no la actividad total de la fuente.
            </p>
          </EuiText>
        </>
      ) : (
        <EuiText size="xs" color="subdued">
          <p>Aún no hay un sondeo registrado para esta fuente.</p>
        </EuiText>
      )}
    </>
  );
}

export function processingCount(value: number | null): string {
  return value === null ? 'Sin desglose histórico' : String(value);
}

/** Separates a missing measurement from a successful measurement whose streams are quiet. */
export function SubscriptionActivity({
  subscriptions,
}: {
  subscriptions: SourceHealth['subscriptions'];
}) {
  if (!subscriptions) {
    return (
      <>
        <EuiSpacer size="m" />
        <EuiText size="xs" color="subdued">
          <p>Actividad por flujo: aún no hay una medición disponible.</p>
        </EuiText>
      </>
    );
  }

  return (
    <>
      <EuiSpacer size="m" />
      <EuiTitle size="xxs">
        <h3>Actividad por flujo (últimas {subscriptions.windowHours} h)</h3>
      </EuiTitle>
      <EuiText size="xs" color="subdued">
        <p>
          Medida <Timestamp iso={subscriptions.measuredAt} />
        </p>
      </EuiText>
      <EuiSpacer size="s" />
      {subscriptions.items.length === 0 ? (
        <EmptyLine>La medición terminó; no hay flujos registrados.</EmptyLine>
      ) : (
        <EuiBasicTable<SubscriptionItem>
          compressed
          responsive
          items={[...subscriptions.items]}
          columns={[
            {
              field: 'stream',
              name: 'Flujo',
              render: (value: string) =>
                STREAM_LABEL[value] ? (
                  <span>
                    {STREAM_LABEL[value]} <Mono>{value}</Mono>
                  </span>
                ) : (
                  <Mono>{value}</Mono>
                ),
            },
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
      )}
    </>
  );
}
