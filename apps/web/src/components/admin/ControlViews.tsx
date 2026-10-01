import type { FormEvent } from 'react';
import type { QuarantineRecord, SessionSummary } from '../../api/admin.js';
import { Status, TableFrame, formatDate } from './admin-ui.js';

export function QuarantineView({
  records,
  canReprocess,
  onReprocess,
}: {
  records: readonly QuarantineRecord[];
  canReprocess: boolean;
  onReprocess: (id: string, reason: string) => void;
}) {
  return (
    <div className="view-stack">
      <div className="data-section table-section">
        <TableFrame>
          <thead>
            <tr>
              <th>Registro</th>
              <th>Fuente</th>
              <th>Causa</th>
              <th>Estado</th>
              <th>Intentos</th>
              <th>Instante</th>
              {canReprocess && <th>Acción</th>}
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.id}>
                <td>
                  <strong>{record.id}</strong>
                </td>
                <td>{record.source}</td>
                <td>{record.reason}</td>
                <td>
                  <Status value={record.state} />
                </td>
                <td>{record.attempts}</td>
                <td>{formatDate(record.occurredAt)}</td>
                {canReprocess && (
                  <td>
                    <QuarantineAction record={record} onSubmit={onReprocess} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </TableFrame>
      </div>
      <p className="data-footnote">
        Los motivos de cuarentena son ejemplos sintéticos. Reprocesar solo registra una operación
        mock; no avanza checkpoints ni procesa mensajes reales.
      </p>
    </div>
  );
}

function QuarantineAction({
  record,
  onSubmit,
}: {
  record: QuarantineRecord;
  onSubmit: (id: string, reason: string) => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSubmit(record.id, String(form.get('reason') ?? ''));
  }
  return (
    <form className="quarantine-action" onSubmit={submit}>
      <input
        aria-label={`Motivo para reprocesar ${record.id}`}
        name="reason"
        minLength={12}
        required
        placeholder="Motivo requerido"
      />
      <button className="row-action" type="submit">
        Solicitar
      </button>
    </form>
  );
}

export function SessionsView({ sessions }: { sessions: readonly SessionSummary[] }) {
  return (
    <div className="view-stack">
      <div className="data-section table-section">
        <TableFrame>
          <thead>
            <tr>
              <th>Sesión</th>
              <th>Actor</th>
              <th>Bundle</th>
              <th>Inicio</th>
              <th>Última actividad</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.id}>
                <td>
                  <code>{session.id}</code>
                </td>
                <td>{session.actor}</td>
                <td>{session.role.replaceAll('_', ' ')}</td>
                <td>{formatDate(session.startedAt)}</td>
                <td>{formatDate(session.lastSeenAt)}</td>
                <td>
                  <Status value={session.state} />
                </td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      </div>
      <p className="data-footnote">
        Sesiones sintéticas de ejemplo. No corresponden a sesiones activas de Entra.
      </p>
    </div>
  );
}
