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
  DEGRADED_REASON_LABEL,
  NOTIFICATION_STATUS_LABEL,
  NotificationStatus,
  OPERATIONS_STATUS_LABEL,
  OPERATIONS_TONE,
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
                          ? 'Sin dato (aún no medida)'
                          : data.sections.summary.sourceCoverage,
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
                        title: 'Cola de salida',
                        description: (
                          <span className="qapaqTabular">
                            {data.sections.soc.outbox.pending} pendientes ·{' '}
                            {data.sections.soc.outbox.processing} en curso · más antigua{' '}
                            {duration(data.sections.soc.outbox.oldestPendingAgeSeconds)}
                          </span>
                        ),
                      },
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
