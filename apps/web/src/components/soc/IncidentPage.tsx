import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiErrorBody } from '@qapaq/contracts';
import { api, type IncidentView, type SessionView } from '../../api/client.js';
import { Button, EmptyState, ErrorState, RelativeTime, Severity, SocIcon } from './soc-ui.js';
import { PageHeader, StateCell, statusLabel } from './soc-data-ui.js';

export function IncidentPage({
  session,
  path,
  onNavigate,
}: {
  readonly session: SessionView;
  readonly path: string;
  readonly onNavigate: (path: string) => void;
}): React.JSX.Element {
  const [items, setItems] = useState<readonly IncidentView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const initialSearch = new URLSearchParams(path.split('?')[1] ?? '').get('q') ?? '';
  const [search, setSearch] = useState(initialSearch);
  const [appliedSearch, setAppliedSearch] = useState(initialSearch);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [selected, setSelected] = useState<IncidentView | null>(null);
  const [closureReason, setClosureReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [updated, setUpdated] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const incidentTab = new URLSearchParams(path.split('?')[1] ?? '').get('status') ?? 'active';
  const load = useCallback(
    async (cursor?: string, status = incidentTab, query = appliedSearch) => {
      setBusy(true);
      const result = await api.incidents(cursor, status, query);
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setItems((current) => (cursor ? [...current, ...result.data.items] : result.data.items));
      setTotalCount(result.data.totalCount ?? result.data.items.length);
      setNextCursor(result.data.nextCursor);
      setError(null);
      setUpdated(new Date().toISOString());
    },
    [appliedSearch, incidentTab],
  );
  useEffect(() => {
    void load(undefined, incidentTab, appliedSearch);
  }, [appliedSearch, incidentTab]);
  useEffect(() => {
    const nextSearch = new URLSearchParams(path.split('?')[1] ?? '').get('q') ?? '';
    setSearch(nextSearch);
    setAppliedSearch(nextSearch);
  }, [path]);
  useEffect(() => {
    const id = new URLSearchParams(path.split('?')[1] ?? '').get('open');
    if (path.includes('/incidents/')) {
      const routeId = decodeURIComponent(path.split('/incidents/')[1]?.split('?')[0] ?? '');
      const item = items.find((row) => row.id === routeId) ?? items.find((row) => row.id === id);
      if (item) setSelected(item);
      else if (routeId && selected?.id !== routeId) {
        void api.incident(routeId).then((result) => {
          if (result.ok) setSelected(result.data.incident);
          else setError(result.error);
        });
      }
    }
  }, [path, items, selected?.id]);
  async function command(name: string): Promise<void> {
    if (!selected) return;
    setBusy(true);
    const body: Record<string, unknown> = { name, expectedRevision: selected.revision };
    if (name === 'close') body.closureReason = closureReason;
    const result = await api.incidentCommand(selected.id, body);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      if (result.error.code === 'STATE_CONFLICT') await load();
      return;
    }
    setSelected(result.data.incident);
    setClosureReason('');
    await load();
  }
  const canWrite = session.capabilities.includes('incidents.write');
  const canClose = session.capabilities.includes('incidents.close');
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !selected) void load();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [load, selected]);
  useEffect(() => {
    if (!selected) return;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setSelected(null);
      onNavigate(listPath());
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>(`[data-incident-id="${selected.id}"]`)?.focus();
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected?.id, onNavigate]);
  const visibleIncidents = items;

  function listPath(status = incidentTab, query = appliedSearch): string {
    const params = new URLSearchParams({ status });
    if (query) params.set('q', query);
    return `/incidents?${params.toString()}`;
  }
  return (
    <div className="soc-page">
      <PageHeader
        title="Incidentes"
        description="Seguimiento de incidentes, responsables y fase de respuesta."
        updated={updated}
        action={
          <Button onClick={() => void load()}>
            <SocIcon name="refresh" /> Actualizar
          </Button>
        }
      />
      <div className="soc-tabs" role="group" aria-label="Filtrar incidentes por estado">
        {[
          { value: 'active', label: 'Activos' },
          { value: 'resolved', label: 'Resueltos' },
          { value: 'closed', label: 'Cerrados' },
        ].map((tab) => (
          <button
            type="button"
            aria-pressed={incidentTab === tab.value}
            className={incidentTab === tab.value ? 'is-active' : ''}
            key={tab.value}
            onClick={() => onNavigate(listPath(tab.value))}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <form
        className="soc-filter-bar"
        onSubmit={(event) => {
          event.preventDefault();
          const normalized = search.trim();
          setAppliedSearch(normalized);
          onNavigate(listPath(incidentTab, normalized));
        }}
      >
        <label className="soc-search-field">
          <SocIcon name="search" />
          <span className="visually-hidden">Buscar por incidente, identificador o responsable</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar por incidente, identificador o responsable"
          />
        </label>
        <Button type="submit" variant="primary" disabled={busy}>
          Buscar
        </Button>
        {appliedSearch ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setSearch('');
              setAppliedSearch('');
              onNavigate(listPath(incidentTab, ''));
            }}
          >
            Limpiar búsqueda
          </Button>
        ) : null}
        <span className="soc-page-note">Resultados en toda la cola autorizada.</span>
      </form>
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      <div className="soc-table-panel">
        <div className="soc-table-scroll">
          <table className="soc-table">
            <thead>
              <tr>
                <th>Severidad</th>
                <th>Incidente</th>
                <th>Fase</th>
                <th>Responsable</th>
                <th>Alertas</th>
                <th>Abierto</th>
              </tr>
            </thead>
            <tbody>
              {visibleIncidents.map((incident) => (
                <tr key={incident.id} className={selected?.id === incident.id ? 'is-selected' : ''}>
                  <td>
                    <Severity value={incident.severity} />
                  </td>
                  <td>
                    <button
                      className="soc-row-link"
                      type="button"
                      data-incident-id={incident.id}
                      onClick={() => {
                        setSelected(incident);
                        onNavigate(`/incidents/${encodeURIComponent(incident.id)}`);
                      }}
                    >
                      {incident.title}
                    </button>
                    <small>{incident.summary}</small>
                  </td>
                  <td>
                    <StateCell value={incident.status} />
                  </td>
                  <td>
                    <code>{incident.ownerId.slice(0, 8)}…</code>
                  </td>
                  <td className="is-numeric">{incident.alertIds.length}</td>
                  <td>
                    <RelativeTime value={incident.openedAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {visibleIncidents.length === 0 && !error && !busy ? (
          <EmptyState>
            {appliedSearch
              ? 'No hay incidentes que coincidan con la búsqueda. Revisa el término o limpia el filtro.'
              : 'No hay incidentes para este estado.'}
          </EmptyState>
        ) : null}
        {items.length > 0 ? (
          <div className="soc-table-footer">
            {nextCursor ? (
              <Button onClick={() => void load(nextCursor)} disabled={busy}>
                Cargar más
              </Button>
            ) : null}
            <span>
              Mostrando {items.length} de {totalCount} incidentes.
            </span>
          </div>
        ) : null}
      </div>
      {selected ? (
        <aside className="soc-drawer" aria-label={`Detalle de ${selected.title}`}>
          <header>
            <div>
              <span className="soc-drawer__eyebrow">Incidente · {selected.id.slice(0, 8)}…</span>
              <h2>{selected.title}</h2>
            </div>
            <Button
              buttonRef={closeButtonRef}
              variant="ghost"
              onClick={() => {
                setSelected(null);
                onNavigate(listPath());
                window.requestAnimationFrame(() => {
                  document
                    .querySelector<HTMLButtonElement>(`[data-incident-id="${selected.id}"]`)
                    ?.focus();
                });
              }}
              aria-label="Cerrar detalle"
            >
              <SocIcon name="close" />
            </Button>
          </header>
          <div className="soc-drawer__body">
            <Severity value={selected.severity} />
            <StateCell value={selected.status} />
            <dl className="soc-description-list">
              <dt>Responsable</dt>
              <dd>
                <code>{selected.ownerId}</code>
              </dd>
              <dt>Abierto</dt>
              <dd>
                <RelativeTime value={selected.openedAt} />
              </dd>
              <dt>Alertas vinculadas</dt>
              <dd>{selected.alertIds.length}</dd>
            </dl>
            <section>
              <h3>Resumen</h3>
              <p>{selected.summary}</p>
            </section>
            <section>
              <h3>Fase de respuesta</h3>
              <div className="soc-lifecycle">
                {(['open', 'contained', 'eradicated', 'resolved', 'closed'] as const).map(
                  (status) => (
                    <span key={status} className={status === selected.status ? 'is-current' : ''}>
                      {statusLabel(status)}
                    </span>
                  ),
                )}
              </div>
            </section>
            {canWrite || canClose ? (
              <section className="soc-actions">
                <h3>Acciones</h3>
                {selected.status === 'open' && canWrite ? (
                  <Button onClick={() => void command('contain')} disabled={busy}>
                    Marcar contenido
                  </Button>
                ) : null}
                {selected.status === 'contained' && canWrite ? (
                  <>
                    <Button onClick={() => void command('eradicate')} disabled={busy}>
                      Marcar erradicado
                    </Button>
                    <Button onClick={() => void command('resolve')} disabled={busy}>
                      Marcar resuelto
                    </Button>
                  </>
                ) : null}
                {selected.status === 'eradicated' && canWrite ? (
                  <Button onClick={() => void command('resolve')} disabled={busy}>
                    Marcar resuelto
                  </Button>
                ) : null}
                {selected.status === 'resolved' && canClose ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void command('close');
                    }}
                  >
                    <label htmlFor="incident-closure">Motivo de cierre</label>
                    <textarea
                      id="incident-closure"
                      value={closureReason}
                      onChange={(event) => setClosureReason(event.target.value)}
                      minLength={10}
                      maxLength={2000}
                    />
                    <small>Describe la resolución (mínimo 10 caracteres).</small>
                    <Button
                      variant="danger"
                      type="submit"
                      disabled={busy || closureReason.trim().length < 10}
                    >
                      Cerrar incidente
                    </Button>
                  </form>
                ) : null}
                {selected.status === 'closed' && canWrite ? (
                  <Button onClick={() => void command('reopen')} disabled={busy}>
                    Reabrir
                  </Button>
                ) : null}
              </section>
            ) : null}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
