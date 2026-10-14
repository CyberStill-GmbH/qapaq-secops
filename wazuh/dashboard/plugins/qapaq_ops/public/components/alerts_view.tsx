/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  EuiBadge,
  EuiBasicTable,
  EuiBasicTableColumn,
  EuiButton,
  EuiButtonEmpty,
  EuiDescriptionList,
  EuiFieldSearch,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutFooter,
  EuiFlyoutHeader,
  EuiFormRow,
  EuiSelect,
  EuiSpacer,
  EuiTab,
  EuiTabs,
  EuiText,
  EuiTextArea,
  EuiTitle,
} from '@elastic/eui';
import {
  Alert,
  ALERT_STATUS_LABEL,
  ALERT_VERDICTS,
  AlertCommandName,
  AlertStatus,
  AlertVerdict,
  CAPABILITIES,
  discoverUrlForEntity,
  INCIDENT_SEVERITIES,
  IncidentSeverity,
  Page,
  PRIORITIES,
  Priority,
  SEVERITY_LABEL,
  VERDICT_LABEL,
} from '../../common';
import { QapaqApiError } from '../api/client';
import { QapaqPage, useChanges, useConsole } from './console_context';
import {
  DataZone,
  EmptyLine,
  ErrorCallout,
  Mono,
  PriorityMark,
  Timestamp,
  useAsync,
  useIsMobile,
} from './primitives';

type StatusFilter = 'open' | AlertStatus;

const STATUS_TABS: ReadonlyArray<{ id: StatusFilter; label: string }> = [
  { id: 'open', label: 'Abiertas' },
  { id: 'new', label: ALERT_STATUS_LABEL.new },
  { id: 'acknowledged', label: ALERT_STATUS_LABEL.acknowledged },
  { id: 'triaged', label: ALERT_STATUS_LABEL.triaged },
  { id: 'escalated', label: ALERT_STATUS_LABEL.escalated },
  { id: 'closed', label: ALERT_STATUS_LABEL.closed },
];

const ENTITY_KIND_LABEL: Record<string, string> = {
  user: 'Usuario',
  ip: 'IP',
  host: 'Equipo',
};

const NOTE_MIN = 10;
const NOTE_MAX = 2000;

function isPriority(value: string | null): value is Priority {
  return value !== null && (PRIORITIES as readonly string[]).includes(value);
}

export function AlertsView({
  selectedId,
  onSelect,
  basePath,
  initialPriority = null,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  basePath: string;
  initialPriority?: string | null;
}) {
  const { api } = useConsole();
  const [status, setStatus] = useState<StatusFilter>('open');
  const [priority, setPriority] = useState<Priority | ''>(
    isPriority(initialPriority) ? initialPriority : '',
  );
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<readonly Alert[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [extraPages, setExtraPages] = useState(0);

  const page = useAsync(
    () =>
      api.get<Page<Alert>>('/alerts', {
        status,
        priority: priority || undefined,
        q: query || undefined,
        pageSize: 50,
      }),
    [api, status, priority, query],
  );

  useEffect(() => {
    if (page.data) {
      setItems(page.data.items);
      setCursor(page.data.nextCursor);
      setExtraPages(0);
    }
  }, [page.data]);

  // En vivo: una alerta nueva o cambiada recarga la primera página de la cola.
  useChanges(['alert'], () => page.reload());

  const loadMore = async () => {
    if (!cursor) return;
    const next = await api.get<Page<Alert>>('/alerts', {
      status,
      priority: priority || undefined,
      q: query || undefined,
      pageSize: 50,
      cursor,
    });
    setItems((current) => [...current, ...next.items]);
    setCursor(next.nextCursor);
    setExtraPages((value) => value + 1);
  };

  const columns: Array<EuiBasicTableColumn<Alert>> = [
    {
      field: 'priority',
      name: 'Prioridad',
      width: '104px',
      render: (value: Priority) => <PriorityMark priority={value} />,
      mobileOptions: { header: false },
    },
    {
      field: 'title',
      name: 'Alerta',
      truncateText: false,
      render: (value: string, alert: Alert) => (
        <span className="qapaqCellTitle">
          <span>{value}</span>
          {alert.entities.length > 0 && (
            <span className="qapaqCellMeta">
              {alert.entities
                .slice(0, 2)
                .map((entity) => entity.label)
                .join(' · ')}
            </span>
          )}
        </span>
      ),
      mobileOptions: { header: false },
    },
    {
      field: 'status',
      name: 'Estado',
      width: '120px',
      render: (value: AlertStatus) => (
        <EuiBadge color="hollow">{ALERT_STATUS_LABEL[value]}</EuiBadge>
      ),
    },
    {
      field: 'assigneeId',
      name: 'Asignada a',
      width: '160px',
      render: (value: string | null) =>
        value ? <Mono>{value.slice(0, 12)}</Mono> : <span className="qapaqMuted">Sin asignar</span>,
    },
    {
      field: 'occurredAt',
      name: 'Ocurrió',
      width: '120px',
      render: (value: string) => <Timestamp iso={value} />,
    },
  ];

  return (
    <QapaqPage
      title="Cola de alertas"
      description="Cola priorizada por QAPAQ (P1–P4) a partir de las detecciones del SIEM y de Microsoft 365."
    >
      <EuiTabs size="s" className="qapaqTabs">
        {STATUS_TABS.map((tab) => (
          <EuiTab key={tab.id} isSelected={status === tab.id} onClick={() => setStatus(tab.id)}>
            {tab.label}
            {status === tab.id && page.data?.totalCount !== undefined && (
              <span className="qapaqTabCount">{page.data.totalCount}</span>
            )}
          </EuiTab>
        ))}
      </EuiTabs>
      <EuiSpacer size="m" />
      <EuiFlexGroup gutterSize="s" responsive wrap className="qapaqFilters">
        <EuiFlexItem grow={3}>
          <EuiFieldSearch
            fullWidth
            compressed
            placeholder="Buscar por título o entidad"
            value={search}
            onChange={(event) => setSearch(event.target.value.slice(0, 120))}
            onSearch={(value) => setQuery(value.trim().slice(0, 120))}
            aria-label="Buscar alertas"
          />
        </EuiFlexItem>
        <EuiFlexItem grow={1}>
          <EuiSelect
            compressed
            fullWidth
            aria-label="Filtrar por prioridad"
            value={priority}
            onChange={(event) => setPriority(event.target.value as Priority | '')}
            options={[
              { value: '', text: 'Todas las prioridades' },
              ...PRIORITIES.map((value) => ({ value, text: value })),
            ]}
          />
        </EuiFlexItem>
      </EuiFlexGroup>
      <EuiSpacer size="m" />
      {page.error ? (
        <ErrorCallout error={page.error} onRetry={page.reload} />
      ) : (
        <DataZone>
          <EuiBasicTable<Alert>
            items={items as Alert[]}
            columns={columns}
            loading={page.loading}
            responsive
            tableLayout="auto"
            rowProps={(alert) => ({
              onClick: () => onSelect(alert.id),
              className: `qapaqRow qapaqRow--p${alert.priority.slice(1)}${
                alert.id === selectedId ? ' euiTableRow-isSelected' : ''
              }`,
              'data-test-subj': `qapaqAlertRow-${alert.id}`,
            })}
            noItemsMessage={
              page.loading
                ? 'Cargando alertas…'
                : query || priority
                  ? 'Ninguna alerta coincide con los filtros. Quita un filtro para ampliar la búsqueda.'
                  : 'No hay alertas en este estado.'
            }
          />
          {cursor && (
            <>
              <EuiSpacer size="s" />
              <EuiButtonEmpty size="s" onClick={loadMore}>
                Cargar más{extraPages > 0 ? ` (${items.length} mostradas)` : ''}
              </EuiButtonEmpty>
            </>
          )}
        </DataZone>
      )}
      {selectedId && (
        <AlertFlyout
          alertId={selectedId}
          basePath={basePath}
          onClose={() => onSelect(null)}
          onChanged={(updated) =>
            setItems((current) =>
              current.map((alert) => (alert.id === updated.id ? updated : alert)),
            )
          }
        />
      )}
    </QapaqPage>
  );
}

function AlertFlyout({
  alertId,
  basePath,
  onClose,
  onChanged,
}: {
  alertId: string;
  basePath: string;
  onClose: () => void;
  onChanged: (alert: Alert) => void;
}) {
  const { api, session, can, notifications } = useConsole();
  const mobile = useIsMobile();
  const loaded = useAsync(
    () => api.get<{ alert: Alert }>(`/alerts/${encodeURIComponent(alertId)}`),
    [api, alertId],
  );
  const [alert, setAlert] = useState<Alert | null>(null);
  const [mode, setMode] = useState<'idle' | 'triage' | 'close' | 'incident'>('idle');
  const [verdict, setVerdict] = useState<AlertVerdict>('true_positive');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (loaded.data) setAlert(loaded.data.alert);
  }, [loaded.data]);

  // Si otra persona cambia esta alerta mientras está abierta, se recarga (no al editar).
  useChanges(['alert'], (changes, resync) => {
    if (mode === 'idle' && (resync || changes.some((c) => c.resource.id === alertId)))
      loaded.reload();
  });

  const command = async (name: AlertCommandName, extra: Record<string, unknown> = {}) => {
    if (!alert) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ alert: Alert }>(
        `/alerts/${encodeURIComponent(alert.id)}/commands`,
        { name, expectedRevision: alert.revision, ...extra },
      );
      setAlert(result.alert);
      onChanged(result.alert);
      setMode('idle');
      setNote('');
    } catch (failure) {
      setError(failure);
      if (failure instanceof QapaqApiError && failure.code === 'STATE_CONFLICT') loaded.reload();
    } finally {
      setBusy(false);
    }
  };

  const isAssignee = alert?.assigneeId === session.subjectId;
  const canTriage = can(CAPABILITIES.alertsTriage);
  const noteValid = note.trim().length >= NOTE_MIN && note.length <= NOTE_MAX;

  return (
    <EuiFlyout
      onClose={onClose}
      size={mobile ? 'l' : 'm'}
      ownFocus={mobile}
      className="qapaqFlyout"
      aria-labelledby="qapaqAlertTitle"
    >
      <EuiFlyoutHeader hasBorder>
        {alert && <PriorityMark priority={alert.priority} />}
        <EuiSpacer size="xs" />
        <EuiTitle size="s">
          <h2 id="qapaqAlertTitle" data-qapaq-no-translate="">
            {alert?.title ?? 'Alerta'}
          </h2>
        </EuiTitle>
        {alert && (
          <EuiText size="xs" color="subdued">
            <p>
              {ALERT_STATUS_LABEL[alert.status]} · <Timestamp iso={alert.occurredAt} /> · puntuación{' '}
              <span className="qapaqTabular">{alert.score}</span>
            </p>
          </EuiText>
        )}
      </EuiFlyoutHeader>
      <EuiFlyoutBody>
        {loaded.error != null && <ErrorCallout error={loaded.error} onRetry={loaded.reload} />}
        {error != null && (
          <>
            <ErrorCallout error={error} />
            <EuiSpacer size="m" />
          </>
        )}
        {alert && (
          <>
            <EuiDescriptionList
              type="responsiveColumn"
              compressed
              className="qapaqFacts"
              listItems={[
                { title: 'Identificador', description: <Mono>{alert.id}</Mono> },
                {
                  title: 'Asignada a',
                  description: alert.assigneeId ? (
                    <Mono>{alert.assigneeId}</Mono>
                  ) : (
                    <span className="qapaqMuted">Sin asignar</span>
                  ),
                },
                {
                  title: 'Veredicto',
                  description: alert.verdict ? VERDICT_LABEL[alert.verdict] : 'Sin veredicto',
                },
                {
                  title: 'Incidente',
                  description: alert.incidentId ? (
                    <a
                      href={`${basePath}/app/qapaq-incidents?id=${encodeURIComponent(alert.incidentId)}`}
                    >
                      <Mono>{alert.incidentId}</Mono>
                    </a>
                  ) : (
                    'No vinculada'
                  ),
                },
              ]}
            />
            <EuiSpacer size="l" />
            <EuiTitle size="xxs">
              <h3>Por qué tiene esta prioridad</h3>
            </EuiTitle>
            <EuiSpacer size="s" />
            {alert.reasons.length === 0 ? (
              <EmptyLine>El motor de priorización no registró motivos.</EmptyLine>
            ) : (
              <ul className="qapaqList" data-qapaq-no-translate="">
                {alert.reasons.map((reason) => (
                  <li key={reason.code}>
                    <Mono>{reason.code}</Mono> <span>{reason.detail}</span>
                  </li>
                ))}
              </ul>
            )}
            <EuiSpacer size="l" />
            <EuiTitle size="xxs">
              <h3>Entidades correlacionadas</h3>
            </EuiTitle>
            <EuiSpacer size="s" />
            {alert.entities.length === 0 ? (
              <EmptyLine>Sin entidades extraídas del evento.</EmptyLine>
            ) : (
              <ul className="qapaqList">
                {alert.entities.map((entity, index) => {
                  const discover = discoverUrlForEntity(basePath, entity, alert.occurredAt);
                  return (
                    <li key={entity.ref ?? `${entity.kind}-${index}`}>
                      <span className="qapaqMuted">
                        {ENTITY_KIND_LABEL[entity.kind] ?? entity.kind}
                      </span>{' '}
                      <Mono>{entity.label}</Mono>
                      {discover && (
                        <>
                          {' '}
                          <a className="qapaqInlineLink" href={discover}>
                            Ver eventos en Discover (±1 h)
                          </a>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {mode === 'triage' && (
              <>
                <EuiSpacer size="l" />
                <EuiFormRow label="Veredicto" fullWidth>
                  <EuiSelect
                    fullWidth
                    value={verdict}
                    onChange={(event) => setVerdict(event.target.value as AlertVerdict)}
                    options={ALERT_VERDICTS.map((value) => ({ value, text: VERDICT_LABEL[value] }))}
                  />
                </EuiFormRow>
                <NoteField note={note} onChange={setNote} required />
              </>
            )}
            {mode === 'close' && (
              <>
                <EuiSpacer size="l" />
                <NoteField note={note} onChange={setNote} required={alert.status !== 'triaged'} />
              </>
            )}
            {mode === 'incident' && (
              <OpenIncidentForm
                alert={alert}
                onCancel={() => setMode('idle')}
                onOpened={(incidentId) => {
                  notifications.toasts.addSuccess({
                    title: 'Incidente abierto',
                    text: `La alerta quedó vinculada a ${incidentId}.`,
                  });
                  setMode('idle');
                  loaded.reload();
                }}
              />
            )}
          </>
        )}
      </EuiFlyoutBody>
      {alert && canTriage && mode !== 'incident' && (
        <EuiFlyoutFooter>
          <EuiFlexGroup gutterSize="s" responsive={false} wrap justifyContent="flexEnd">
            {mode !== 'idle' ? (
              <>
                <EuiFlexItem grow={false}>
                  <EuiButtonEmpty onClick={() => setMode('idle')} disabled={busy}>
                    Cancelar
                  </EuiButtonEmpty>
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <EuiButton
                    fill
                    isLoading={busy}
                    isDisabled={
                      mode === 'triage' || alert.status !== 'triaged' ? !noteValid : false
                    }
                    onClick={() =>
                      mode === 'triage'
                        ? command('triage', { verdict, note: note.trim() })
                        : command('close', note.trim() ? { note: note.trim() } : {})
                    }
                  >
                    {mode === 'triage' ? 'Registrar triaje' : 'Cerrar alerta'}
                  </EuiButton>
                </EuiFlexItem>
              </>
            ) : (
              <>
                {alert.status === 'new' && (
                  <EuiFlexItem grow={false}>
                    <EuiButton fill isLoading={busy} onClick={() => command('acknowledge')}>
                      Reconocer
                    </EuiButton>
                  </EuiFlexItem>
                )}
                {can(CAPABILITIES.alertsAssign) &&
                  !isAssignee &&
                  (alert.status === 'acknowledged' || alert.status === 'triaged') && (
                    <EuiFlexItem grow={false}>
                      <EuiButton
                        isLoading={busy}
                        onClick={() => command('assign', { assigneeId: session.subjectId })}
                      >
                        Asignarme
                      </EuiButton>
                    </EuiFlexItem>
                  )}
                {alert.status === 'acknowledged' && isAssignee && (
                  <EuiFlexItem grow={false}>
                    <EuiButton fill onClick={() => setMode('triage')}>
                      Triar
                    </EuiButton>
                  </EuiFlexItem>
                )}
                {alert.status === 'triaged' && alert.verdict === 'true_positive' && (
                  <EuiFlexItem grow={false}>
                    <EuiButton fill isLoading={busy} onClick={() => command('escalate')}>
                      Escalar
                    </EuiButton>
                  </EuiFlexItem>
                )}
                {can(CAPABILITIES.incidentsWrite) &&
                  !alert.incidentId &&
                  alert.status !== 'closed' && (
                    <EuiFlexItem grow={false}>
                      <EuiButton onClick={() => setMode('incident')}>Abrir incidente</EuiButton>
                    </EuiFlexItem>
                  )}
                {['acknowledged', 'triaged', 'escalated'].includes(alert.status) && (
                  <EuiFlexItem grow={false}>
                    <EuiButton onClick={() => setMode('close')}>Cerrar alerta</EuiButton>
                  </EuiFlexItem>
                )}
                {alert.status === 'closed' && (
                  <EuiFlexItem grow={false}>
                    <EuiButton isLoading={busy} onClick={() => command('reopen')}>
                      Reabrir
                    </EuiButton>
                  </EuiFlexItem>
                )}
              </>
            )}
          </EuiFlexGroup>
          {alert.status === 'acknowledged' && !isAssignee && mode === 'idle' && (
            <EuiText size="xs" color="subdued" className="qapaqFooterHint">
              <p>Solo la persona asignada puede registrar el triaje.</p>
            </EuiText>
          )}
        </EuiFlyoutFooter>
      )}
    </EuiFlyout>
  );
}

function NoteField({
  note,
  onChange,
  required,
}: {
  note: string;
  onChange: (value: string) => void;
  required: boolean;
}) {
  const length = note.trim().length;
  const invalid = required && note.length > 0 && length < NOTE_MIN;
  return (
    <EuiFormRow
      label={required ? 'Nota' : 'Nota (opcional)'}
      helpText={`${length} de ${NOTE_MAX} caracteres${required ? ` · mínimo ${NOTE_MIN}` : ''}`}
      isInvalid={invalid}
      error={invalid ? `Escribe al menos ${NOTE_MIN} caracteres.` : undefined}
      fullWidth
    >
      <EuiTextArea
        fullWidth
        rows={4}
        value={note}
        maxLength={NOTE_MAX}
        isInvalid={invalid}
        onChange={(event) => onChange(event.target.value)}
      />
    </EuiFormRow>
  );
}

function OpenIncidentForm({
  alert,
  onCancel,
  onOpened,
}: {
  alert: Alert;
  onCancel: () => void;
  onOpened: (incidentId: string) => void;
}) {
  const { api } = useConsole();
  const defaultSeverity = useMemo<IncidentSeverity>(
    () => (({ P1: 'critical', P2: 'high', P3: 'medium', P4: 'low' }) as const)[alert.priority],
    [alert.priority],
  );
  const [title, setTitle] = useState(alert.title);
  const [severity, setSeverity] = useState<IncidentSeverity>(defaultSeverity);
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ incident: { id: string } }>('/incidents', {
        alertId: alert.id,
        title: title.trim(),
        severity,
        summary: summary.trim(),
        expectedAlertRevision: alert.revision,
      });
      onOpened(result.incident.id);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <EuiSpacer size="l" />
      <EuiTitle size="xxs">
        <h3>Abrir incidente desde esta alerta</h3>
      </EuiTitle>
      <EuiSpacer size="s" />
      {error != null && <ErrorCallout error={error} />}
      <EuiFormRow label="Título" fullWidth>
        <EuiFieldText
          fullWidth
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
        />
      </EuiFormRow>
      <EuiFormRow label="Severidad" fullWidth>
        <EuiSelect
          fullWidth
          value={severity}
          onChange={(event) => setSeverity(event.target.value as IncidentSeverity)}
          options={INCIDENT_SEVERITIES.map((value) => ({ value, text: SEVERITY_LABEL[value] }))}
        />
      </EuiFormRow>
      <EuiFormRow label="Resumen" fullWidth helpText="Qué se sabe y qué falta confirmar.">
        <EuiTextArea
          fullWidth
          rows={4}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
      </EuiFormRow>
      <EuiSpacer size="m" />
      <EuiFlexGroup gutterSize="s" justifyContent="flexEnd" responsive={false} wrap>
        <EuiFlexItem grow={false}>
          <EuiButtonEmpty onClick={onCancel} disabled={busy}>
            Cancelar
          </EuiButtonEmpty>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButton
            fill
            isLoading={busy}
            isDisabled={title.trim().length === 0 || summary.trim().length === 0}
            onClick={submit}
          >
            Abrir incidente
          </EuiButton>
        </EuiFlexItem>
      </EuiFlexGroup>
    </>
  );
}
