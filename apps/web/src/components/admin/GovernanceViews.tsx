import type { FormEvent } from 'react';
import type { AccessRequest, AuditEventSummary } from '../../api/admin.js';
import { Empty, Icon, SearchBox, SectionHeader, Status, TableFrame, formatDate } from './admin-ui.js';
export function AccessView({
  requests,
  showForm,
  setShowForm,
  onSubmit,
  busy,
}: {
  requests: readonly AccessRequest[];
  showForm: boolean;
  setShowForm: (value: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  busy: boolean;
}) {
  return (
    <div className="view-stack">
      <div className="access-policy">
        <Icon name="access" size={19} />
        <p>
          <strong>Separación de funciones activa.</strong> Platform Admin no concede roles ni se
          autoasigna privilegios. Cada grant requiere un segundo aprobador independiente y scope
          explícito.
        </p>
        <button type="button" className="secondary-button" onClick={() => setShowForm(!showForm)}>
          <Icon name="plus" size={16} /> Solicitar acceso
        </button>
      </div>
      {showForm && (
        <form className="request-form" onSubmit={onSubmit}>
          <div className="form-heading">
            <h2>Solicitud de grant</h2>
            <span>Solo se registra para doble aprobación</span>
          </div>
          <label>
            Persona o correo
            <input name="target" required type="email" placeholder="nombre@institucion.pe" />
          </label>
          <label>
            Bundle solicitado
            <select name="bundle" required>
              <option value="SOC_L1">SOC L1</option>
              <option value="SOC_L2">SOC L2</option>
              <option value="PLATFORM_ADMIN">Platform Admin</option>
              <option value="ACCESS_ADMIN">Access Admin</option>
            </select>
          </label>
          <label>
            Ámbito
            <input name="scope" required placeholder="Equipo, unidad o recurso" />
          </label>
          <label className="field-wide">
            Justificación
            <textarea
              name="reason"
              required
              minLength={12}
              placeholder="Explica la necesidad y duración del acceso"
            />
          </label>
          <div className="form-actions">
            <button type="button" className="text-button" onClick={() => setShowForm(false)}>
              Cancelar
            </button>
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? 'Registrando…' : 'Enviar a doble aprobación'}
            </button>
          </div>
        </form>
      )}
      <div className="data-section table-section">
        <SectionHeader title="Solicitudes de acceso" />
        <TableFrame>
          <thead>
            <tr>
              <th>Solicitud</th>
              <th>Solicitante</th>
              <th>Persona objetivo</th>
              <th>Bundle</th>
              <th>Scope</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => (
              <tr key={request.id}>
                <td>
                  <strong>{request.id}</strong>
                  <small>{formatDate(request.submittedAt)}</small>
                </td>
                <td>{request.requester}</td>
                <td>{request.target}</td>
                <td>{request.requestedBundle.replace('_', ' ')}</td>
                <td>{request.scope}</td>
                <td>
                  <Status value={request.state} />
                </td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      </div>
      <p className="data-footnote">
        Aprobar o rechazar se reserva a Access Admin independiente según ADR-017 y la matriz
        vigente. La interfaz nunca reemplaza el enforcement del backend.
      </p>
    </div>
  );
}

export function AuditView({
  events,
  query,
  setQuery,
}: {
  events: readonly AuditEventSummary[];
  query: string;
  setQuery: (value: string) => void;
}) {
  return (
    <div className="view-stack">
      <div className="table-toolbar">
        <span className="audit-note">
          <Icon name="shield" size={16} /> Registro de solo lectura · exportación separada
        </span>
        <SearchBox value={query} onChange={setQuery} label="Buscar en auditoría" />
      </div>
      <div className="data-section table-section">
        <TableFrame>
          <thead>
            <tr>
              <th>Evento</th>
              <th>Actor</th>
              <th>Acción</th>
              <th>Recurso</th>
              <th>Resultado</th>
              <th>Correlación</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>
                  <strong>{event.id}</strong>
                  <small>{formatDate(event.occurredAt)}</small>
                </td>
                <td>{event.actor}</td>
                <td>
                  <code>{event.action}</code>
                </td>
                <td>{event.resource}</td>
                <td>
                  <Status value={event.outcome} />
                </td>
                <td>
                  <code>{event.correlationId}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
        {events.length === 0 && (
          <Empty title="Sin coincidencias" detail="Intenta buscar por actor, acción o recurso." />
        )}
      </div>
      <p className="data-footnote">
        Eventos de ejemplo; no representan AuditEvent productivo ni cadena de integridad verificada.
      </p>
    </div>
  );
}
