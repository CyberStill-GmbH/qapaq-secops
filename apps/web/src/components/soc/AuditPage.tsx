import { useCallback, useEffect, useState } from 'react';
import type { ApiErrorBody } from '@qapaq/contracts';
import { api, type AuditEventView, type SessionView } from '../../api/client.js';
import { Button, EmptyState, ErrorState, SocIcon } from './soc-ui.js';
import { PageHeader, StateCell } from './soc-data-ui.js';

interface AuditQuery {
  readonly from: string;
  readonly to: string;
  readonly action: string;
  readonly actorId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly outcome: string;
}

function localDateTime(value: Date): string {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function initialQuery(): AuditQuery {
  const to = new Date();
  return {
    from: localDateTime(new Date(to.getTime() - 86_400_000)),
    to: localDateTime(to),
    action: '',
    actorId: '',
    resourceType: '',
    resourceId: '',
    outcome: '',
  };
}

export function AuditPage({ session }: { readonly session: SessionView }): React.JSX.Element {
  const [items, setItems] = useState<readonly AuditEventView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [validationError, setValidationError] = useState('');
  const [updated, setUpdated] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<AuditQuery>(initialQuery);
  const [applied, setApplied] = useState<AuditQuery>(draft);

  const load = useCallback(
    async (cursor?: string, append = false) => {
      setLoading(true);
      const from = new Date(applied.from);
      const to = new Date(applied.to);
      const result = await api.audit(
        from.toISOString(),
        to.toISOString(),
        applied.action || undefined,
        {
          ...(cursor ? { cursor } : {}),
          ...(applied.actorId ? { actorId: applied.actorId } : {}),
          ...(applied.resourceType ? { resourceType: applied.resourceType } : {}),
          ...(applied.resourceId ? { resourceId: applied.resourceId } : {}),
          ...(applied.outcome ? { outcome: applied.outcome } : {}),
        },
      );
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setItems((current) => (append ? [...current, ...result.data.items] : result.data.items));
      setNextCursor(result.data.nextCursor);
      setError(null);
      setUpdated(new Date().toISOString());
    },
    [applied],
  );

  useEffect(() => {
    void load();
  }, [load]);

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const from = new Date(draft.from);
    const to = new Date(draft.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      setValidationError('Ingresa un intervalo de fechas válido.');
      return;
    }
    if (from.getTime() > to.getTime()) {
      setValidationError('La fecha inicial debe ser anterior a la fecha final.');
      return;
    }
    if (to.getTime() - from.getTime() > 365 * 86_400_000) {
      setValidationError('El BFF permite consultar hasta 365 días por búsqueda.');
      return;
    }
    setValidationError('');
    setItems([]);
    setNextCursor(null);
    setApplied({ ...draft, from: from.toISOString(), to: to.toISOString() });
  }

  const sensitive = session.capabilities.includes('audit.read_sensitive');
  return (
    <div className="soc-page">
      <PageHeader
        title="Auditoría"
        description="Acciones y resultados registrados para el intervalo consultado."
        updated={updated}
        action={
          <Button onClick={() => void load()} disabled={loading}>
            <SocIcon name="refresh" /> {loading ? 'Consultando…' : 'Actualizar'}
          </Button>
        }
      />
      <form className="soc-filter-bar" onSubmit={submit}>
        <label>
          Desde
          <input
            aria-label="Desde"
            type="datetime-local"
            value={draft.from.slice(0, 16)}
            onChange={(event) => setDraft((value) => ({ ...value, from: event.target.value }))}
          />
        </label>
        <label>
          Hasta
          <input
            aria-label="Hasta"
            type="datetime-local"
            value={draft.to.slice(0, 16)}
            onChange={(event) => setDraft((value) => ({ ...value, to: event.target.value }))}
          />
        </label>
        <label>
          Acción
          <select
            value={draft.action}
            onChange={(event) => setDraft((value) => ({ ...value, action: event.target.value }))}
          >
            <option value="">Todas</option>
            <option value="access.sign_in">Inicio de sesión</option>
            <option value="soc.alert.triage">Triaje de alerta</option>
            <option value="soc.incident.close">Cierre de incidente</option>
          </select>
        </label>
        <label>
          Actor (ID exacto)
          <input
            value={draft.actorId}
            onChange={(event) => setDraft((value) => ({ ...value, actorId: event.target.value }))}
            placeholder="Identidad o servicio"
          />
        </label>
        <label>
          Tipo de recurso
          <input
            value={draft.resourceType}
            onChange={(event) =>
              setDraft((value) => ({ ...value, resourceType: event.target.value }))
            }
            placeholder="alert, incident…"
          />
        </label>
        <label>
          Recurso (ID exacto)
          <input
            value={draft.resourceId}
            onChange={(event) =>
              setDraft((value) => ({ ...value, resourceId: event.target.value }))
            }
            placeholder="ID del recurso"
          />
        </label>
        <label>
          Resultado
          <select
            value={draft.outcome}
            onChange={(event) => setDraft((value) => ({ ...value, outcome: event.target.value }))}
          >
            <option value="">Todos</option>
            <option value="allowed">Permitido</option>
            <option value="succeeded">Correcto</option>
            <option value="denied">Denegado</option>
            <option value="failed">Fallido</option>
          </select>
        </label>
        <Button variant="primary" type="submit" disabled={loading}>
          Consultar
        </Button>
      </form>
      {validationError ? (
        <p className="soc-overdue" role="alert">
          {validationError}
        </p>
      ) : null}
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      {loading && items.length > 0 ? (
        <p className="soc-page-note" role="status">
          Actualizando resultados…
        </p>
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
              {items.map((item) => (
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
        {items.length === 0 && !error && !loading ? (
          <EmptyState>No hay eventos de auditoría que coincidan con esta consulta.</EmptyState>
        ) : null}
        {nextCursor ? (
          <div className="soc-table-footer">
            <Button onClick={() => void load(nextCursor, true)} disabled={loading}>
              {loading ? 'Cargando…' : 'Cargar más registros'}
            </Button>
            <span>{items.length} registros cargados · hay más resultados</span>
          </div>
        ) : null}
      </div>
      <p className="soc-page-note">
        Los filtros se aplican en el BFF. El cursor continúa la misma consulta; los datos sensibles
        dependen del permiso de auditoría de tu sesión.
      </p>
    </div>
  );
}
