/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EuiAccordion,
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiButtonGroup,
  EuiCallOut,
  EuiCodeBlock,
  EuiFlexGroup,
  EuiFlexItem,
  EuiLoadingContent,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiTitle,
  EuiToolTip,
} from '@elastic/eui';
import {
  Alert,
  ALERT_STATUS_LABEL,
  alertQuestion,
  CAPABILITIES,
  discoverUrlForQuery,
  ENTITY_KIND_LABEL,
  entityKey,
  EntityKind,
  entityKql,
  Incident,
  IndexerAccess,
  InvestigationEntity,
  InvestigationEvent,
  InvestigationEventSummary,
  MAX_QUERY_ENTITIES,
  mitreTechniqueUrl,
  parseEntityKey,
  RELATED_WINDOW_LABEL,
  RELATED_WINDOW_MS,
  RELATED_WINDOWS,
  RelatedWindow,
  RelatedResponse,
  selectQueryEntities,
  threatHuntingUrl,
  validEntity,
  VendorId,
  vendorOfTitle,
  VENDORS,
  wazuhRuleIdOfTitle,
} from '../../common';
import {
  EntityRisk,
  fetchEntityRisk,
  fetchEvent,
  fetchRelated,
  fetchSource,
} from '../api/investigation';
import { askQapaqzito } from '../qapaqzito_bridge';
import { OpenIncidentForm } from './alerts_view';
import { useConsole } from './console_context';
import { NotesPanel } from './incidents_view';
import {
  DataZone,
  EmptyLine,
  ErrorCallout,
  Mono,
  PriorityMark,
  Timestamp,
  useAsync,
} from './primitives';
import { entityInvestigationHref } from './investigation_links';
import { SourceBadge, VendorLogo } from './vendor_logo';
import { InvestigationActivityGroups } from './investigation_activity_groups';
import { InvestigationReportActions } from './investigation_report_actions';
import { InvestigationPagination } from './investigation_pagination';
import type { ReportEventSummary } from './investigation_report';

/**
 * Investigación de una alerta (o de una entidad suelta): evento de origen del SIEM, entidades
 * con pivotes, línea de tiempo de eventos relacionados en `wazuh-alerts-*` (misma entidad),
 * MITRE ATT&CK, JSON crudo, incidente vinculado y notas. Las consultas al Indexer van con la
 * identidad de quien mira (rutas `/api/qapaq_ops/investigation/*`, proxy auth).
 */

const ALERT_ENTITY_KIND: Record<string, EntityKind> = { user: 'user', ip: 'ip', host: 'host' };

const ACCESS_MESSAGE: Record<Exclude<IndexerAccess, 'ok'>, string> = {
  forbidden: 'Tu rol no puede leer wazuh-alerts-* en el Indexer: no hay eventos que mostrar.',
  error: 'El Indexer no respondió. Reintenta en unos segundos.',
};

function levelColor(level: number): string {
  if (level >= 15) return 'danger';
  if (level >= 12) return '#f5a35c';
  if (level >= 7) return 'warning';
  return 'hollow';
}

function levelLabel(level: number): string {
  if (level >= 15) return 'Crítica';
  if (level >= 12) return 'Alta';
  if (level >= 7) return 'Media';
  return 'Baja';
}

export function InvestigationView({
  alertId,
  entity,
  at,
  basePath,
  onOpenTriage,
}: {
  alertId: string | null;
  entity: string | null;
  at: string | null;
  basePath: string;
  onOpenTriage: (alertId: string) => void;
}) {
  const { api, notifications } = useConsole();
  const alert = useAsync(
    () =>
      alertId
        ? api.get<{ alert: Alert }>(`/alerts/${encodeURIComponent(alertId)}`).then((r) => r.alert)
        : Promise.resolve(null),
    [api, alertId],
  );
  const current = alert.data;
  const ruleId = current ? wazuhRuleIdOfTitle(current.title) : null;
  const source = useAsync(
    () =>
      current
        ? fetchSource(basePath, {
            ruleId,
            at: current.occurredAt,
            description: current.title.replace(/\s*\(wazuh \d+\)\s*$/u, ''),
          })
        : Promise.resolve(null),
    [basePath, current?.id, current?.occurredAt],
  );
  const event = source.data?.event ?? null;
  const pivot = entity ? parseEntityKey(entity) : null;
  const anchor = at ?? event?.at ?? current?.occurredAt ?? new Date().toISOString();

  const entities = useMemo<InvestigationEntity[]>(() => {
    const out: InvestigationEntity[] = [];
    const seen = new Set<string>();
    const push = (item: InvestigationEntity) => {
      const key = entityKey(item);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(item);
    };
    if (pivot) push({ ...pivot, field: '' });
    for (const item of event?.entities ?? []) push(item);
    for (const item of current?.entities ?? []) {
      const kind = ALERT_ENTITY_KIND[item.kind];
      if (kind && validEntity(kind, item.label)) push({ kind, value: item.label, field: '' });
    }
    return out;
  }, [pivot?.kind, pivot?.value, event, current]); // eslint-disable-line react-hooks/exhaustive-deps

  const vendor: VendorId = event?.vendor ?? (current ? vendorOfTitle(current.title) : 'wazuh');
  const title = current?.title ?? (pivot ? `${ENTITY_KIND_LABEL[pivot.kind]} ${pivot.value}` : '');
  const mitre = event?.mitre ?? { ids: [], tactics: [], techniques: [] };
  const exportTitle = current?.title ?? title;
  const reportSourceEvent = useMemo<ReportEventSummary | null>(
    () =>
      event
        ? {
            id: event.id,
            index: event.index,
            at: event.at,
            level: event.level,
            ruleId: event.ruleId,
            description: event.description,
            groups: event.groups,
            vendor: event.vendor,
            agent: event.agent,
            mitre: event.mitre,
            matched: event.matched,
            email: event.email,
          }
        : null,
    [event],
  );
  const [selected, setSelected] = useState<string[] | null>(null);
  const queryEntities = entities.slice(0, MAX_QUERY_ENTITIES);
  const activeEntities = selectQueryEntities(entities, selected);
  const active = activeEntities.map(entityKey);
  const [range, setRange] = useState<RelatedWindow>('24h');
  const span = RELATED_WINDOW_MS[range];
  const from = new Date(Date.parse(anchor) - span).toISOString();
  const to = new Date(Date.parse(anchor) + span).toISOString();
  const kql =
    activeEntities.length > 0 ? entityKql(activeEntities) : ruleId ? `rule.id:${ruleId}` : '';

  const loadingHeader = alertId !== null && alert.loading && !current;
  if (alertId && alert.error) {
    return (
      <main className="qapaqPage qapaqInvestigation">
        <BackLink basePath={basePath} />
        <ErrorCallout error={alert.error} onRetry={alert.reload} />
      </main>
    );
  }
  if (!alertId && !pivot) {
    return (
      <main className="qapaqPage qapaqInvestigation">
        <BackLink basePath={basePath} />
        <EuiCallOut title="No hay nada que investigar" color="warning" iconType="help">
          <p>
            La dirección no indica una alerta ni una entidad válida. Abre una alerta desde la cola.
          </p>
        </EuiCallOut>
      </main>
    );
  }

  return (
    <main className="qapaqPage qapaqInvestigation" aria-busy={loadingHeader}>
      <BackLink basePath={basePath} />
      <header className="qapaqInvestigation__header">
        <div className="qapaqInvestigation__lead">
          <VendorLogo id={vendor} basePath={basePath} size="l" />
          <div>
            <p className="qapaqEyebrow">
              {alertId ? 'Investigación de alerta' : 'Investigación de entidad'} ·{' '}
              {VENDORS[vendor].name}
            </p>
            <EuiTitle size="m">
              <h1 data-qapaq-no-translate="">{loadingHeader ? 'Cargando alerta…' : title}</h1>
            </EuiTitle>
            {current && (
              <div className="qapaqInvestigation__facts">
                <PriorityMark priority={current.priority} />
                <EuiBadge color="hollow">{ALERT_STATUS_LABEL[current.status]}</EuiBadge>
                <span>
                  <Timestamp iso={current.occurredAt} />
                </span>
                <span>
                  puntuación <span className="qapaqTabular">{current.score}</span>
                </span>
                {ruleId && (
                  <span>
                    regla <Mono>{ruleId}</Mono>
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="qapaqInvestigation__actions">
          <EuiButton
            size="s"
            fill
            iconType="discuss"
            onClick={() => {
              const opened = askQapaqzito({
                prompt: current
                  ? alertQuestion({
                      id: current.id,
                      title: current.title,
                      priority: current.priority,
                      occurredAt: current.occurredAt,
                      ruleId,
                      entities: entities.map((item) => ({ kind: item.kind, value: item.value })),
                      mitre: mitre.ids,
                    })
                  : `Ayúdame a investigar la entidad ${title}: ¿qué actividad tiene, es sospechosa y qué reviso?`,
                context: current ? { alertId: current.id } : { entity: entity ?? '' },
              });
              if (!opened) {
                // Qapaqzito no está montado en esta página (sin permiso o desactivado).
                notifications.toasts.addWarning({
                  title: 'Qapaqzito no está disponible',
                  text: 'El asistente no está activo para tu sesión en este momento.',
                });
              }
            }}
          >
            Preguntar a Qapaqzito
          </EuiButton>
          {kql && (
            <>
              <EuiButton
                size="s"
                iconType="search"
                href={threatHuntingUrl(basePath, kql, from, to)}
              >
                Abrir en Threat Hunting
              </EuiButton>
              <EuiButton
                size="s"
                iconType="discoverApp"
                href={discoverUrlForQuery(basePath, kql, from, to)}
              >
                Abrir en Discover
              </EuiButton>
            </>
          )}
          {current && (
            <EuiButton size="s" iconType="documentEdit" onClick={() => onOpenTriage(current.id)}>
              Triaje y estado
            </EuiButton>
          )}
        </div>
      </header>
      <EuiSpacer size="l" />
      <EuiFlexGroup gutterSize="l" alignItems="flexStart" responsive>
        <EuiFlexItem grow={2} className="qapaqInvestigation__main">
          <EuiPanel paddingSize="m" className="qapaqCard">
            <EuiFlexGroup
              gutterSize="s"
              alignItems="center"
              justifyContent="spaceBetween"
              responsive={false}
              wrap
            >
              <EuiFlexItem grow={false}>
                <EuiTitle size="xs">
                  <h2>Línea de tiempo de la entidad</h2>
                </EuiTitle>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiButtonGroup
                  legend="Ventana de tiempo alrededor del evento"
                  buttonSize="compressed"
                  options={RELATED_WINDOWS.map((id) => ({ id, label: RELATED_WINDOW_LABEL[id] }))}
                  idSelected={range}
                  onChange={(id) => setRange(id as RelatedWindow)}
                />
              </EuiFlexItem>
            </EuiFlexGroup>
            <EuiText size="xs" color="subdued">
              <p>
                Eventos de wazuh-alerts-* que comparten equipo, usuario, IP, proyecto, zona o cuenta
                con {alertId ? 'esta alerta' : 'esta entidad'}. Activa o quita entidades para
                filtrar.
              </p>
            </EuiText>
            <EuiSpacer size="s" />
            <div className="qapaqChips" role="group" aria-label="Entidades de la línea de tiempo">
              {queryEntities.map((item) => {
                const key = entityKey(item);
                const on = active.includes(key);
                return (
                  <button
                    type="button"
                    key={key}
                    className={`qapaqChip${on ? ' qapaqChip--on' : ''}`}
                    aria-pressed={on}
                    onClick={() =>
                      setSelected(on ? active.filter((k) => k !== key) : [...active, key])
                    }
                  >
                    <span className="qapaqChip__kind">{ENTITY_KIND_LABEL[item.kind]}</span>
                    <span data-qapaq-no-translate="">{item.value}</span>
                  </button>
                );
              })}
            </div>
            <EuiSpacer size="m" />
            {source.loading && alertId ? (
              <EuiLoadingContent lines={4} />
            ) : (
              <Timeline
                basePath={basePath}
                entities={activeEntities}
                anchor={anchor}
                window={range}
                excludeId={event?.id}
                noEntities={entities.length === 0}
              />
            )}
          </EuiPanel>
          <InvestigationReportActions
            basePath={basePath}
            alert={current}
            title={exportTitle}
            entities={activeEntities}
            at={anchor}
            relatedWindow={range}
            excludeId={event?.id}
            sourceEvent={reportSourceEvent}
          />
          <EuiSpacer size="l" />
          {alertId && (
            <SourceEvent
              basePath={basePath}
              access={source.data?.access ?? 'ok'}
              match={source.data?.match ?? 'none'}
              event={event}
              loading={source.loading}
              error={source.error}
              onRetry={source.reload}
            />
          )}
        </EuiFlexItem>
        <EuiFlexItem grow={1} className="qapaqInvestigation__side">
          <EntitiesPanel basePath={basePath} entities={entities} at={anchor} from={from} to={to} />
          {(mitre.ids.length > 0 || mitre.tactics.length > 0) && (
            <>
              <EuiSpacer size="l" />
              <MitrePanel basePath={basePath} mitre={mitre} />
            </>
          )}
          {current && (
            <>
              <EuiSpacer size="l" />
              <EuiPanel paddingSize="m" className="qapaqCard">
                <EuiTitle size="xs">
                  <h2>Por qué tiene esta prioridad</h2>
                </EuiTitle>
                <EuiSpacer size="s" />
                {current.reasons.length === 0 ? (
                  <EmptyLine>El motor de priorización no registró motivos.</EmptyLine>
                ) : (
                  <ul className="qapaqList" data-qapaq-no-translate="">
                    {current.reasons.map((reason) => (
                      <li key={reason.code}>
                        <Mono>{reason.code}</Mono> {reason.detail}
                      </li>
                    ))}
                  </ul>
                )}
              </EuiPanel>
              <EuiSpacer size="l" />
              <IncidentPanel alert={current} basePath={basePath} onChanged={alert.reload} />
            </>
          )}
        </EuiFlexItem>
      </EuiFlexGroup>
    </main>
  );
}

function BackLink({ basePath }: { basePath: string }) {
  return (
    <EuiButtonEmpty
      size="s"
      iconType="arrowLeft"
      flush="left"
      href={`${basePath}/app/qapaq-alerts`}
      className="qapaqInvestigation__back"
    >
      Cola de alertas
    </EuiButtonEmpty>
  );
}

function Timeline({
  basePath,
  entities,
  anchor,
  window,
  excludeId,
  noEntities,
}: {
  basePath: string;
  entities: InvestigationEntity[];
  anchor: string;
  window: RelatedWindow;
  excludeId?: string;
  noEntities: boolean;
}) {
  const keys = entities.map(entityKey).join('|');
  const related = useAsync(
    () =>
      entities.length === 0
        ? Promise.resolve(null)
        : fetchRelated(basePath, { entities, at: anchor, window, exclude: excludeId }),
    [basePath, keys, anchor, window, excludeId],
  );
  const data = related.loading ? null : related.data;
  const requestKey = JSON.stringify([keys, anchor, window, excludeId ?? '']);
  const [pageState, setPageState] = useState<{
    key: string;
    pages: RelatedResponse[];
    loading: boolean;
    error: unknown | null;
  }>({ key: requestKey, pages: [], loading: false, error: null });
  const pages = pageState.key === requestKey ? pageState.pages : [];
  const loadingMore = pageState.key === requestKey && pageState.loading;
  const pageError = pageState.key === requestKey ? pageState.error : null;
  const continuationCursor =
    pages.length > 0 ? pages[pages.length - 1].nextCursor : data?.nextCursor;
  const allEvents = useMemo(
    () => (data?.access === 'ok' ? [...data.events, ...pages.flatMap((page) => page.events)] : []),
    [data, pages],
  );
  const loadMore = useCallback(async () => {
    const cursor = continuationCursor;
    if (!cursor || loadingMore) return;
    setPageState((current) => ({
      key: requestKey,
      pages: current.key === requestKey ? current.pages : [],
      loading: true,
      error: null,
    }));
    try {
      const page = await fetchRelated(basePath, {
        entities,
        at: anchor,
        window,
        exclude: excludeId,
        cursor,
      });
      if (page.access !== 'ok') {
        throw new Error(
          page.access === 'forbidden'
            ? ACCESS_MESSAGE.forbidden
            : 'El Indexer no respondió a esta página. Reintenta o reinicia la consulta.',
        );
      }
      setPageState((current) =>
        current.key === requestKey
          ? { ...current, pages: [...current.pages, page], loading: false, error: null }
          : current,
      );
    } catch (error) {
      setPageState((current) =>
        current.key === requestKey ? { ...current, loading: false, error } : current,
      );
    }
  }, [
    anchor,
    basePath,
    continuationCursor,
    entities,
    excludeId,
    loadingMore,
    pages,
    requestKey,
    window,
  ]);
  const resetPages = useCallback(() => {
    setPageState({ key: requestKey, pages: [], loading: false, error: null });
    void related.reload();
  }, [related.reload, requestKey]);
  useEffect(() => {
    setPageState({ key: requestKey, pages: [], loading: false, error: null });
  }, [requestKey]);
  if (noEntities) {
    return (
      <EmptyLine>
        El evento no trae entidades (equipo, usuario, IP, proyecto, zona o cuenta) con las que
        correlacionar. Usa «Abrir en Threat Hunting» para buscar por la regla.
      </EmptyLine>
    );
  }
  if (entities.length === 0) {
    return <EmptyLine>Activa al menos una entidad para ver su línea de tiempo.</EmptyLine>;
  }
  if (related.loading) return <EuiLoadingContent lines={5} />;
  if (related.error) return <ErrorCallout error={related.error} onRetry={resetPages} />;
  if (!data) return null;
  if (data.access !== 'ok') {
    return (
      <EuiCallOut size="s" color="warning" iconType="lock" title={ACCESS_MESSAGE[data.access]} />
    );
  }
  if (data.events.length === 0 && pages.length === 0) {
    return (
      <EmptyLine>
        Sin otros eventos de estas entidades en {RELATED_WINDOW_LABEL[window]} alrededor del evento.
        Amplía la ventana para buscar más atrás.
      </EmptyLine>
    );
  }
  const anchorMs = Date.parse(anchor);
  let anchorShown = false;
  return (
    <DataZone>
      <p className="qapaqInvestigation__count">
        {allEvents.length < data.total
          ? `${allEvents.length} de ${data.total} eventos cargados`
          : `${allEvents.length} eventos cargados`}{' '}
        ·{' '}
        {Object.entries(data.perEntity)
          .map(([key, count]) => `${key.slice(key.indexOf(':') + 1)}: ${count}`)
          .join(' · ')}
      </p>
      <InvestigationActivityGroups events={allEvents} />
      <ol className="qapaqTimeline">
        {allEvents.map((item) => {
          const before = !anchorShown && Date.parse(item.at) < anchorMs;
          if (before) anchorShown = true;
          return (
            <React.Fragment key={item.id}>
              {before && (
                <li className="qapaqTimeline__anchor" aria-label="Momento de la alerta">
                  <span>Momento de la alerta</span>
                </li>
              )}
              <TimelineRow basePath={basePath} item={item} />
            </React.Fragment>
          );
        })}
      </ol>
      {continuationCursor && (
        <div className="qapaqInvestigation__pagination">
          <InvestigationPagination
            loading={loadingMore}
            error={Boolean(pageError)}
            remaining={data.total - allEvents.length}
            onLoadMore={loadMore}
            onReset={resetPages}
          />
        </div>
      )}
    </DataZone>
  );
}

function TimelineRow({ basePath, item }: { basePath: string; item: InvestigationEventSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="qapaqTimeline__item" data-level={levelLabel(item.level)}>
      <div className="qapaqTimeline__dot" aria-hidden="true" />
      <div className="qapaqTimeline__body">
        <div className="qapaqTimeline__meta">
          <Timestamp iso={item.at} />
          <SourceBadge id={item.vendor} basePath={basePath} />
          <EuiBadge color={levelColor(item.level)}>
            {levelLabel(item.level)} · {item.level}
          </EuiBadge>
          <span className="qapaqMuted">
            regla <Mono>{item.ruleId}</Mono>
          </span>
          {item.mitre.ids.slice(0, 3).map((id) => (
            <span key={id} className="qapaqMitre">
              {id}
            </span>
          ))}
        </div>
        <button
          type="button"
          className="qapaqTimeline__title"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {item.description || 'Sin descripción'}
        </button>
        {item.matched.length > 0 && (
          <div className="qapaqTimeline__matched">
            {item.matched.map((key) => (
              <span key={key} className="qapaqChip qapaqChip--static">
                {key.slice(key.indexOf(':') + 1)}
              </span>
            ))}
          </div>
        )}
        {open && <EventJson basePath={basePath} id={item.id} />}
      </div>
    </li>
  );
}

function EventJson({ basePath, id }: { basePath: string; id: string }) {
  const loaded = useAsync(() => fetchEvent(basePath, id), [basePath, id]);
  if (loaded.loading) return <EuiLoadingContent lines={3} />;
  if (loaded.error) return <ErrorCallout error={loaded.error} onRetry={loaded.reload} />;
  const event = loaded.data?.event;
  if (!event) return <EmptyLine>El documento ya no está disponible en el Indexer.</EmptyLine>;
  return (
    <EuiCodeBlock language="json" fontSize="s" paddingSize="s" isCopyable overflowHeight={360}>
      {JSON.stringify(event.raw, null, 2)}
    </EuiCodeBlock>
  );
}

function SourceEvent({
  basePath,
  access,
  match,
  event,
  loading,
  error,
  onRetry,
}: {
  basePath: string;
  access: IndexerAccess;
  match: 'exact' | 'matched' | 'none';
  event: InvestigationEvent | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <EuiPanel paddingSize="m" className="qapaqCard">
      <EuiTitle size="xs">
        <h2>Evento de origen en el SIEM</h2>
      </EuiTitle>
      <EuiSpacer size="s" />
      {loading ? (
        <EuiLoadingContent lines={3} />
      ) : error ? (
        <ErrorCallout error={error} onRetry={onRetry} />
      ) : access !== 'ok' ? (
        <EuiCallOut size="s" color="warning" iconType="lock" title={ACCESS_MESSAGE[access]} />
      ) : !event ? (
        <EmptyLine>
          No se encontró el documento de Wazuh de esta alerta (regla y hora ±5 min). Puede haber
          rotado fuera de la retención del Indexer.
        </EmptyLine>
      ) : (
        <>
          <dl className="qapaqKeyValues" data-qapaq-no-translate="">
            <dt>Origen</dt>
            <dd>
              <SourceBadge id={event.vendor} basePath={basePath} />
            </dd>
            <dt>Regla</dt>
            <dd>
              <Mono>{event.ruleId}</Mono> · nivel {event.level}
            </dd>
            <dt>Descripción</dt>
            <dd>{event.description}</dd>
            {event.agent && (
              <>
                <dt>Agente</dt>
                <dd>{event.agent}</dd>
              </>
            )}
            {event.location && (
              <>
                <dt>Ubicación</dt>
                <dd>
                  <Mono>{event.location}</Mono>
                </dd>
              </>
            )}
            <dt>Grupos</dt>
            <dd>{event.groups.join(', ') || '—'}</dd>
            <dt>Documento</dt>
            <dd>
              <Mono>{event.id}</Mono>{' '}
              {match === 'matched' && (
                <EuiToolTip content="La API de alertas no guarda el id del documento: se localizó por regla, descripción y hora.">
                  <span className="qapaqMuted">(coincidencia por regla y hora)</span>
                </EuiToolTip>
              )}
            </dd>
          </dl>
          <EuiSpacer size="s" />
          <EuiAccordion
            id="qapaq-source-json"
            buttonContent="Ver el evento completo (JSON)"
            paddingSize="s"
          >
            {event.rawTruncated && (
              <EuiCallOut size="s" color="warning" title="Documento recortado (más de 64 KB)." />
            )}
            <EuiCodeBlock
              language="json"
              fontSize="s"
              paddingSize="s"
              isCopyable
              overflowHeight={480}
            >
              {JSON.stringify(event.raw, null, 2)}
            </EuiCodeBlock>
          </EuiAccordion>
        </>
      )}
    </EuiPanel>
  );
}

function EntitiesPanel({
  basePath,
  entities,
  at,
  from,
  to,
}: {
  basePath: string;
  entities: InvestigationEntity[];
  at: string;
  from: string;
  to: string;
}) {
  return (
    <EuiPanel paddingSize="m" className="qapaqCard">
      <EuiTitle size="xs">
        <h2>Entidades</h2>
      </EuiTitle>
      <EuiSpacer size="s" />
      {entities.length === 0 ? (
        <EmptyLine>Sin entidades extraídas del evento.</EmptyLine>
      ) : (
        <ul className="qapaqEntities" data-qapaq-no-translate="">
          {entities.map((item) => (
            <EntityRow
              key={entityKey(item)}
              basePath={basePath}
              entity={item}
              at={at}
              from={from}
              to={to}
            />
          ))}
        </ul>
      )}
    </EuiPanel>
  );
}

function EntityRow({
  basePath,
  entity,
  at,
  from,
  to,
}: {
  basePath: string;
  entity: InvestigationEntity;
  at: string;
  from: string;
  to: string;
}) {
  const { api } = useConsole();
  const [risk, setRisk] = useState<EntityRisk | null>(null);
  useEffect(() => {
    let alive = true;
    fetchEntityRisk(api.apiPrefix, entity.kind, entity.value).then((value) => {
      if (alive) setRisk(value);
    });
    return () => {
      alive = false;
    };
  }, [api, entity.kind, entity.value]);
  const kql = entityKql([entity]);
  return (
    <li className="qapaqEntity">
      <div className="qapaqEntity__head">
        <span className="qapaqEntity__kind">{ENTITY_KIND_LABEL[entity.kind]}</span>
        {risk && <RiskChip risk={risk} />}
      </div>
      <a
        className="qapaqEntity__value"
        href={entityInvestigationHref(basePath, entity.kind, entity.value, at)}
        title="Investigar esta entidad"
      >
        {entity.value}
      </a>
      {entity.field && <span className="qapaqEntity__field">{entity.field}</span>}
      <div className="qapaqEntity__links">
        <a href={threatHuntingUrl(basePath, kql, from, to)}>Threat Hunting</a>
        <a href={discoverUrlForQuery(basePath, kql, from, to)}>Discover</a>
        <a href={`${basePath}/app/qapaq-alerts?${new URLSearchParams({ q: entity.value })}`}>
          Alertas QAPAQ
        </a>
      </div>
    </li>
  );
}

/** Chip «Riesgo» del motor de correlación; solo aparece si la API de riesgo responde. */
function RiskChip({ risk }: { risk: EntityRisk }) {
  const tone = risk.score >= 70 ? 'high' : risk.score >= 40 ? 'medium' : 'low';
  return (
    <EuiToolTip
      content={`Riesgo acumulado por el motor de correlación QAPAQ${
        risk.lastSeen ? ` · última señal ${new Date(risk.lastSeen).toLocaleString('es-PE')}` : ''
      }`}
    >
      <span className={`qapaqRisk qapaqRisk--${tone}`} tabIndex={0}>
        Riesgo <strong className="qapaqTabular">{Math.round(risk.score)}</strong>
      </span>
    </EuiToolTip>
  );
}

function MitrePanel({
  basePath,
  mitre,
}: {
  basePath: string;
  mitre: { ids: readonly string[]; tactics: readonly string[]; techniques: readonly string[] };
}) {
  return (
    <EuiPanel paddingSize="m" className="qapaqCard">
      <EuiTitle size="xs">
        <h2>MITRE ATT&amp;CK</h2>
      </EuiTitle>
      <EuiSpacer size="s" />
      <div className="qapaqChips" data-qapaq-no-translate="">
        {mitre.ids.map((id, index) => {
          const url = mitreTechniqueUrl(id);
          const name = mitre.techniques[index];
          return url ? (
            <a
              key={id}
              className="qapaqMitre qapaqMitre--link"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              title={name ? `${id} · ${name} (attack.mitre.org)` : id}
            >
              {id}
              {name ? ` · ${name}` : ''}
            </a>
          ) : (
            <span key={id} className="qapaqMitre">
              {id}
            </span>
          );
        })}
      </div>
      {mitre.tactics.length > 0 && (
        <EuiText size="xs" color="subdued">
          <p>Táctica: {mitre.tactics.join(', ')}</p>
        </EuiText>
      )}
      <EuiSpacer size="s" />
      <EuiButtonEmpty size="xs" flush="left" href={`${basePath}/app/mitre-attack`}>
        Ver la matriz MITRE del SIEM
      </EuiButtonEmpty>
    </EuiPanel>
  );
}

function IncidentPanel({
  alert,
  basePath,
  onChanged,
}: {
  alert: Alert;
  basePath: string;
  onChanged: () => void;
}) {
  const { api, can, notifications } = useConsole();
  const [opening, setOpening] = useState(false);
  const incident = useAsync(
    () =>
      alert.incidentId
        ? api
            .get<{ incident: Incident }>(`/incidents/${encodeURIComponent(alert.incidentId)}`)
            .then((r) => r.incident)
        : Promise.resolve(null),
    [api, alert.incidentId],
  );
  return (
    <EuiPanel paddingSize="m" className="qapaqCard">
      <EuiTitle size="xs">
        <h2>Incidente y notas</h2>
      </EuiTitle>
      <EuiSpacer size="s" />
      {!alert.incidentId ? (
        opening ? (
          <OpenIncidentForm
            alert={alert}
            onCancel={() => setOpening(false)}
            onOpened={(incidentId) => {
              notifications.toasts.addSuccess({
                title: 'Incidente abierto',
                text: `La alerta quedó vinculada a ${incidentId}.`,
              });
              setOpening(false);
              onChanged();
            }}
          />
        ) : (
          <>
            <EmptyLine>
              La alerta no está vinculada a un incidente. Las notas del analista viven en el
              incidente.
            </EmptyLine>
            {can(CAPABILITIES.incidentsWrite) && alert.status !== 'closed' && (
              <EuiButton size="s" onClick={() => setOpening(true)}>
                Abrir incidente
              </EuiButton>
            )}
          </>
        )
      ) : incident.loading ? (
        <EuiLoadingContent lines={3} />
      ) : incident.error ? (
        <ErrorCallout error={incident.error} onRetry={incident.reload} />
      ) : incident.data ? (
        <>
          <p>
            <a href={`${basePath}/app/qapaq-incidents?id=${encodeURIComponent(incident.data.id)}`}>
              {incident.data.title}
            </a>
          </p>
          <EuiSpacer size="s" />
          <NotesPanel incident={incident.data} />
        </>
      ) : null}
    </EuiPanel>
  );
}
