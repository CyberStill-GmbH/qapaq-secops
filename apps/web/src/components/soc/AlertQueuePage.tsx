import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiErrorBody } from '@qapaq/contracts';
import { api, type AlertStatus, type AlertView, type SessionView } from '../../api/client.js';
import {
  Button,
  EmptyState,
  ErrorState,
  RelativeTime,
  Severity,
  SocIcon,
  StatusChip,
} from './soc-ui.js';
import { AlertDetailDrawer } from './AlertDetailDrawer.js';

const statuses: readonly { readonly value: 'open' | AlertStatus; readonly label: string }[] = [
  { value: 'open', label: 'Abiertas' },
  { value: 'new', label: 'Nuevas' },
  { value: 'acknowledged', label: 'Reconocidas' },
  { value: 'triaged', label: 'Triadas' },
  { value: 'escalated', label: 'Escaladas' },
  { value: 'closed', label: 'Cerradas' },
];
const alertStatus: Readonly<Record<string, string>> = {
  new: 'Nueva',
  acknowledged: 'Reconocida',
  triaged: 'Triada',
  escalated: 'Escalada',
  closed: 'Cerrada',
};
const stateTone = (value: string): 'ok' | 'warn' | 'fail' | 'info' | 'neutral' =>
  value === 'triaged'
    ? 'ok'
    : value === 'escalated'
      ? 'warn'
      : value === 'acknowledged'
        ? 'info'
        : 'neutral';
function isAlertTab(value: string | null): value is 'open' | AlertStatus {
  return statuses.some((item) => item.value === value);
}
function incidentSeverity(priority: string): 'critical' | 'high' | 'medium' | 'low' {
  switch (priority) {
    case 'P1':
      return 'critical';
    case 'P2':
      return 'high';
    case 'P3':
      return 'medium';
    default:
      return 'low';
  }
}

function Header({
  updated,
  onRefresh,
}: {
  readonly updated: string | null;
  readonly onRefresh: () => void;
}): React.JSX.Element {
  return (
    <div className="soc-page-heading">
      <div>
        <h1>Alertas</h1>
        <p>Cola de análisis priorizada por severidad y estado.</p>
      </div>
      <div className="soc-page-heading__meta">
        {updated ? (
          <span>
            Actualizado <RelativeTime value={updated} />
          </span>
        ) : null}
        <Button onClick={onRefresh}>
          <SocIcon name="refresh" /> Actualizar
        </Button>
      </div>
    </div>
  );
}

export function AlertQueuePage({
  session,
  path,
  onNavigate,
}: {
  readonly session: SessionView;
  readonly path: string;
  readonly onNavigate: (path: string) => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<'open' | AlertStatus>(() => {
    const value = new URLSearchParams(path.split('?')[1] ?? '').get('status');
    return isAlertTab(value) ? value : 'open';
  });
  const [items, setItems] = useState<readonly AlertView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<AlertView | null>(null);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [updated, setUpdated] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (nextStatus: 'open' | AlertStatus = status, nextCursor?: string) => {
      setLoading(true);
      const result = await api.alertsByStatus(
        nextStatus === 'open' ? undefined : nextStatus,
        nextCursor,
      );
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const rows =
        nextStatus === 'open'
          ? result.data.items.filter((alert) => alert.status !== 'closed')
          : result.data.items;
      setItems((current) => (nextCursor ? [...current, ...rows] : rows));
      setCursor(result.data.nextCursor);
      setError(null);
      setUpdated(new Date().toISOString());
    },
    [status],
  );

  useEffect(() => {
    void load(status);
  }, [status]);
  useEffect(() => {
    const value = new URLSearchParams(path.split('?')[1] ?? '').get('status');
    if (isAlertTab(value)) setStatus(value);
  }, [path]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !selected) void load(status);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [load, selected, status]);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      )
        return;
      if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === 'Escape' && selected) {
        setSelected(null);
        onNavigate(`/alerts?status=${status}`);
        return;
      }
      if (event.key === 'j' || event.key === 'k') {
        const rows = [...document.querySelectorAll<HTMLTableRowElement>('.soc-alert-row')];
        if (rows.length === 0) return;
        const activeRow =
          document.activeElement instanceof HTMLElement
            ? document.activeElement.closest<HTMLTableRowElement>('tr')
            : null;
        const current = activeRow ? rows.indexOf(activeRow) : -1;
        const next =
          event.key === 'j'
            ? Math.min(rows.length - 1, current + 1)
            : Math.max(0, current < 0 ? 0 : current - 1);
        rows[next]?.focus();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onNavigate, selected, status]);
  useEffect(() => {
    const id = decodeURIComponent(path.split('/alerts/')[1]?.split('?')[0] ?? '');
    if (!id) return;
    const existing = items.find((alert) => alert.id === id);
    if (existing) {
      setSelected(existing);
      return;
    }
    void api.alert(id).then((result) => {
      if (result.ok) setSelected(result.data.alert);
      else setError(result.error);
    });
  }, [path, items]);

  async function execute(name: string, extra: Record<string, unknown> = {}): Promise<void> {
    if (!selected) return;
    setBusy(true);
    const result = await api.command(selected.id, {
      name,
      ...extra,
      expectedRevision: selected.revision,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      if (result.error.code === 'STATE_CONFLICT') await load();
      return;
    }
    setSelected(result.data.alert);
    setItems((current) =>
      current.map((alert) => (alert.id === result.data.alert.id ? result.data.alert : alert)),
    );
    setError(null);
  }

  async function openIncident(title: string, summary: string): Promise<void> {
    if (!selected) return;
    setBusy(true);
    const result = await api.createIncident({
      alertId: selected.id,
      title,
      severity: incidentSeverity(selected.priority),
      summary,
      expectedAlertRevision: selected.revision,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await load();
    onNavigate(`/incidents/${encodeURIComponent(result.data.incident.id)}`);
  }

  const visible = items.filter(
    (item) =>
      !query ||
      `${item.title} ${item.id} ${item.assigneeId ?? ''}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );

  return (
    <div className="soc-page">
      <Header updated={updated} onRefresh={() => void load()} />
      <div className="soc-tabs" role="tablist" aria-label="Estado de las alertas">
        {statuses.map((entry) => (
          <button
            key={entry.value}
            type="button"
            role="tab"
            aria-selected={status === entry.value}
            className={status === entry.value ? 'is-active' : ''}
            onClick={() => {
              setStatus(entry.value);
              setSelected(null);
              onNavigate(`/alerts?status=${entry.value}`);
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="soc-filter-bar">
        <label className="soc-search-field">
          <SocIcon name="search" />
          <span className="visually-hidden">Filtrar título o responsable</span>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filtrar título o responsable"
          />
          <kbd>/</kbd>
        </label>
        <span className="soc-page-note">
          La búsqueda se aplica a la página cargada · j / k para recorrer.
        </span>
      </div>
      {error && !selected ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      <div className={`soc-table-panel${selected ? ' soc-table-panel--with-drawer' : ''}`}>
        <div className="soc-table-scroll">
          <table className="soc-table">
            <thead>
              <tr>
                <th>Prioridad</th>
                <th>Título</th>
                <th>Estado</th>
                <th>Asignado</th>
                <th>Incidente</th>
                <th>Ocurrida</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((alert) => (
                <tr
                  key={alert.id}
                  tabIndex={0}
                  data-alert-id={alert.id}
                  className={`soc-alert-row${selected?.id === alert.id ? ' is-selected' : ''}`}
                  aria-selected={selected?.id === alert.id}
                  onClick={() => {
                    setSelected(alert);
                    onNavigate(`/alerts/${encodeURIComponent(alert.id)}`);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      setSelected(alert);
                      onNavigate(`/alerts/${encodeURIComponent(alert.id)}`);
                    }
                  }}
                >
                  <td>
                    <Severity value={alert.priority} score={alert.score} />
                  </td>
                  <td>
                    <strong>{alert.title}</strong>
                    <small>{alert.id.slice(0, 8)}…</small>
                  </td>
                  <td>
                    <StatusChip state={stateTone(alert.status)}>
                      {alertStatus[alert.status] ?? alert.status}
                    </StatusChip>
                  </td>
                  <td>
                    {alert.assigneeId ? (
                      <code>{alert.assigneeId.slice(0, 8)}…</code>
                    ) : (
                      <span className="soc-muted">Sin asignar</span>
                    )}
                  </td>
                  <td>
                    {alert.incidentId ? (
                      <button
                        className="soc-inline-link"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onNavigate(`/incidents/${encodeURIComponent(alert.incidentId ?? '')}`);
                        }}
                      >
                        <code>{alert.incidentId.slice(0, 8)}…</code>
                      </button>
                    ) : (
                      <span className="soc-muted">—</span>
                    )}
                  </td>
                  <td>
                    <RelativeTime value={alert.occurredAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading ? (
          <div className="soc-table-placeholder" role="status">
            Cargando alertas…
          </div>
        ) : null}
        {!loading && visible.length === 0 && !error ? (
          <EmptyState>
            {query
              ? 'Ninguna alerta coincide con el filtro de esta página.'
              : 'No hay alertas en este estado.'}
          </EmptyState>
        ) : null}
        {cursor ? (
          <div className="soc-table-footer">
            <Button onClick={() => void load(status, cursor)}>Cargar más</Button>
            <span>Se muestran {items.length} alertas recibidas.</span>
          </div>
        ) : null}
      </div>
      {selected ? (
        <AlertDetailDrawer
          selected={selected}
          session={session}
          error={error}
          busy={busy}
          onClose={() => {
            setSelected(null);
            onNavigate(`/alerts?status=${status}`);
          }}
          onRetry={() => void load()}
          onCommand={execute}
          onOpenIncident={openIncident}
          onNavigate={onNavigate}
        />
      ) : null}
    </div>
  );
}
