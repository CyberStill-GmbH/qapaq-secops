/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback } from 'react';
import { EuiButtonEmpty, EuiCallOut, EuiLoadingContent } from '@elastic/eui';
import {
  ALERTS_PATH,
  Alert,
  CAPABILITIES,
  dashboardHref,
  integrationSpec,
  LEVEL_BAND_LABEL,
  levelBand,
  Page,
  PRIORITIES,
  Priority,
  PROVIDER_DASHBOARDS,
  TopEvent,
} from '../../common';
import { useChanges, useConsole } from './console_context';
import {
  formatNumber,
  LEVEL_COLOR,
  PlatformData,
  SeverityBar,
  TrendChart,
  useInterval,
  usePlatformData,
} from './overview_parts';
import { DataZone, ErrorCallout, PriorityMark, Timestamp, useAsync } from './primitives';
import { VendorLogo } from './vendor_logo';
import { discoverUrlForQuery, vendorOfProvider } from '../../common';
import { ServiceCard, serviceModels } from './service_cards';
import { AttentionAlert, loadAttentionTop } from './attention_queue';

const REFRESH_MS = 60_000;

interface QueueSummary {
  readonly open: number;
  readonly byPriority: Readonly<Record<Priority, number>>;
  readonly top: readonly AttentionAlert[];
  readonly activeIncidents: number | null;
}

function useQueueSummary() {
  const { api, can } = useConsole();
  return useAsync<QueueSummary | null>(async () => {
    if (!can(CAPABILITIES.alertsRead)) return null;
    const [open, ...counts] = await Promise.all([
      api.get<Page<Alert>>('/alerts', { status: 'open', pageSize: 100 }),
      ...PRIORITIES.map((priority) =>
        api.get<Page<Alert>>('/alerts', { status: 'open', priority, pageSize: 1 }),
      ),
    ]);
    const incidents = can(CAPABILITIES.incidentsRead)
      ? await api
          .get<Page<unknown>>('/incidents', { status: 'active', pageSize: 1 })
          .then((page) => page.totalCount ?? page.items.length)
          .catch(() => null)
      : null;
    const byPriority = Object.fromEntries(
      PRIORITIES.map((priority, index) => [priority, counts[index].totalCount ?? 0]),
    ) as Record<Priority, number>;
    // La API ordena por prioridad + riesgo de entidad del correlador + cadena; si no responde,
    // se conserva el orden histórico sobre las alertas ya cargadas.
    const top = await loadAttentionTop(api, open.items, 6);
    return {
      open: open.totalCount ?? open.items.length,
      byPriority,
      top,
      activeIncidents: incidents,
    };
  }, [api]);
}

function firstName(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/u)[0];
  return first && !first.includes('@') ? first : null;
}

export function OverviewView({ basePath }: { basePath: string }) {
  const { session, can } = useConsole();
  const data = usePlatformData(basePath);
  const queue = useQueueSummary();
  const reloadAll = useCallback(() => {
    data.reload();
    queue.reload();
  }, [data, queue]);
  useInterval(reloadAll, REFRESH_MS);
  useChanges(['alert', 'incident'], () => queue.reload());

  const overview = data.overview.data;
  const name = firstName(session.displayName);
  return (
    <main className="qapaqPage qapaqOverview">
      <header className="qapaqHero">
        <div className="qapaqHero__text">
          <span className="qapaqHero__eyebrow">QAPAQ SecOps</span>
          <h1>Resumen del SOC</h1>
          <p>
            {name ? `Hola, ${name}. ` : ''}
            Estado de tus servicios integrados y lo que necesita atención ahora.
          </p>
        </div>
        <div className="qapaqHero__actions">
          {overview && (
            <span className="qapaqHero__updated">
              Actualizado <Timestamp iso={overview.generatedAt} />
            </span>
          )}
          <EuiButtonEmpty
            size="s"
            iconType="refresh"
            onClick={reloadAll}
            isLoading={data.overview.loading || queue.loading}
          >
            Actualizar
          </EuiButtonEmpty>
        </div>
      </header>

      {data.overview.error != null && !overview && (
        <ErrorCallout error={data.overview.error} onRetry={data.overview.reload} />
      )}
      {overview?.alertsAccess === 'forbidden' && (
        <EuiCallOut
          size="s"
          color="warning"
          iconType="lock"
          title="Tu rol no puede leer las alertas del SIEM (wazuh-alerts-*): las cifras del Indexer no se muestran."
        />
      )}

      <KpiRow data={data} queue={queue.data} queueLoading={queue.loading} basePath={basePath} />

      <section className="qapaqPanel qapaqPanel--trend" aria-labelledby="qapaq-trend-title">
        <div className="qapaqPanel__header">
          <h2 id="qapaq-trend-title">Eventos del SIEM por severidad</h2>
          <span className="qapaqPanel__meta">Todas las fuentes · wazuh-alerts-*</span>
        </div>
        {overview?.siem ? (
          <TrendChart trend24h={overview.siem.trend24h} trend7d={overview.siem.trend7d} />
        ) : data.overview.loading ? (
          <EuiLoadingContent lines={5} />
        ) : (
          <p className="qapaqPanel__empty">Sin datos del Indexer.</p>
        )}
      </section>

      <section aria-labelledby="qapaq-services-title">
        <div className="qapaqSectionTitle">
          <h2 id="qapaq-services-title">Servicios integrados</h2>
          <EuiButtonEmpty size="xs" href={`${basePath}/app/qapaq-integrations`} flush="right">
            Ver integraciones y permisos
          </EuiButtonEmpty>
        </div>
        <div className="qapaqServiceGrid">
          {serviceModels(data).map((model) => (
            <ServiceCard key={model.spec.id} model={model} basePath={basePath} compact />
          ))}
        </div>
      </section>

      <div className="qapaqSplit">
        {can(CAPABILITIES.alertsRead) && (
          <section className="qapaqPanel" aria-labelledby="qapaq-attention-title">
            <div className="qapaqPanel__header">
              <h2 id="qapaq-attention-title">Alertas que requieren atención</h2>
              <EuiButtonEmpty size="xs" href={`${basePath}${ALERTS_PATH}`} flush="right">
                Ir a la cola
              </EuiButtonEmpty>
            </div>
            {queue.error != null ? (
              <ErrorCallout error={queue.error} onRetry={queue.reload} />
            ) : !queue.data ? (
              <EuiLoadingContent lines={5} />
            ) : queue.data.top.length === 0 ? (
              <p className="qapaqPanel__empty">No hay alertas abiertas. La cola está al día.</p>
            ) : (
              <ol className="qapaqFeed">
                {queue.data.top.map((alert) => (
                  <li key={alert.id}>
                    <a
                      className="qapaqFeed__item"
                      href={`${basePath}${ALERTS_PATH}?id=${encodeURIComponent(alert.id)}`}
                    >
                      <PriorityMark priority={alert.priority} />
                      <span className="qapaqFeed__body">
                        <DataZone className="qapaqFeed__title">{alert.title}</DataZone>
                        {alert.attention?.why ? (
                          <span
                            className="qapaqFeed__why"
                            title="Contexto del correlador de riesgo QAPAQ"
                          >
                            {alert.attention.why}
                          </span>
                        ) : null}
                      </span>
                      <span className="qapaqFeed__time">
                        <Timestamp iso={alert.occurredAt} />
                      </span>
                    </a>
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
        <section className="qapaqPanel" aria-labelledby="qapaq-events-title">
          <div className="qapaqPanel__header">
            <h2 id="qapaq-events-title">Eventos relevantes del SIEM</h2>
            <span className="qapaqPanel__meta">Nivel ≥ 8 · 7 días</span>
          </div>
          {!overview ? (
            data.overview.loading ? (
              <EuiLoadingContent lines={5} />
            ) : (
              <p className="qapaqPanel__empty">Sin datos del Indexer.</p>
            )
          ) : overview.topEvents.length === 0 ? (
            <p className="qapaqPanel__empty">Ningún evento de severidad alta o crítica en 7 días.</p>
          ) : (
            <ol className="qapaqFeed">
              {overview.topEvents.map((event) => (
                <TopEventItem key={event.id} event={event} basePath={basePath} />
              ))}
            </ol>
          )}
        </section>
      </div>
    </main>
  );
}

function TopEventItem({ event, basePath }: { event: TopEvent; basePath: string }) {
  const band = levelBand(event.level);
  const source = event.provider ? integrationSpec(event.provider).name : (event.agent ?? 'Wazuh');
  const href = event.provider
    ? `${basePath}${dashboardHref(PROVIDER_DASHBOARDS[event.provider])}`
    : `${basePath}/app/threat-hunting`;
  return (
    <li>
      <a className="qapaqFeed__item" href={href}>
        <span className="qapaqLevel" style={{ borderColor: LEVEL_COLOR[band] }}>
          <span className="qapaqTabular">{event.level}</span>
          <span className="qapaqLevel__label">{LEVEL_BAND_LABEL[band]}</span>
        </span>
        <span className="qapaqFeed__body">
          <DataZone className="qapaqFeed__title">{event.description}</DataZone>
          <span className="qapaqFeed__meta">
            <VendorLogo id={vendorOfProvider(event.provider)} basePath={basePath} size="s" decorative />{' '}
            {source} · regla {event.ruleId}
          </span>
        </span>
        <span className="qapaqFeed__time">
          <Timestamp iso={event.at || null} />
        </span>
      </a>
    </li>
  );
}

function KpiRow({
  data,
  queue,
  queueLoading,
  basePath,
}: {
  data: PlatformData;
  queue: QueueSummary | null;
  queueLoading: boolean;
  basePath: string;
}) {
  const overview = data.overview.data;
  const agents = overview?.agents;
  const siem = overview?.siem;
  const pending = <span className="qapaqKpi__pending">—</span>;
  return (
    <div className="qapaqKpiRow">
      <a className="qapaqKpi" href={`${basePath}${ALERTS_PATH}`}>
        <span className="qapaqKpi__label">Alertas abiertas</span>
        <span className="qapaqKpi__value qapaqTabular">
          {queue ? formatNumber(queue.open) : queueLoading ? pending : '—'}
        </span>
        <span className="qapaqKpi__sub">
          {queue
            ? PRIORITIES.filter((p) => p !== 'P4').map((priority) => (
                <span key={priority} className="qapaqKpi__chip">
                  <PriorityMark priority={priority} />
                  <strong className="qapaqTabular">{formatNumber(queue.byPriority[priority])}</strong>
                </span>
              ))
            : 'Cola QAPAQ no disponible'}
        </span>
      </a>
      <div className="qapaqKpi">
        <span className="qapaqKpi__label">Eventos SIEM · 24 h</span>
        <span className="qapaqKpi__value qapaqTabular">
          {siem ? formatNumber(siem.total24h) : data.overview.loading ? pending : '—'}
        </span>
        {siem ? (
          <>
            <SeverityBar levels={siem.levels24h} label="Eventos 24 h por severidad" />
            <a
              className="qapaqKpi__sub qapaqKpi__drill"
              href={discoverUrlForQuery(basePath, 'rule.level >= 8', 'now-24h', 'now')}
            >
              {formatNumber(siem.levels24h.high + siem.levels24h.critical)} altas o críticas →
            </a>
          </>
        ) : (
          <span className="qapaqKpi__sub">wazuh-alerts-*</span>
        )}
      </div>
      <a className="qapaqKpi" href={`${basePath}/app/endpoints-summary`}>
        <span className="qapaqKpi__label">Agentes activos</span>
        <span className="qapaqKpi__value qapaqTabular">
          {agents && agents.total > 0
            ? `${formatNumber(agents.active)}/${formatNumber(agents.total)}`
            : data.overview.loading
              ? pending
              : '—'}
        </span>
        <span className="qapaqKpi__sub">
          {agents && agents.disconnected > 0
            ? `${agents.disconnected} desconectado${agents.disconnected === 1 ? '' : 's'}`
            : siem
              ? `${formatNumber(siem.agentsWithAlerts24h)} con alertas en 24 h`
              : overview?.monitoringAccess === 'forbidden'
                ? 'Sin permiso sobre wazuh-monitoring-*'
                : 'Wazuh'}
        </span>
      </a>
      <a className="qapaqKpi" href={`${basePath}/app/qapaq-incidents`}>
        <span className="qapaqKpi__label">Incidentes activos</span>
        <span className="qapaqKpi__value qapaqTabular">
          {queue && queue.activeIncidents !== null
            ? formatNumber(queue.activeIncidents)
            : queueLoading
              ? pending
              : '—'}
        </span>
        <span className="qapaqKpi__sub">Abiertos, contenidos o erradicados</span>
      </a>
    </div>
  );
}
