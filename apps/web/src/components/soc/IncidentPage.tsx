import { useCallback, useEffect, useState } from 'react';
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
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [selected, setSelected] = useState<IncidentView | null>(null);
  const [closureReason, setClosureReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [updated, setUpdated] = useState<string | null>(null);
  const load = useCallback(async (cursor?: string) => {
    const result = await api.incidents(cursor);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setItems((current) => (cursor ? [...current, ...result.data.items] : result.data.items));
    setNextCursor(result.data.nextCursor);
    setError(null);
    setUpdated(new Date().toISOString());
  }, []);
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    const id = new URLSearchParams(path.split('?')[1] ?? '').get('open');
    if (path.includes('/incidents/')) {
      const routeId = decodeURIComponent(path.split('/incidents/')[1]?.split('?')[0] ?? '');
      const item = items.find((row) => row.id === routeId) ?? items.find((row) => row.id === id);
      if (item) setSelected(item);
    }
  }, [path, items]);
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
  const incidentTab = new URLSearchParams(path.split('?')[1] ?? '').get('status') ?? 'active';
  const visibleIncidents = items.filter((incident) =>
    incidentTab === 'resolved'
      ? incident.status === 'resolved'
      : incidentTab === 'closed'
        ? incident.status === 'closed'
        : !['resolved', 'closed'].includes(incident.status),
  );
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
      <div className="soc-tabs" role="tablist" aria-label="Estado de incidentes">
        {[
          { value: 'active', label: 'Activos' },
          { value: 'resolved', label: 'Resueltos' },
          { value: 'closed', label: 'Cerrados' },
        ].map((tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={incidentTab === tab.value}
            className={incidentTab === tab.value ? 'is-active' : ''}
            key={tab.value}
            onClick={() => onNavigate(`/incidents?status=${tab.value}`)}
          >
            {tab.label}
          </button>
        ))}
      </div>
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
                <tr
                  key={incident.id}
                  className={selected?.id === incident.id ? 'is-selected' : ''}
                  onClick={() => {
                    setSelected(incident);
                    onNavigate(`/incidents/${encodeURIComponent(incident.id)}`);
                  }}
                >
                  <td>
                    <Severity value={incident.severity} />
                  </td>
                  <td>
                    <strong>{incident.title}</strong>
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
        {visibleIncidents.length === 0 && !error ? (
          <EmptyState>No hay incidentes en esta página.</EmptyState>
        ) : null}
        {nextCursor ? (
          <div className="soc-table-footer">
            <Button onClick={() => void load(nextCursor)}>Cargar más</Button>
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
              variant="ghost"
              onClick={() => {
                setSelected(null);
                onNavigate('/incidents');
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
