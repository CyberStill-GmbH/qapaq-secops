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
const entityRefPattern = /^ent_[A-Za-z0-9_-]{22}$/u;
type AlertPriority = 'P1' | 'P2' | 'P3' | 'P4';
function isAlertPriority(value: string | null): value is AlertPriority {
  return value !== null && ['P1', 'P2', 'P3', 'P4'].includes(value);
}
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
        <p>Filtra alertas por estado, prioridad o texto de investigación.</p>
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
  const initialParams = new URLSearchParams(path.split('?')[1] ?? '');
  const initialQuery = initialParams.get('q') ?? '';
  const initialPriority = initialParams.get('priority') ?? '';
  const initialEntityValue = initialParams.get('entity') ?? '';
  const initialEntity = entityRefPattern.test(initialEntityValue) ? initialEntityValue : '';
  const [items, setItems] = useState<readonly AlertView[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [appliedQuery, setAppliedQuery] = useState(initialQuery);
  const [priority, setPriority] = useState<'' | AlertPriority>(
    isAlertPriority(initialPriority) ? initialPriority : '',
  );
  const [appliedPriority, setAppliedPriority] = useState<'' | AlertPriority>(
    isAlertPriority(initialPriority) ? initialPriority : '',
  );
  const [appliedEntity, setAppliedEntity] = useState(initialEntity);
  const [selected, setSelected] = useState<AlertView | null>(null);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [updated, setUpdated] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Compatibility with older deep links: replace the current history entry so a raw
    // UPN/IP or free-text query is not retained in the browser URL/history.
    const [pathname, rawSearch] = path.split('?', 2);
    if (pathname !== '/alerts') return;
    const params = new URLSearchParams(rawSearch ?? '');
    const rawEntity = params.get('entity');
    const mustSanitize =
      params.has('q') || (rawEntity !== null && !entityRefPattern.test(rawEntity));
    if (!mustSanitize) return;
    params.delete('q');
    if (rawEntity !== null && !entityRefPattern.test(rawEntity)) params.delete('entity');
    const search = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      search ? `${pathname}?${search}` : pathname,
    );
  }, [path]);

  const load = useCallback(
    async (
      nextStatus: 'open' | AlertStatus = status,
      nextCursor?: string,
      nextQuery: string = appliedQuery,
      nextPriority: '' | AlertPriority = appliedPriority,
      nextEntity: string = appliedEntity,
    ) => {
      setLoading(true);
      const result = await api.alertsByStatus(
        nextStatus,
        nextCursor,
        nextQuery,
        nextPriority || undefined,
        nextEntity || undefined,
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
      setTotalCount(result.data.totalCount ?? rows.length);
      setCursor(result.data.nextCursor);
      setError(null);
      setUpdated(new Date().toISOString());
    },
    [appliedEntity, appliedPriority, appliedQuery, status],
  );

  useEffect(() => {
    void load(status, undefined, appliedQuery, appliedPriority, appliedEntity);
  }, [appliedEntity, appliedPriority, appliedQuery, load, status]);
  useEffect(() => {
    const value = new URLSearchParams(path.split('?')[1] ?? '').get('status');
    if (isAlertTab(value)) setStatus(value);
    const nextQuery = new URLSearchParams(path.split('?')[1] ?? '').get('q') ?? '';
    setQuery(nextQuery);
    setAppliedQuery(nextQuery);
    const nextPriority = new URLSearchParams(path.split('?')[1] ?? '').get('priority');
    const safePriority = isAlertPriority(nextPriority) ? nextPriority : '';
    setPriority(safePriority);
    setAppliedPriority(safePriority);
    setAppliedEntity(new URLSearchParams(path.split('?')[1] ?? '').get('entity') ?? '');
  }, [path]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !selected)
        void load(status, undefined, appliedQuery, appliedPriority, appliedEntity);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [appliedEntity, appliedPriority, appliedQuery, load, selected, status]);
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
        onNavigate(listPath(status));
        return;
      }
      if (event.key === 'j' || event.key === 'k') {
        const rows = [
          ...document.querySelectorAll<HTMLButtonElement>('.soc-alert-row .soc-row-link'),
        ];
        if (rows.length === 0) return;
        const activeRow =
          document.activeElement instanceof HTMLElement
            ? document.activeElement.closest<HTMLButtonElement>('.soc-row-link')
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
  }, [appliedEntity, appliedPriority, appliedQuery, onNavigate, selected, status]);
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

  const visible = items;

  function listPath(
    nextStatus: 'open' | AlertStatus,
    nextPriority = appliedPriority,
    nextEntity = appliedEntity,
  ): string {
    const params = new URLSearchParams({ status: nextStatus });
    if (nextPriority) params.set('priority', nextPriority);
    if (entityRefPattern.test(nextEntity)) params.set('entity', nextEntity);
    return `/alerts?${params.toString()}`;
  }

  return (
    <div className="soc-page">
      <Header updated={updated} onRefresh={() => void load()} />
      <div className="soc-tabs" role="group" aria-label="Filtrar alertas por estado">
        {statuses.map((entry) => (
          <button
            key={entry.value}
            type="button"
            aria-pressed={status === entry.value}
            className={status === entry.value ? 'is-active' : ''}
            onClick={() => {
              setStatus(entry.value);
              setSelected(null);
              onNavigate(listPath(entry.value));
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <form
        className="soc-filter-bar"
        onSubmit={(event) => {
          event.preventDefault();
          const normalized = query.trim();
          setAppliedPriority(priority);
          setAppliedQuery(normalized);
          setSelected(null);
          onNavigate(listPath(status, priority));
        }}
      >
        <label className="soc-search-field">
          <SocIcon name="search" />
          <span className="visually-hidden">Buscar alertas por título, ID o responsable</span>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar alertas por título, ID o responsable"
          />
          <kbd>/</kbd>
        </label>
        <label className="soc-priority-filter">
          Prioridad
          <select
            value={priority}
            onChange={(event) => setPriority(event.target.value as '' | AlertPriority)}
          >
            <option value="">Todas</option>
            <option value="P1">P1 · Crítica</option>
            <option value="P2">P2 · Alta</option>
            <option value="P3">P3 · Media</option>
            <option value="P4">P4 · Baja</option>
          </select>
        </label>
        <Button type="submit" variant="primary" disabled={loading}>
          Buscar
        </Button>
        {appliedQuery || appliedPriority || appliedEntity ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setQuery('');
              setAppliedQuery('');
              setPriority('');
              setAppliedPriority('');
              setAppliedEntity('');
              onNavigate(listPath(status, '', ''));
            }}
          >
            Limpiar filtros
          </Button>
        ) : null}
        {appliedEntity ? (
          <span className="soc-active-entity" title={appliedEntity}>
            Entidad: <code>{appliedEntity}</code>
          </span>
        ) : null}
        <span className="soc-page-note">
          Busca en toda la cola autorizada · j / k para recorrer.
        </span>
      </form>
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
                  data-alert-id={alert.id}
                  className={`soc-alert-row${selected?.id === alert.id ? ' is-selected' : ''}`}
                >
                  <td>
                    <Severity value={alert.priority} score={alert.score} />
                  </td>
                  <td>
                    <button
                      className="soc-row-link"
                      type="button"
                      onClick={() => {
                        setSelected(alert);
                        onNavigate(`/alerts/${encodeURIComponent(alert.id)}`);
                      }}
                    >
                      {alert.title}
                    </button>
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
            {appliedQuery
              ? 'No hay alertas que coincidan con la búsqueda. Revisa el término o limpia el filtro.'
              : 'No hay alertas para este estado.'}
          </EmptyState>
        ) : null}
        {items.length > 0 ? (
          <div className="soc-table-footer">
            {cursor ? (
              <Button
                onClick={() =>
                  void load(status, cursor, appliedQuery, appliedPriority, appliedEntity)
                }
                disabled={loading}
              >
                Cargar más
              </Button>
            ) : null}
            <span>
              Mostrando {items.length} de {totalCount} alertas.
            </span>
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
            onNavigate(listPath(status));
          }}
          onRetry={() => void load()}
          onCommand={execute}
          onOpenIncident={openIncident}
          onNavigate={(nextPath) => {
            setSelected(null);
            onNavigate(nextPath);
          }}
          onEntityPivot={(entity) => {
            setSelected(null);
            onNavigate(listPath(status, appliedPriority, entity));
          }}
        />
      ) : null}
    </div>
  );
}
