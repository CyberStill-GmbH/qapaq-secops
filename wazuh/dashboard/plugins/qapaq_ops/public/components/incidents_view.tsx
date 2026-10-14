/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import {
  EuiBadge,
  EuiBasicTable,
  EuiBasicTableColumn,
  EuiButton,
  EuiButtonEmpty,
  EuiCheckbox,
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
  EuiSpacer,
  EuiTab,
  EuiTabs,
  EuiText,
  EuiTextArea,
  EuiTitle,
} from '@elastic/eui';
import {
  CAPABILITIES,
  Incident,
  INCIDENT_STATUS_LABEL,
  IncidentCommandName,
  IncidentNote,
  IncidentStatus,
  IncidentTask,
  LinkedAlerts,
  Page,
  ALERT_STATUS_LABEL,
  VERDICT_LABEL,
  TASK_STATUS_LABEL,
  TaskCommandName,
  Timeline,
} from '../../common';
import { QapaqApiError } from '../api/client';
import { QapaqPage, useChanges, useConsole } from './console_context';
import {
  EmptyLine,
  ErrorCallout,
  Mono,
  PriorityMark,
  SeverityMark,
  Timestamp,
  useAsync,
  useIsMobile,
} from './primitives';

type IncidentFilter = 'active' | IncidentStatus;

const FILTERS: ReadonlyArray<{ id: IncidentFilter; label: string }> = [
  { id: 'active', label: 'Activos' },
  { id: 'open', label: INCIDENT_STATUS_LABEL.open },
  { id: 'contained', label: INCIDENT_STATUS_LABEL.contained },
  { id: 'eradicated', label: INCIDENT_STATUS_LABEL.eradicated },
  { id: 'resolved', label: INCIDENT_STATUS_LABEL.resolved },
  { id: 'closed', label: INCIDENT_STATUS_LABEL.closed },
];

/** Transiciones del ciclo de vida (modules/soc/src/incident.ts del backend). */
const NEXT_STEP: Partial<Record<IncidentStatus, { name: IncidentCommandName; label: string }>> = {
  open: { name: 'contain', label: 'Marcar contenido' },
  contained: { name: 'eradicate', label: 'Marcar erradicado' },
  eradicated: { name: 'resolve', label: 'Resolver' },
};

const CLOSURE_MIN = 10;

export function IncidentsView({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { api } = useConsole();
  const [filter, setFilter] = useState<IncidentFilter>('active');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<readonly Incident[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);

  const page = useAsync(
    () =>
      api.get<Page<Incident>>('/incidents', {
        status: filter,
        q: query || undefined,
        pageSize: 50,
      }),
    [api, filter, query],
  );

  useEffect(() => {
    if (page.data) {
      setItems(page.data.items);
      setCursor(page.data.nextCursor);
    }
  }, [page.data]);

  useChanges(['incident'], () => page.reload());

  const loadMore = async () => {
    if (!cursor) return;
    const next = await api.get<Page<Incident>>('/incidents', {
      status: filter,
      q: query || undefined,
      pageSize: 50,
      cursor,
    });
    setItems((current) => [...current, ...next.items]);
    setCursor(next.nextCursor);
  };

  const columns: Array<EuiBasicTableColumn<Incident>> = [
    {
      field: 'severity',
      name: 'Severidad',
      width: '112px',
      render: (value: Incident['severity']) => <SeverityMark severity={value} />,
      mobileOptions: { header: false },
    },
    {
      field: 'title',
      name: 'Incidente',
      truncateText: false,
      render: (value: string, incident: Incident) => (
        <span className="qapaqCellTitle">
          <span>{value}</span>
          <span className="qapaqCellMeta">
            {incident.alertIds.length} {incident.alertIds.length === 1 ? 'alerta' : 'alertas'}
          </span>
        </span>
      ),
      mobileOptions: { header: false },
    },
    {
      field: 'status',
      name: 'Estado',
      width: '120px',
      render: (value: IncidentStatus) => (
        <EuiBadge color="hollow">{INCIDENT_STATUS_LABEL[value]}</EuiBadge>
      ),
    },
    {
      field: 'ownerId',
      name: 'Responsable',
      width: '160px',
      render: (value: string | null) =>
        value ? (
          <Mono>{value.slice(0, 12)}</Mono>
        ) : (
          <span className="qapaqMuted">Sin responsable</span>
        ),
    },
    {
      field: 'openedAt',
      name: 'Abierto',
      width: '120px',
      render: (value: string) => <Timestamp iso={value} />,
    },
  ];

  return (
    <QapaqPage
      title="Incidentes"
      description="Casos con responsable, tareas obligatorias, notas y línea de tiempo auditada."
    >
      <EuiTabs size="s" className="qapaqTabs">
        {FILTERS.map((tab) => (
          <EuiTab key={tab.id} isSelected={filter === tab.id} onClick={() => setFilter(tab.id)}>
            {tab.label}
            {filter === tab.id && page.data?.totalCount !== undefined && (
              <span className="qapaqTabCount">{page.data.totalCount}</span>
            )}
          </EuiTab>
        ))}
      </EuiTabs>
      <EuiSpacer size="m" />
      <EuiFieldSearch
        fullWidth
        compressed
        placeholder="Buscar por título"
        value={search}
        onChange={(event) => setSearch(event.target.value.slice(0, 120))}
        onSearch={(value) => setQuery(value.trim().slice(0, 120))}
        aria-label="Buscar incidentes"
      />
      <EuiSpacer size="m" />
      {page.error ? (
        <ErrorCallout error={page.error} onRetry={page.reload} />
      ) : (
        <>
          <EuiBasicTable<Incident>
            items={items as Incident[]}
            columns={columns}
            loading={page.loading}
            responsive
            tableLayout="auto"
            rowProps={(incident) => ({
              onClick: () => onSelect(incident.id),
              className: `qapaqRow qapaqRow--${incident.severity}${
                incident.id === selectedId ? ' euiTableRow-isSelected' : ''
              }`,
            })}
            noItemsMessage={
              page.loading
                ? 'Cargando incidentes…'
                : query
                  ? 'Ningún incidente coincide con la búsqueda.'
                  : 'No hay incidentes en este estado. Se abren desde una alerta triada.'
            }
          />
          {cursor && (
            <>
              <EuiSpacer size="s" />
              <EuiButtonEmpty size="s" onClick={loadMore}>
                Cargar más
              </EuiButtonEmpty>
            </>
          )}
        </>
      )}
      {selectedId && (
        <IncidentFlyout
          incidentId={selectedId}
          onClose={() => onSelect(null)}
          onChanged={(updated) =>
            setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)))
          }
        />
      )}
    </QapaqPage>
  );
}

type DetailTab = 'summary' | 'alerts' | 'tasks' | 'notes' | 'timeline';

function IncidentFlyout({
  incidentId,
  onClose,
  onChanged,
}: {
  incidentId: string;
  onClose: () => void;
  onChanged: (incident: Incident) => void;
}) {
  const { api, can, basePath, session } = useConsole();
  const mobile = useIsMobile();
  const base = `/incidents/${encodeURIComponent(incidentId)}`;
  const loaded = useAsync(() => api.get<{ incident: Incident }>(base), [api, base]);
  const [incident, setIncident] = useState<Incident | null>(null);
  const [tab, setTab] = useState<DetailTab>('summary');
  const [closing, setClosing] = useState(false);
  const [closureReason, setClosureReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (loaded.data) setIncident(loaded.data.incident);
  }, [loaded.data]);

  useChanges(['incident'], (changes, resync) => {
    if (!closing && (resync || changes.some((c) => c.resource.id === incidentId))) loaded.reload();
  });

  const command = async (name: IncidentCommandName, extra: Record<string, unknown> = {}) => {
    if (!incident) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ incident: Incident }>(`${base}/commands`, {
        name,
        expectedRevision: incident.revision,
        ...extra,
      });
      setIncident(result.incident);
      onChanged(result.incident);
      setClosing(false);
      setClosureReason('');
    } catch (failure) {
      setError(failure);
      if (failure instanceof QapaqApiError && failure.code === 'STATE_CONFLICT') loaded.reload();
    } finally {
      setBusy(false);
    }
  };

  const canWrite = can(CAPABILITIES.incidentsWrite);
  const next = incident ? NEXT_STEP[incident.status] : undefined;

  return (
    <EuiFlyout
      onClose={onClose}
      size={mobile ? 'l' : 'm'}
      ownFocus={mobile}
      className="qapaqFlyout"
      aria-labelledby="qapaqIncidentTitle"
    >
      <EuiFlyoutHeader hasBorder>
        {incident && <SeverityMark severity={incident.severity} />}
        <EuiSpacer size="xs" />
        <EuiTitle size="s">
          <h2 id="qapaqIncidentTitle" data-qapaq-no-translate="">
            {incident?.title ?? 'Incidente'}
          </h2>
        </EuiTitle>
        {incident && (
          <EuiText size="xs" color="subdued">
            <p>
              {INCIDENT_STATUS_LABEL[incident.status]} · abierto{' '}
              <Timestamp iso={incident.openedAt} />
            </p>
          </EuiText>
        )}
        <EuiSpacer size="s" />
        <EuiTabs size="s" className="qapaqTabs qapaqTabs--flush">
          <EuiTab isSelected={tab === 'summary'} onClick={() => setTab('summary')}>
            Resumen
          </EuiTab>
          <EuiTab isSelected={tab === 'alerts'} onClick={() => setTab('alerts')}>
            Alertas
          </EuiTab>
          <EuiTab isSelected={tab === 'tasks'} onClick={() => setTab('tasks')}>
            Tareas
          </EuiTab>
          <EuiTab isSelected={tab === 'notes'} onClick={() => setTab('notes')}>
            Notas
          </EuiTab>
          <EuiTab isSelected={tab === 'timeline'} onClick={() => setTab('timeline')}>
            Línea de tiempo
          </EuiTab>
        </EuiTabs>
      </EuiFlyoutHeader>
      <EuiFlyoutBody>
        {loaded.error != null && <ErrorCallout error={loaded.error} onRetry={loaded.reload} />}
        {error != null && (
          <>
            <ErrorCallout error={error} />
            <EuiSpacer size="m" />
          </>
        )}
        {incident && tab === 'summary' && (
          <>
            <EuiDescriptionList
              type="responsiveColumn"
              compressed
              className="qapaqFacts"
              listItems={[
                { title: 'Identificador', description: <Mono>{incident.id}</Mono> },
                {
                  title: 'Responsable',
                  description: incident.ownerId ? (
                    <Mono>{incident.ownerId}</Mono>
                  ) : (
                    <span className="qapaqMuted">Sin responsable</span>
                  ),
                },
                {
                  title: 'Alertas vinculadas',
                  description:
                    incident.alertIds.length === 0 ? (
                      'Ninguna'
                    ) : (
                      <span className="qapaqIdList">
                        {incident.alertIds.map((id) => (
                          <a
                            key={id}
                            href={`${basePath}/app/qapaq-alerts?id=${encodeURIComponent(id)}`}
                          >
                            <Mono>{id}</Mono>
                          </a>
                        ))}
                      </span>
                    ),
                },
                {
                  title: 'Cerrado',
                  description: incident.closedAt ? (
                    <Timestamp iso={incident.closedAt} />
                  ) : (
                    'Abierto'
                  ),
                },
              ]}
            />
            <EuiSpacer size="l" />
            <EuiTitle size="xxs">
              <h3>Resumen</h3>
            </EuiTitle>
            <EuiSpacer size="s" />
            <EuiText size="s" className="qapaqProse" data-qapaq-no-translate="">
              <p>{incident.summary || 'Sin resumen.'}</p>
            </EuiText>
            {closing && (
              <>
                <EuiSpacer size="l" />
                <EuiFormRow
                  label="Motivo de cierre"
                  helpText={`Mínimo ${CLOSURE_MIN} caracteres. No se puede cerrar con alertas sin triar ni tareas obligatorias abiertas.`}
                  fullWidth
                >
                  <EuiTextArea
                    fullWidth
                    rows={4}
                    value={closureReason}
                    onChange={(event) => setClosureReason(event.target.value)}
                  />
                </EuiFormRow>
              </>
            )}
          </>
        )}
        {incident && tab === 'alerts' && <LinkedAlertsPanel incident={incident} />}
        {incident && tab === 'tasks' && <TasksPanel incident={incident} />}
        {incident && tab === 'notes' && <NotesPanel incident={incident} />}
        {incident && tab === 'timeline' && <TimelinePanel incident={incident} />}
      </EuiFlyoutBody>
      {incident && canWrite && tab === 'summary' && (
        <EuiFlyoutFooter>
          <EuiFlexGroup gutterSize="s" responsive={false} wrap justifyContent="flexEnd">
            {closing ? (
              <>
                <EuiFlexItem grow={false}>
                  <EuiButtonEmpty onClick={() => setClosing(false)} disabled={busy}>
                    Cancelar
                  </EuiButtonEmpty>
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <EuiButton
                    fill
                    isLoading={busy}
                    isDisabled={closureReason.trim().length < CLOSURE_MIN}
                    onClick={() => command('close', { closureReason: closureReason.trim() })}
                  >
                    Cerrar incidente
                  </EuiButton>
                </EuiFlexItem>
              </>
            ) : (
              <>
                {next && (
                  <EuiFlexItem grow={false}>
                    <EuiButton fill isLoading={busy} onClick={() => command(next.name)}>
                      {next.label}
                    </EuiButton>
                  </EuiFlexItem>
                )}
                {incident.status !== 'closed' && incident.ownerId !== session.subjectId && (
                  <EuiFlexItem grow={false}>
                    <EuiButton
                      isLoading={busy}
                      onClick={() => command('reassign', { ownerId: session.subjectId })}
                    >
                      Asumir responsabilidad
                    </EuiButton>
                  </EuiFlexItem>
                )}
                {incident.status === 'contained' && (
                  <EuiFlexItem grow={false}>
                    <EuiButton isLoading={busy} onClick={() => command('resolve')}>
                      Resolver
                    </EuiButton>
                  </EuiFlexItem>
                )}
                {incident.status === 'resolved' && can(CAPABILITIES.incidentsClose) && (
                  <EuiFlexItem grow={false}>
                    <EuiButton fill onClick={() => setClosing(true)}>
                      Cerrar incidente
                    </EuiButton>
                  </EuiFlexItem>
                )}
                {(incident.status === 'resolved' || incident.status === 'closed') && (
                  <EuiFlexItem grow={false}>
                    <EuiButton isLoading={busy} onClick={() => command('reopen')}>
                      Reabrir
                    </EuiButton>
                  </EuiFlexItem>
                )}
              </>
            )}
          </EuiFlexGroup>
        </EuiFlyoutFooter>
      )}
    </EuiFlyout>
  );
}

/** Alertas vinculadas (`GET /api/incidents/:id/alerts`): un incidente no se cierra con alertas sin triar. */
function LinkedAlertsPanel({ incident }: { incident: Incident }) {
  const { api, basePath } = useConsole();
  const base = `/incidents/${encodeURIComponent(incident.id)}/alerts`;
  const linked = useAsync(() => api.get<LinkedAlerts>(base, { pageSize: 200 }), [api, base]);
  useChanges(['alert', 'incident'], () => linked.reload());

  if (linked.loading && !linked.data) return <EmptyLine>Cargando alertas vinculadas…</EmptyLine>;
  if (linked.error != null) return <ErrorCallout error={linked.error} onRetry={linked.reload} />;
  const data = linked.data!;
  const untriaged = data.items.filter(
    (alert) => alert.status === 'new' || alert.status === 'acknowledged',
  );

  return (
    <>
      <EuiText size="xs" color="subdued">
        <p>
          {data.totalCount} vinculadas
          {untriaged.length > 0 ? ` · ${untriaged.length} sin triar` : ''}
          {data.unavailableCount > 0
            ? ` · ${data.unavailableCount} no disponibles para tu cuenta`
            : ''}
          {data.truncated ? ' · se muestran las más recientes' : ''}
        </p>
      </EuiText>
      <EuiSpacer size="s" />
      {data.items.length === 0 ? (
        <EmptyLine>Este incidente no tiene alertas legibles vinculadas.</EmptyLine>
      ) : (
        <ul className="qapaqTaskList">
          {data.items.map((alert) => (
            <li key={alert.id} className="qapaqTask">
              <div className="qapaqTask__main">
                <span className="qapaqTask__title">
                  <PriorityMark priority={alert.priority} />{' '}
                  <a
                    href={`${basePath}/app/qapaq-alerts?id=${encodeURIComponent(alert.id)}`}
                    data-qapaq-no-translate=""
                  >
                    {alert.title}
                  </a>
                </span>
                <span className="qapaqCellMeta">
                  {ALERT_STATUS_LABEL[alert.status]}
                  {alert.verdict ? ` · ${VERDICT_LABEL[alert.verdict]}` : ''} ·{' '}
                  <Timestamp iso={alert.occurredAt} />
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function TasksPanel({ incident }: { incident: Incident }) {
  const { api, can } = useConsole();
  const base = `/incidents/${encodeURIComponent(incident.id)}/tasks`;
  const tasks = useAsync(
    () => api.get<Page<IncidentTask> & { openRequiredCount: number }>(base, { pageSize: 200 }),
    [api, base],
  );
  const [title, setTitle] = useState('');
  const [required, setRequired] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const canWrite = can(CAPABILITIES.tasksWrite) && incident.status !== 'closed';
  useChanges(['incident_task'], () => tasks.reload());

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      tasks.reload();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(null);
    }
  };

  const command = (
    task: IncidentTask,
    name: TaskCommandName,
    extra: Record<string, unknown> = {},
  ) =>
    run(task.id, () =>
      api.post(`${base}/${encodeURIComponent(task.id)}/commands`, {
        name,
        expectedRevision: task.revision,
        ...extra,
      }),
    );

  if (tasks.loading && !tasks.data) return <EmptyLine>Cargando tareas…</EmptyLine>;
  if (tasks.error) return <ErrorCallout error={tasks.error} onRetry={tasks.reload} />;
  const items = tasks.data?.items ?? [];

  return (
    <>
      {error != null && <ErrorCallout error={error} />}
      <EuiText size="xs" color="subdued">
        <p>
          {tasks.data?.openRequiredCount ?? 0} obligatorias abiertas · {items.length} en total
        </p>
      </EuiText>
      <EuiSpacer size="s" />
      {items.length === 0 ? (
        <EmptyLine>
          Sin tareas. Añade los pasos de contención y erradicación que deben cumplirse.
        </EmptyLine>
      ) : (
        <ul className="qapaqTaskList">
          {items.map((task) => (
            <li key={task.id} className="qapaqTask" data-status={task.status}>
              <div className="qapaqTask__main">
                <span className="qapaqTask__title" data-qapaq-no-translate="">
                  {task.title}
                </span>
                <span className="qapaqCellMeta">
                  {TASK_STATUS_LABEL[task.status]}
                  {task.required ? ' · obligatoria' : ''}
                  {task.cancellationReason ? ` · ${task.cancellationReason}` : ''}
                </span>
              </div>
              {canWrite && (
                <div className="qapaqTask__actions">
                  {task.status === 'open' && (
                    <EuiButtonEmpty
                      size="xs"
                      isLoading={busy === task.id}
                      onClick={() => command(task, 'start')}
                    >
                      Empezar
                    </EuiButtonEmpty>
                  )}
                  {(task.status === 'open' || task.status === 'in_progress') && (
                    <>
                      <EuiButtonEmpty
                        size="xs"
                        isLoading={busy === task.id}
                        onClick={() => command(task, 'complete')}
                      >
                        Completar
                      </EuiButtonEmpty>
                      {!task.required && (
                        <EuiButtonEmpty
                          size="xs"
                          color="danger"
                          onClick={() => command(task, 'cancel')}
                        >
                          Cancelar
                        </EuiButtonEmpty>
                      )}
                    </>
                  )}
                  {(task.status === 'done' || task.status === 'cancelled') && (
                    <EuiButtonEmpty size="xs" onClick={() => command(task, 'reopen')}>
                      Reabrir
                    </EuiButtonEmpty>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <>
          <EuiSpacer size="l" />
          <EuiFormRow label="Nueva tarea" fullWidth>
            <EuiFieldText
              fullWidth
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Ej.: Revocar sesiones del usuario afectado"
            />
          </EuiFormRow>
          <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
            <EuiFlexItem grow>
              <EuiCheckbox
                id={`qapaqTaskRequired-${incident.id}`}
                label="Obligatoria para cerrar el incidente"
                checked={required}
                onChange={(event) => setRequired(event.target.checked)}
              />
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButton
                size="s"
                isDisabled={title.trim().length === 0}
                isLoading={busy === 'new'}
                onClick={() =>
                  run('new', async () => {
                    await api.post(base, { title: title.trim(), required });
                    setTitle('');
                  })
                }
              >
                Añadir tarea
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        </>
      )}
    </>
  );
}

function NotesPanel({ incident }: { incident: Incident }) {
  const { api, can } = useConsole();
  const base = `/incidents/${encodeURIComponent(incident.id)}/notes`;
  const notes = useAsync(() => api.get<Page<IncidentNote>>(base, { pageSize: 200 }), [api, base]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useChanges(['incident_note'], () => notes.reload());

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(base, { body: body.trim() });
      setBody('');
      notes.reload();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  if (notes.loading && !notes.data) return <EmptyLine>Cargando notas…</EmptyLine>;
  if (notes.error) return <ErrorCallout error={notes.error} onRetry={notes.reload} />;
  const items = notes.data?.items ?? [];

  return (
    <>
      {error != null && <ErrorCallout error={error} />}
      {items.length === 0 ? (
        <EmptyLine>Sin notas. Las notas no se editan: una corrección es una nota nueva.</EmptyLine>
      ) : (
        <ol className="qapaqNotes">
          {items.map((note) => (
            <li key={note.id} className="qapaqNote">
              <div className="qapaqCellMeta">
                <Mono>{note.authorId.slice(0, 12)}</Mono> · <Timestamp iso={note.createdAt} />
                {note.correctsNoteId ? ' · corrige una nota anterior' : ''}
              </div>
              <EuiText size="s" className="qapaqProse" data-qapaq-no-translate="">
                <p>{note.body}</p>
              </EuiText>
            </li>
          ))}
        </ol>
      )}
      {can(CAPABILITIES.notesWrite) && (
        <>
          <EuiSpacer size="l" />
          <EuiFormRow label="Nueva nota" fullWidth>
            <EuiTextArea
              fullWidth
              rows={3}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </EuiFormRow>
          <EuiFlexGroup justifyContent="flexEnd" responsive={false}>
            <EuiFlexItem grow={false}>
              <EuiButton
                size="s"
                isLoading={busy}
                isDisabled={body.trim().length === 0}
                onClick={add}
              >
                Añadir nota
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        </>
      )}
    </>
  );
}

const TIMELINE_LABEL: Record<string, string> = {
  'incident.opened': 'Incidente abierto',
  'incident.transition': 'Cambio de estado',
  'incident.closed': 'Incidente cerrado',
  'alert.linked': 'Alerta vinculada',
  'task.created': 'Tarea creada',
  'task.completed': 'Tarea completada',
  'task.cancelled': 'Tarea cancelada',
  'note.added': 'Nota añadida',
};

function TimelinePanel({ incident }: { incident: Incident }) {
  const { api } = useConsole();
  const base = `/incidents/${encodeURIComponent(incident.id)}/timeline`;
  const timeline = useAsync(() => api.get<Timeline>(base, { pageSize: 200 }), [api, base]);
  useChanges(['incident', 'incident_task', 'incident_note', 'alert'], () => timeline.reload());

  if (timeline.loading && !timeline.data) return <EmptyLine>Cargando línea de tiempo…</EmptyLine>;
  if (timeline.error) return <ErrorCallout error={timeline.error} onRetry={timeline.reload} />;
  const data = timeline.data!;

  return (
    <>
      {data.transitions !== 'included' && (
        <EuiText size="xs" color="subdued">
          <p>
            {data.transitions === 'requires_audit_read'
              ? 'Los cambios de estado no se muestran: requieren permiso de lectura de auditoría.'
              : 'Algunos cambios de estado no pudieron recuperarse de la auditoría.'}
          </p>
        </EuiText>
      )}
      {data.items.length === 0 ? (
        <EmptyLine>Sin eventos registrados.</EmptyLine>
      ) : (
        <ol className="qapaqTimeline">
          {data.items.map((entry) => (
            <li key={entry.id} className="qapaqTimeline__item">
              <span className="qapaqTimeline__time">
                <Timestamp iso={entry.at} />
              </span>
              <span className="qapaqTimeline__body">
                <strong>{TIMELINE_LABEL[entry.kind] ?? entry.kind}</strong>
                <span data-qapaq-no-translate="">{entry.summary}</span>
                {entry.actorId && (
                  <span className="qapaqCellMeta">
                    <Mono>{entry.actorId.slice(0, 12)}</Mono>
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
