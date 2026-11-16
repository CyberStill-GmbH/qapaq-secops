/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
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
  CORRELATOR_FEEDBACK_STATUS_LABEL,
  CORRELATOR_FEEDBACK_STATUS_TONE,
  DEGRADED_REASON_LABEL,
  HealthTone,
  NOTIFICATION_STATUS_LABEL,
  NotificationStatus,
  OPERATIONS_STATUS_LABEL,
  OPERATIONS_TONE,
  SocCorrelatorHealth,
  OperationsHealth,
  OperationsStatus,
} from '../../common';
import { QapaqPage, QapaqSection, useChanges, useConsole } from './console_context';
import { ErrorCallout, HealthMark, Timestamp, useAsync } from './primitives';

function duration(seconds: number | null): string {
  if (seconds === null) return 'Sin dato';
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}

export function formatLatencySummary(
  p50: number | null,
  p95: number,
  p99: number | null,
  sampleCount: number,
): string {
  return `p50 ${Math.round(p50 ?? 0)} ms · p95 ${Math.round(p95)} ms · p99 ${Math.round(p99 ?? p95)} ms · ${sampleCount} ${sampleCount === 1 ? 'muestra' : 'muestras'}`;
}

export function formatOutboxQueueSummary(input: {
  pending: number;
  processing: number;
  oldestPendingAgeSeconds: number | null;
  expiredProcessing: number;
  oldestExpiredLeaseAgeSeconds: number | null;
}): string {
  const expired =
    input.expiredProcessing > 0
      ? ` · lease más antiguo vencido hace ${duration(input.oldestExpiredLeaseAgeSeconds)}`
      : '';
  return `${input.pending} pendientes · ${input.processing} en curso · más antigua ${duration(input.oldestPendingAgeSeconds)} · ${input.expiredProcessing} leases vencidos${expired}`;
}

export function describeCorrelatorHealth(
  correlator: SocCorrelatorHealth | null | undefined,
): { label: string; tone: HealthTone } {
  if (!correlator) return { label: 'Sin respuesta', tone: 'neutral' };

  if (correlator.feedbackStatus === 'stale') {
    const age = correlator.feedbackAgeSeconds;
    return {
      label: age === null ? 'Atrasado · edad sin dato' : `Atrasado · ${duration(age)} sin refresh`,
      tone: CORRELATOR_FEEDBACK_STATUS_TONE.stale,
    };
  }

  if (correlator.feedbackStatus === 'ready') {
    if (correlator.ready === true && correlator.status === 'OK') {
      return {
        label: CORRELATOR_FEEDBACK_STATUS_LABEL.ready,
        tone: CORRELATOR_FEEDBACK_STATUS_TONE.ready,
      };
    }
    if (correlator.ready === false || correlator.status === 'DEGRADED') {
      return { label: 'Degradado', tone: 'warn' };
    }
    if (correlator.ready === null) return { label: 'Sin respuesta', tone: 'neutral' };
  }

  return {
    label: CORRELATOR_FEEDBACK_STATUS_LABEL[correlator.feedbackStatus],
    tone: CORRELATOR_FEEDBACK_STATUS_TONE[correlator.feedbackStatus],
  };
}

function SectionPanel({
  title,
  status,
  reasons,
  children,
}: {
  title: string;
  status: OperationsStatus;
  reasons?: readonly string[];
  children: React.ReactNode;
}) {
  return (
    <EuiPanel hasBorder paddingSize="m" className="qapaqSourceCard">
      <EuiTitle size="xs">
        <h2>{title}</h2>
      </EuiTitle>
      <EuiSpacer size="xs" />
      <HealthMark tone={OPERATIONS_TONE[status]} label={OPERATIONS_STATUS_LABEL[status]} />
      {reasons && reasons.length > 0 && (
        <ul className="qapaqList">
          {reasons.map((reason) => (
            <li key={reason}>{DEGRADED_REASON_LABEL[reason] ?? reason}</li>
          ))}
        </ul>
      )}
      <EuiSpacer size="m" />
      {children}
    </EuiPanel>
  );
}

/** Salud operativa (doc 12): ¿llegan los datos y funciona el despacho? Secciones por capacidad. */
export function OperationsView({ embedded = false }: { embedded?: boolean }) {
  const { can } = useConsole();
  // El backend autoriza cada sección; sin ninguna capacidad de observabilidad no se consulta.
  const allowed =
    can(CAPABILITIES.observabilitySoc) ||
    can(CAPABILITIES.observabilityPlatform) ||
    can(CAPABILITIES.sourcesRead);
  if (!allowed) return null;
  return <OperationsContent embedded={embedded} />;
}

function OperationsContent({ embedded }: { embedded: boolean }) {
  const { api } = useConsole();
  const health = useAsync(() => api.get<OperationsHealth>('/operations/health'), [api]);
  useChanges(['source', 'notification'], () => health.reload(), 2000);

  const data = health.data;
  const Frame = embedded ? QapaqSection : QapaqPage;
  return (
    <Frame
      title="Salud operativa"
      description="Frescura de las alertas, despacho de notificaciones y estado de la plataforma."
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
      {data && (
        <>
          <HealthMark
            tone={OPERATIONS_TONE[data.status]}
            label={`Global: ${OPERATIONS_STATUS_LABEL[data.status]}`}
          />
          <EuiText size="xs" color="subdued">
            <p>
              Generado <Timestamp iso={data.generatedAt} />
            </p>
          </EuiText>
          <EuiSpacer size="m" />
          <EuiFlexGrid columns={3} gutterSize="m" responsive>
            <EuiFlexItem>
              <SectionPanel title="Detección" status={data.sections.summary.status}>
                <EuiDescriptionList
                  type="responsiveColumn"
                  compressed
                  className="qapaqFacts"
                  listItems={[
                    {
                      title: 'Última alerta',
                      description: <Timestamp iso={data.sections.summary.lastAlertAt} />,
                    },
                    {
                      title: 'Antigüedad',
                      description: duration(data.sections.summary.alertFreshnessSeconds),
                    },
                    {
                      title: 'Cobertura por fuente',
                      description:
                        data.sections.summary.sourceCoverage === 'NO_DATA'
                          ? 'Sin medición disponible'
                          : (OPERATIONS_STATUS_LABEL[
                              data.sections.summary.sourceCoverage as OperationsStatus
                            ] ?? data.sections.summary.sourceCoverage),
                    },
                  ]}
                />
              </SectionPanel>
            </EuiFlexItem>
            {data.sections.soc && (
              <EuiFlexItem>
                <SectionPanel
                  title="Operación SOC"
                  status={data.sections.soc.status}
                  reasons={data.sections.soc.degradedReasons}
                >
                  <EuiDescriptionList
                    type="responsiveColumn"
                    compressed
                    className="qapaqFacts"
                    listItems={[
                      {
                        title: 'Despachador',
                        description: data.sections.soc.dispatcherRunning ? 'En marcha' : 'Detenido',
                      },
                      {
                        title: 'Correlador',
                        description: (() => {
                          const correlator = data.sections.soc?.correlator;
                          const state = describeCorrelatorHealth(correlator);
                          return (
                            <span>
                              <HealthMark tone={state.tone} label={state.label} />
                              {correlator?.lastFeedbackSuccess && (
                                <>
                                  <br />
                                  Último éxito <Timestamp iso={correlator.lastFeedbackSuccess} />
                                </>
                              )}
                            </span>
                          );
                        })(),
                      },
                      {
                        title: 'Cola de salida',
                        description: (
                          <span className="qapaqTabular">
                            {formatOutboxQueueSummary(data.sections.soc.outbox)}
                          </span>
                        ),
                      },
                      {
                        title: 'Inbox push Wazuh',
                        description: data.sections.soc.wazuhPushInbox
                          ? `${data.sections.soc.wazuhPushInbox.counts.pending} pendientes · ${data.sections.soc.wazuhPushInbox.counts.processing} en curso · ${data.sections.soc.wazuhPushInbox.counts['failed-terminal']} terminales · más antigua ${duration(data.sections.soc.wazuhPushInbox.oldestUnresolvedAgeSeconds)}`
                          : 'No configurada',
                      },
                      ...(data.sections.soc.wazuhPushInbox
                        ? [
                            {
                              title: `Push terminales (${data.sections.soc.wazuhPushInbox.terminalWindowHours} h)`,
                              description: (
                                <>
                                  {data.sections.soc.wazuhPushInbox.terminalFailuresRecent} fallidas
                                  · {data.sections.soc.wazuhPushInbox.expiredProcessing} leases
                                  vencidos · último éxito{' '}
                                  {data.sections.soc.wazuhPushInbox.lastProcessedAt ? (
                                    <Timestamp
                                      iso={data.sections.soc.wazuhPushInbox.lastProcessedAt}
                                    />
                                  ) : (
                                    'Sin dato'
                                  )}
                                </>
                              ),
                            },
                            {
                              title: `Wazuh origen → recepción API (${data.sections.soc.wazuhPushInbox.sourceToReceiptMs.windowHours} h)`,
                              description: (() => {
                                const latency = data.sections.soc.wazuhPushInbox?.sourceToReceiptMs;
                                if (!latency || latency.sampleCount === 0 || latency.p95 === null) {
                                  return 'Sin muestras válidas en la ventana';
                                }
                                return `p50 ${Math.round(latency.p50 ?? 0)} ms · p95 ${Math.round(latency.p95)} ms · p99 ${Math.round(latency.p99 ?? latency.p95)} ms · ${latency.sampleCount} muestras${latency.clockSkewSamples > 0 ? ` · ${latency.clockSkewSamples} excluidas por reloj` : ''}${latency.sampleCapReached ? ' · limitada a 10 000 receipts' : ''}`;
                              })(),
                            },
                            {
                              title: `Recepción → fin del handler (${data.sections.soc.wazuhPushInbox.receiptToHandlerMs.windowHours} h)`,
                              description: (() => {
                                const latency =
                                  data.sections.soc.wazuhPushInbox?.receiptToHandlerMs;
                                if (!latency || latency.sampleCount === 0 || latency.p95 === null) {
                                  return 'Sin muestras completadas';
                                }
                                return formatLatencySummary(
                                  latency.p50,
                                  latency.p95,
                                  latency.p99,
                                  latency.sampleCount,
                                );
                              })(),
                            },
                          ]
                        : []),
                      {
                        title: `Notificaciones (${data.sections.soc.notifications.windowHours} h)`,
                        description:
                          Object.keys(data.sections.soc.notifications.byStatus).length === 0
                            ? 'Ninguna'
                            : Object.entries(data.sections.soc.notifications.byStatus)
                                .map(
                                  ([status, count]) =>
                                    `${NOTIFICATION_STATUS_LABEL[status as NotificationStatus] ?? status}: ${count}`,
                                )
                                .join(' · '),
                      },
                      {
                        title: `Outbox → aceptación del proveedor (${data.sections.soc.outboxToProviderAcceptanceMs.windowHours} h)`,
                        description: (() => {
                          const latency = data.sections.soc.outboxToProviderAcceptanceMs;
                          if (latency.status === 'NO_DATA' || latency.sampleCount === 0) {
                            return (
                              <span>
                                Sin muestras aceptadas con HTTP 2xx. La aceptación significa que el
                                proveedor recibió la solicitud; no acredita lectura ni que un
                                workflow haya publicado una tarjeta.
                              </span>
                            );
                          }
                          return (
                            <span>
                              p50 {latency.p50 ?? '—'} ms · p95 {latency.p95 ?? '—'} ms · p99{' '}
                              {latency.p99 ?? '—'} ms · {latency.sampleCount} muestras
                              {latency.excludedClockSkewCount > 0
                                ? ` · ${latency.excludedClockSkewCount} excluidas por reloj`
                                : ''}
                              {latency.sampleCapReached
                                ? ' · ventana limitada a 10 000 mensajes'
                                : ''}
                              <br />
                              HTTP 2xx = aceptado por el proveedor; no significa leído ni confirma
                              que un workflow publicara una tarjeta.
                            </span>
                          );
                        })(),
                      },
                      {
                        title: 'Persistencia',
                        description:
                          data.sections.soc.persistence === 'postgres'
                            ? 'PostgreSQL'
                            : 'En memoria',
                      },
                    ]}
                  />
                </SectionPanel>
              </EuiFlexItem>
            )}
            {data.sections.platform && (
              <EuiFlexItem>
                <SectionPanel
                  title="Plataforma"
                  status={data.sections.platform.status}
                  reasons={data.sections.platform.degradedReasons}
                >
                  <EuiDescriptionList
                    type="responsiveColumn"
                    compressed
                    className="qapaqFacts"
                    listItems={[
                      {
                        title: 'Base de datos',
                        description:
                          data.sections.platform.databaseLatencyMs === null
                            ? 'Sin respuesta'
                            : `${data.sections.platform.databaseLatencyMs} ms`,
                      },
                      {
                        title: 'Activo desde hace',
                        description: duration(data.sections.platform.uptimeSeconds),
                      },
                      {
                        title: 'Memoria',
                        description:
                          data.sections.platform.memoryRssMb === null
                            ? 'Sin dato'
                            : `${data.sections.platform.memoryRssMb} MB`,
                      },
                      {
                        title: 'Runtime',
                        description: data.sections.platform.nodeVersion ?? 'Sin dato',
                      },
                    ]}
                  />
                </SectionPanel>
              </EuiFlexItem>
            )}
          </EuiFlexGrid>
        </>
      )}
    </Frame>
  );
}
