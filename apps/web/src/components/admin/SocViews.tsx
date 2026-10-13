import type { AlertSummary, IncidentSummary } from '../../api/admin.js';
import { Empty, Icon, SearchBox, Severity, Status, TableFrame, formatDate } from './admin-ui.js';
type AlertFilter = 'all' | 'open' | 'critical';
export function AlertsView({
  alerts,
  query,
  setQuery,
  filter,
  setFilter,
  onSelect,
}: {
  alerts: readonly AlertSummary[];
  query: string;
  setQuery: (value: string) => void;
  filter: AlertFilter;
  setFilter: (value: AlertFilter) => void;
  onSelect: (alert: AlertSummary) => void;
}) {
  const filters: readonly { id: AlertFilter; label: string }[] = [
    { id: 'all', label: 'Todas' },
    { id: 'open', label: 'Abiertas' },
    { id: 'critical', label: 'Críticas' },
  ];
  return (
    <div className="view-stack">
      <div className="table-toolbar">
        <div className="filter-tabs" role="group" aria-label="Filtrar alertas">
          {filters.map((item) => (
            <button
              key={item.id}
              type="button"
              className={filter === item.id ? 'filter-active' : ''}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <SearchBox value={query} onChange={setQuery} label="Buscar alertas" />
      </div>
      <div className="data-section table-section">
        <TableFrame>
          <thead>
            <tr>
              <th>Alerta</th>
              <th>Severidad</th>
              <th>Fuente</th>
              <th>Estado</th>
              <th>Ocurrida</th>
              <th>
                <span className="sr-only">Acción</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((alert) => (
              <tr key={alert.id} onClick={() => onSelect(alert)} className="clickable-row">
                <td>
                  <strong>{alert.title}</strong>
                  <small>
                    {alert.id} · {alert.ruleId}
                  </small>
                </td>
                <td>
                  <Severity value={alert.severity} />
                </td>
                <td>{alert.source}</td>
                <td>
                  <Status value={alert.state} />
                </td>
                <td>{formatDate(alert.occurredAt)}</td>
                <td>
                  <button
                    type="button"
                    className="row-open"
                    aria-label={`Ver ${alert.id}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(alert);
                    }}
                  >
                    <Icon name="arrow" size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
        {alerts.length === 0 && (
          <Empty title="No encontramos alertas" detail="Prueba otra búsqueda o limpia el filtro." />
        )}
      </div>
      <p className="data-footnote">
        Datos sintéticos de la demo. La respuesta real omitirá raw y aplicará autorización por
        tenant, dataset y scope.
      </p>
    </div>
  );
}

export function IncidentsView({ incidents }: { incidents: readonly IncidentSummary[] }) {
  return (
    <div className="view-stack">
      <div className="data-section table-section">
        <TableFrame>
          <thead>
            <tr>
              <th>Incidente</th>
              <th>Severidad</th>
              <th>Estado</th>
              <th>Responsable</th>
              <th>Alertas</th>
              <th>Actualizado</th>
            </tr>
          </thead>
          <tbody>
            {incidents.map((incident) => (
              <tr key={incident.id}>
                <td>
                  <strong>{incident.title}</strong>
                  <small>{incident.id}</small>
                </td>
                <td>
                  <Severity value={incident.severity} />
                </td>
                <td>
                  <Status value={incident.state} />
                </td>
                <td>{incident.owner}</td>
                <td>{incident.alertCount}</td>
                <td>{formatDate(incident.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      </div>
      <p className="data-footnote">
        La asignación y el cierre dependen de capabilities del actor y quedan auditados por el API.
      </p>
    </div>
  );
}

export function AlertDrawer({
  alert,
  busy,
  onClose,
  onAcknowledge,
}: {
  alert: AlertSummary;
  busy: boolean;
  onClose: () => void;
  onAcknowledge: () => void;
}) {
  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="alert-detail-title"
      >
        <div className="drawer-head">
          <div>
            <span className="drawer-id">{alert.id}</span>
            <button
              type="button"
              className="icon-button"
              onClick={onClose}
              aria-label="Cerrar detalle"
            >
              <Icon name="close" />
            </button>
          </div>
          <h2 id="alert-detail-title">{alert.title}</h2>
          <div>
            <Severity value={alert.severity} />
            <Status value={alert.state} />
          </div>
        </div>
        <div className="drawer-body">
          <p>{alert.summary}</p>
          <Detail label="Fuente" value={alert.source} />
          <Detail label="Regla" value={alert.ruleId} />
          <Detail label="Event UID" value={alert.eventUid} />
          <Detail label="Ocurrida" value={formatDate(alert.occurredAt)} />
          {alert.incidentId && <Detail label="Incidente vinculado" value={alert.incidentId} />}
          <div className="inline-callout">
            <Icon name="shield" size={17} />
            <p>La evidencia raw requiere capability independiente y propósito registrado.</p>
          </div>
        </div>
        <div className="drawer-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cerrar
          </button>
          {alert.state === 'new' && (
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={onAcknowledge}
            >
              {busy ? 'Guardando…' : 'Acusar alerta'}
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
