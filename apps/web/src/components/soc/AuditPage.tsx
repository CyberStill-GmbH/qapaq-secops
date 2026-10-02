import { useCallback, useEffect, useState } from 'react';
import type { ApiErrorBody } from '@qapaq/contracts';
import { api, type AuditEventView, type SessionView } from '../../api/client.js';
import { Button, EmptyState, ErrorState, SocIcon } from './soc-ui.js';
import { PageHeader, StateCell } from './soc-data-ui.js';

export function AuditPage({ session }: { readonly session: SessionView }): React.JSX.Element {
  const [items, setItems] = useState<readonly AuditEventView[]>([]);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [updated, setUpdated] = useState<string | null>(null);
  const [action, setAction] = useState('');
  const [from, setFrom] = useState(() => new Date(Date.now() - 86_400_000).toISOString());
  const [to, setTo] = useState(() => new Date().toISOString());
  const [filter, setFilter] = useState('');
  const load = useCallback(async () => {
    const result = await api.audit(from, to, action || undefined);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setItems(result.data.items);
    setError(null);
    setUpdated(new Date().toISOString());
  }, [action, from, to]);
  useEffect(() => {
    void load();
  }, []);
  const filtered = items.filter(
    (item) =>
      !filter ||
      `${item.actor.id} ${item.resource.id} ${item.correlationId}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
  );
  const sensitive = session.capabilities.includes('audit.read_sensitive');
  return (
    <div className="soc-page">
      <PageHeader
        title="Auditoría"
        description="Registro de acciones y resultados para la ventana consultada."
        updated={updated}
        action={
          <Button onClick={() => void load()}>
            <SocIcon name="refresh" /> Consultar
          </Button>
        }
      />
      <form
        className="soc-filter-bar"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <label>
          Desde
          <input
            aria-label="Desde"
            type="datetime-local"
            value={from.slice(0, 16)}
            onChange={(event) => setFrom(new Date(event.target.value).toISOString())}
          />
        </label>
        <label>
          Hasta
          <input
            aria-label="Hasta"
            type="datetime-local"
            value={to.slice(0, 16)}
            onChange={(event) => setTo(new Date(event.target.value).toISOString())}
          />
        </label>
        <label>
          Acción
          <select value={action} onChange={(event) => setAction(event.target.value)}>
            <option value="">Todas</option>
            <option value="access.sign_in">Inicio de sesión</option>
            <option value="soc.alert.triage">Triaje de alerta</option>
            <option value="soc.incident.close">Cierre de incidente</option>
          </select>
        </label>
        <label>
          Actor o recurso
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filtrar esta página"
          />
        </label>
        <Button variant="primary" type="submit">
          Consultar
        </Button>
      </form>
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      {filter ? (
        <div className="soc-partial-banner">
          Filtro aplicado a esta página ({filtered.length} de {items.length} eventos).
        </div>
      ) : null}
      <div className="soc-table-panel">
        <div className="soc-table-scroll">
          <table className="soc-table">
            <thead>
              <tr>
                <th>Secuencia</th>
                <th>Instante</th>
                <th>Actor</th>
                <th>Acción</th>
                <th>Recurso</th>
                <th>Resultado</th>
                <th>Correlación</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={item.id}>
                  <td>
                    <code>{item.sequence}</code>
                  </td>
                  <td>
                    <time dateTime={item.occurredAt}>
                      {new Intl.DateTimeFormat('es-PE', {
                        dateStyle: 'short',
                        timeStyle: 'medium',
                        timeZone: 'America/Lima',
                      }).format(new Date(item.occurredAt))}
                    </time>
                  </td>
                  <td>
                    <code>{item.actor.id}</code>
                    <small>
                      {item.actor.type}
                      {!sensitive &&
                      (item.actor.ip === '[REDACTED]' || item.actor.sessionId === '[REDACTED]')
                        ? ' · datos sensibles redactados'
                        : ''}
                    </small>
                  </td>
                  <td>
                    <code>{item.action}</code>
                  </td>
                  <td>
                    <code>
                      {item.resource.type} · {item.resource.id}
                    </code>
                  </td>
                  <td>
                    <StateCell value={item.outcome} />
                  </td>
                  <td>
                    <code title={item.correlationId}>{item.correlationId.slice(0, 8)}…</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && !error ? (
          <EmptyState>No hay eventos de auditoría que coincidan con esta consulta.</EmptyState>
        ) : null}
      </div>
      <p className="soc-page-note">
        La auditoría se entrega en orden de secuencia ascendente. El filtro de actor o recurso se
        aplica a esta página.
      </p>
    </div>
  );
}
