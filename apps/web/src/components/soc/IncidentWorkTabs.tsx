import { useCallback, useEffect, useState } from 'react';
import type { ApiErrorBody } from '@qapaq/contracts';
import {
  api,
  type IncidentNoteView,
  type IncidentTaskView,
  type IncidentTimelineEntry,
  type IncidentTimelinePage,
  type IncidentView,
  type SessionView,
} from '../../api/client.js';
import { Button, EmptyState, ErrorState, RelativeTime } from './soc-ui.js';
import { useChanges } from './use-changes.js';

export type IncidentWorkTab = 'tasks' | 'notes' | 'timeline';

function shortId(value: string | null | undefined, selfId: string): string {
  if (!value) return 'Sin asignar';
  return value === selfId ? 'Tú' : `${value.slice(0, 8)}…`;
}

const taskStatusLabel: Readonly<Record<IncidentTaskView['status'], string>> = {
  open: 'Abierta',
  in_progress: 'En curso',
  done: 'Completada',
  cancelled: 'Cancelada',
};

function TaskCard({
  task,
  canWrite,
  onCommand,
  busy,
}: {
  readonly task: IncidentTaskView;
  readonly canWrite: boolean;
  readonly onCommand: (
    task: IncidentTaskView,
    name: string,
    extra?: Record<string, unknown>,
  ) => void;
  readonly busy: boolean;
}): React.JSX.Element {
  const [assigneeId, setAssigneeId] = useState(task.assigneeId ?? '');
  const [reason, setReason] = useState('');
  const [showAssign, setShowAssign] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const canMove = canWrite && (task.status === 'open' || task.status === 'in_progress');
  return (
    <article className="soc-work-item" data-task-id={task.id}>
      <div className="soc-work-item__main">
        <div className="soc-work-item__title">
          <h3>{task.title}</h3>
          {task.required ? <span className="soc-work-required">Obligatoria</span> : null}
          <span className={`soc-work-status soc-work-status--${task.status}`}>
            {taskStatusLabel[task.status]}
          </span>
        </div>
        {task.description ? <p>{task.description}</p> : null}
        <dl>
          <div>
            <dt>Responsable</dt>
            <dd>
              <code>{task.assigneeId ? `${task.assigneeId.slice(0, 8)}…` : 'Sin asignar'}</code>
            </dd>
          </div>
          <div>
            <dt>Vencimiento</dt>
            <dd>{task.dueAt ? new Date(task.dueAt).toLocaleString('es-PE') : 'Sin vencimiento'}</dd>
          </div>
          <div>
            <dt>Actualizada</dt>
            <dd>
              <RelativeTime value={task.updatedAt} />
            </dd>
          </div>
        </dl>
        {task.cancellationReason ? (
          <p className="soc-work-cancel-reason">Motivo de cancelación: {task.cancellationReason}</p>
        ) : null}
      </div>
      {canWrite ? (
        <div className="soc-work-actions">
          {task.status === 'open' ? (
            <Button variant="ghost" disabled={busy} onClick={() => onCommand(task, 'start')}>
              Iniciar
            </Button>
          ) : null}
          {canMove ? (
            <Button variant="ghost" disabled={busy} onClick={() => onCommand(task, 'complete')}>
              Completar
            </Button>
          ) : null}
          {task.status === 'done' || task.status === 'cancelled' ? (
            <Button variant="ghost" disabled={busy} onClick={() => onCommand(task, 'reopen')}>
              Reabrir
            </Button>
          ) : null}
          {canMove ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setShowAssign((value) => !value)}
            >
              Asignar
            </Button>
          ) : null}
          {canMove ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setShowCancel((value) => !value)}
            >
              Cancelar tarea
            </Button>
          ) : null}
          {showAssign ? (
            <form
              className="soc-work-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                onCommand(task, 'assign', { assigneeId: assigneeId.trim() });
                setShowAssign(false);
              }}
            >
              <label>
                Identificador de responsable
                <input
                  value={assigneeId}
                  onChange={(event) => setAssigneeId(event.target.value)}
                  maxLength={200}
                  required
                />
              </label>
              <Button type="submit" disabled={busy || !assigneeId.trim()}>
                Guardar asignación
              </Button>
            </form>
          ) : null}
          {showCancel ? (
            <form
              className="soc-work-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                onCommand(task, 'cancel', { reason: reason.trim() });
                setShowCancel(false);
              }}
            >
              <label>
                Motivo{task.required ? ' · obligatorio' : ''}
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  minLength={task.required ? 10 : 0}
                  maxLength={500}
                  required={task.required}
                />
              </label>
              <Button
                type="submit"
                variant="danger"
                disabled={busy || (task.required && reason.trim().length < 10)}
              >
                Confirmar cancelación
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function TasksTab({
  incident,
  session,
}: {
  readonly incident: IncidentView;
  readonly session: SessionView;
}): React.JSX.Element {
  const [items, setItems] = useState<readonly IncidentTaskView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [openRequiredCount, setOpenRequiredCount] = useState(0);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [required, setRequired] = useState(false);
  const canWrite = session.capabilities.includes('incidents.tasks.write');
  const load = useCallback(
    async (cursor?: string, append = false) => {
      setLoading(true);
      const result = await api.incidentTasks(incident.id, cursor);
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setItems((current) => (append ? [...current, ...result.data.items] : result.data.items));
      setNextCursor(result.data.nextCursor);
      setOpenRequiredCount(result.data.openRequiredCount);
      setError(null);
    },
    [incident.id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const liveChanges = useChanges({
    resourceTypes: ['incident_task'],
    onChange: () => {
      void load();
    },
  });

  async function createTask(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    const result = await api.createIncidentTask(incident.id, {
      title: title.trim(),
      required,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(assigneeId.trim() ? { assigneeId: assigneeId.trim() } : {}),
      ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setTitle('');
    setDescription('');
    setAssigneeId('');
    setDueAt('');
    setRequired(false);
    await load();
  }
  async function command(
    task: IncidentTaskView,
    name: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    setBusy(true);
    const result = await api.incidentTaskCommand(incident.id, task.id, {
      name,
      expectedRevision: task.revision,
      ...extra,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      if (result.error.code === 'STATE_CONFLICT') await load();
      return;
    }
    await load();
  }

  return (
    <section className="soc-investigation-tab" aria-label="Tareas del incidente">
      {openRequiredCount > 0 ? (
        <p className="soc-closure-blocked" role="status">
          Cierre bloqueado · {openRequiredCount}{' '}
          {openRequiredCount === 1 ? 'tarea obligatoria abierta' : 'tareas obligatorias abiertas'}
        </p>
      ) : null}
      <header className="soc-investigation-heading">
        <div>
          <h3>Tareas</h3>
          <p>Trabajo acordado para completar la investigación.</p>
        </div>
      </header>
      {liveChanges.length ? (
        <p className="soc-live-announcement" role="status" aria-live="polite">
          Dato nuevo entrando
        </p>
      ) : null}
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      {canWrite && incident.status !== 'closed' ? (
        <form className="soc-task-create" onSubmit={(event) => void createTask(event)}>
          <label>
            Título
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              minLength={3}
              maxLength={200}
              required
            />
          </label>
          <label>
            Descripción
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={4000}
            />
          </label>
          <div className="soc-task-create__details">
            <label>
              Responsable · opcional
              <input
                value={assigneeId}
                onChange={(event) => setAssigneeId(event.target.value)}
                maxLength={200}
              />
            </label>
            <label>
              Vencimiento · opcional
              <input
                type="datetime-local"
                value={dueAt}
                onChange={(event) => setDueAt(event.target.value)}
              />
            </label>
            <label className="soc-task-required">
              <input
                type="checkbox"
                checked={required}
                onChange={(event) => setRequired(event.target.checked)}
              />{' '}
              Obligatoria para el cierre
            </label>
          </div>
          <Button type="submit" variant="primary" disabled={busy || title.trim().length < 3}>
            Crear tarea
          </Button>
        </form>
      ) : null}
      {items.length ? (
        <div className="soc-work-list">
          {items.map((task) => (
            <div
              key={task.id}
              className={
                liveChanges.some((change) => change.resource.id === task.id)
                  ? 'soc-live-change'
                  : ''
              }
            >
              <TaskCard
                task={task}
                canWrite={canWrite && incident.status !== 'closed'}
                onCommand={(item, name, extra) => void command(item, name, extra)}
                busy={busy}
              />
            </div>
          ))}
        </div>
      ) : !loading && !error ? (
        <EmptyState>Aún no hay tareas para este incidente.</EmptyState>
      ) : null}
      {nextCursor ? (
        <Button variant="ghost" disabled={loading} onClick={() => void load(nextCursor, true)}>
          Cargar más tareas
        </Button>
      ) : null}
    </section>
  );
}

function NotesTab({
  incident,
  session,
}: {
  readonly incident: IncidentView;
  readonly session: SessionView;
}): React.JSX.Element {
  const [items, setItems] = useState<readonly IncidentNoteView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [loading, setLoading] = useState(false);
  const [body, setBody] = useState('');
  const [correctsNoteId, setCorrectsNoteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canWrite = session.capabilities.includes('incidents.notes.write');
  const load = useCallback(
    async (cursor?: string, append = false) => {
      setLoading(true);
      const result = await api.incidentNotes(incident.id, cursor);
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setItems((current) => (append ? [...current, ...result.data.items] : result.data.items));
      setNextCursor(result.data.nextCursor);
      setError(null);
    },
    [incident.id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const liveChanges = useChanges({
    resourceTypes: ['incident_note'],
    onChange: () => {
      void load();
    },
  });
  async function addNote(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    const result = await api.addIncidentNote(incident.id, {
      body: body.trim(),
      ...(correctsNoteId ? { correctsNoteId } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setBody('');
    setCorrectsNoteId(null);
    await load();
  }
  return (
    <section className="soc-investigation-tab" aria-label="Bitácora del incidente">
      <header className="soc-investigation-heading">
        <div>
          <h3>Bitácora</h3>
          <p>Entradas inmutables; corregir añade una nota que referencia a la anterior.</p>
        </div>
      </header>
      {liveChanges.length ? (
        <p className="soc-live-announcement" role="status" aria-live="polite">
          Dato nuevo entrando
        </p>
      ) : null}
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      {canWrite && incident.status !== 'closed' ? (
        <form className="soc-note-form" onSubmit={(event) => void addNote(event)}>
          {correctsNoteId ? (
            <p role="status">
              Corrige nota {correctsNoteId.slice(0, 8)}…{' '}
              <Button type="button" variant="ghost" onClick={() => setCorrectsNoteId(null)}>
                Cancelar corrección
              </Button>
            </p>
          ) : null}
          <label htmlFor="incident-note-body">Nueva nota</label>
          <textarea
            id="incident-note-body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={10000}
            required
          />
          <div>
            <small>La nota no se puede editar ni borrar después de guardarla.</small>
            <Button type="submit" variant="primary" disabled={busy || !body.trim()}>
              Guardar nota
            </Button>
          </div>
        </form>
      ) : null}
      {items.length ? (
        <ol className="soc-note-list">
          {items.map((note) => (
            <li
              key={note.id}
              className={
                liveChanges.some((change) => change.resource.id === note.id)
                  ? 'soc-live-change'
                  : ''
              }
            >
              <header>
                <strong>{shortId(note.authorId, session.subjectId)}</strong>
                <RelativeTime value={note.createdAt} />
              </header>
              {note.correctsNoteId ? (
                <p className="soc-page-note">Corrige nota {note.correctsNoteId.slice(0, 8)}…</p>
              ) : null}
              <p className="soc-note-body">{note.body}</p>
              {canWrite && incident.status !== 'closed' ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setCorrectsNoteId(note.id);
                    document.getElementById('incident-note-body')?.scrollIntoView({
                      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
                        ? 'auto'
                        : 'smooth',
                      block: 'center',
                    });
                  }}
                >
                  Corregir
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      ) : !loading && !error ? (
        <EmptyState>La bitácora está vacía.</EmptyState>
      ) : null}
      {nextCursor ? (
        <Button variant="ghost" disabled={loading} onClick={() => void load(nextCursor, true)}>
          Cargar notas anteriores
        </Button>
      ) : null}
    </section>
  );
}

const timelineLabels: Readonly<Record<IncidentTimelineEntry['kind'], string>> = {
  'incident.opened': 'Incidente abierto',
  'incident.transition': 'Transición',
  'incident.closed': 'Incidente cerrado',
  'alert.linked': 'Alerta vinculada',
  'task.created': 'Tarea creada',
  'task.completed': 'Tarea completada',
  'task.cancelled': 'Tarea cancelada',
  'note.added': 'Nota añadida',
};

function TimelineTab({ incident }: { readonly incident: IncidentView }): React.JSX.Element {
  const [data, setData] = useState<IncidentTimelinePage | null>(null);
  const [items, setItems] = useState<readonly IncidentTimelineEntry[]>([]);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const load = useCallback(
    async (next?: string, append = false) => {
      setLoading(true);
      const result = await api.incidentTimeline(incident.id, next);
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setData(result.data);
      setItems((current) => (append ? [...current, ...result.data.items] : result.data.items));
      setCursor(result.data.nextCursor);
      setError(null);
    },
    [incident.id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const liveChanges = useChanges({
    resourceTypes: ['incident', 'incident_task', 'incident_note', 'alert'],
    onChange: () => {
      void load();
    },
  });
  const transitionNotice =
    data?.transitions === 'requires_audit_read'
      ? 'Transiciones visibles solo con permiso de auditoría'
      : data?.transitions === 'partial'
        ? 'Historial parcial'
        : null;
  return (
    <section className="soc-investigation-tab" aria-label="Timeline del incidente">
      <header className="soc-investigation-heading">
        <div>
          <h3>Timeline</h3>
          <p>Actividad del caso ordenada por hora de ocurrencia.</p>
        </div>
      </header>
      {liveChanges.length ? (
        <p className="soc-live-announcement" role="status" aria-live="polite">
          Dato nuevo entrando
        </p>
      ) : null}
      {transitionNotice ? (
        <p className="soc-partial-banner" role="status">
          {transitionNotice}
        </p>
      ) : null}
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      {items.length ? (
        <ol className="soc-timeline">
          {items.map((entry) => (
            <li
              key={entry.id}
              className={
                liveChanges.some((change) => change.resource.id === entry.ref.id)
                  ? 'soc-live-change'
                  : ''
              }
            >
              <span className="soc-timeline__marker" aria-hidden="true" />
              <div className="soc-timeline__content">
                <header>
                  <strong>{timelineLabels[entry.kind]}</strong>
                  <RelativeTime value={entry.at} />
                </header>
                <p>{entry.summary || timelineLabels[entry.kind]}</p>
                <div className="soc-timeline__meta">
                  <span>
                    {entry.timeSource === 'provider' ? 'Hora de la fuente' : 'Hora registrada'}
                  </span>
                  {entry.timeSource === 'provider' ? (
                    <span>
                      Registrado en QAPAQ <RelativeTime value={entry.recordedAt} />
                    </span>
                  ) : null}
                  {entry.actorId ? <span>Autor {entry.actorId.slice(0, 8)}…</span> : null}
                </div>
                {entry.kind === 'incident.transition' && entry.ref.type === 'audit_event' ? (
                  <small>Transición auditada</small>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : !loading && !error ? (
        <EmptyState>Sin actividad registrada para este incidente.</EmptyState>
      ) : null}
      {cursor ? (
        <Button variant="ghost" disabled={loading} onClick={() => void load(cursor, true)}>
          Cargar actividad anterior
        </Button>
      ) : null}
    </section>
  );
}

export function IncidentWorkTabs({
  tab,
  incident,
  session,
}: {
  readonly tab: IncidentWorkTab;
  readonly incident: IncidentView;
  readonly session: SessionView;
}): React.JSX.Element {
  if (tab === 'tasks') return <TasksTab incident={incident} session={session} />;
  if (tab === 'notes') return <NotesTab incident={incident} session={session} />;
  return <TimelineTab incident={incident} />;
}
