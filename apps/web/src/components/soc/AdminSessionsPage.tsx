import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { ApiErrorBody } from '@qapaq/contracts';
import { api, type AdminSessionRecord } from '../../api/client.js';
import { Button, EmptyState, ErrorState, RelativeTime, SocIcon, StatusChip } from './soc-ui.js';
import { PageHeader } from './soc-data-ui.js';
import { useChanges } from './use-changes.js';

const roleLabels: Readonly<Record<string, string>> = {
  'qapaq.soc.analyst': 'Analista SOC',
  'qapaq.soc.lead': 'Líder SOC',
  'qapaq.auditor': 'Auditor',
  'qapaq.platform.admin': 'Administrador de plataforma',
};

function sessionState(entry: AdminSessionRecord): {
  readonly label: string;
  readonly tone: 'ok' | 'warn' | 'neutral';
} {
  if (entry.state === 'active') return { label: 'Activa', tone: 'ok' };
  if (entry.state === 'expired') return { label: 'Vencida', tone: 'warn' };
  if (entry.state === 'superseded') return { label: 'Reemplazada', tone: 'neutral' };
  return { label: 'Revocada', tone: 'neutral' };
}

function revocationReasonLabel(reason: string | null): string | null {
  if (reason === 'membership_removed') return 'Salió del grupo de admisión.';
  if (reason === 'ownership_removed') return 'Dejó de ser dueño del grupo.';
  return null;
}

function dateTime(value: string): string {
  return new Intl.DateTimeFormat('es-PE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Lima',
  }).format(new Date(value));
}

export function AdminSessionsPage(): React.JSX.Element {
  const [items, setItems] = useState<readonly AdminSessionRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState(7);
  const [totalCount, setTotalCount] = useState(0);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [confirmRef, setConfirmRef] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async (append = false, cursor?: string): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);

    const result = await api.adminSessions(cursor);
    if (result.ok) {
      setItems((current) => (append ? [...current, ...result.data.items] : result.data.items));
      setNextCursor(result.data.nextCursor);
      setWindowDays(result.data.windowDays);
      setTotalCount(result.data.totalCount);
      setError(null);
      setUpdatedAt(new Date().toISOString());
    } else {
      setError(result.error);
    }
    setLoading(false);
    setRefreshing(false);
    inFlight.current = false;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  const liveChanges = useChanges({ resourceTypes: ['session'], onChange: () => void load() });

  async function revoke(entry: AdminSessionRecord): Promise<void> {
    const cleanReason = reason.trim();
    if (
      confirmRef !== entry.ref ||
      entry.current ||
      entry.state !== 'active' ||
      cleanReason.length < 10 ||
      cleanReason.length > 500
    )
      return;

    setBusyRef(entry.ref);
    setNotice(null);
    const result = await api.revokeSession(entry.ref, cleanReason, entry.revision);
    if (result.ok) {
      setItems((current) =>
        current.map((item) => (item.ref === entry.ref ? result.data.session : item)),
      );
      setNotice(`Sesión revocada · ${result.data.correlationId}`);
      setReason('');
      setConfirmRef(null);
    } else {
      setError(result.error);
    }
    setBusyRef(null);
  }

  const countLabel = totalCount >= 2_000 ? '2.000 o más registros' : `${totalCount} registros`;

  return (
    <div className="soc-page soc-admin-sessions">
      <PageHeader
        title="Sesiones de acceso"
        description="Sesiones QAPAQ observadas. La actividad corresponde a la última solicitud autenticada."
        updated={updatedAt}
        action={
          <Button onClick={() => void load()} disabled={loading || refreshing}>
            <SocIcon name="refresh" size={15} />
            {refreshing ? 'Actualizando' : 'Actualizar'}
          </Button>
        }
      />

      <div className="soc-admin-sessions__scope" role="status">
        <span>
          {countLabel} · últimos {windowDays} días · máximo 2.000
        </span>
        <span>La sesión actual no se puede revocar desde esta vista.</span>
      </div>

      {notice ? (
        <p className="soc-admin-sessions__notice" role="status">
          {notice}
        </p>
      ) : null}
      {liveChanges.length ? (
        <p className="soc-live-announcement" role="status" aria-live="polite">
          Cambió el estado de acceso de una persona
        </p>
      ) : null}
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      {loading && items.length === 0 ? (
        <p className="soc-page-note" role="status">
          Consultando sesiones…
        </p>
      ) : null}

      {!loading && !error && items.length === 0 ? (
        <EmptyState>No hay sesiones observadas en esta ventana.</EmptyState>
      ) : null}

      {items.length > 0 ? (
        <div className="soc-table-panel soc-admin-sessions__table">
          <div className="soc-table-scroll">
            <table className="soc-table">
              <thead>
                <tr>
                  <th scope="col">Persona</th>
                  <th scope="col">Rol</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Método</th>
                  <th scope="col">Última actividad</th>
                  <th scope="col">Inicio</th>
                  <th scope="col">Vencimiento</th>
                  <th scope="col">
                    <span className="soc-sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((entry) => {
                  const state = sessionState(entry);
                  const displayName = entry.displayName || 'Usuario sin nombre';
                  const isConfirming = confirmRef === entry.ref;
                  return (
                    <Fragment key={entry.ref}>
                      <tr
                        className={[
                          entry.current ? 'is-selected' : '',
                          liveChanges.some((change) => change.resource.id === entry.subjectId)
                            ? 'soc-live-change'
                            : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        <td>
                          <strong>{displayName}</strong>
                          {entry.email ? <small>{entry.email}</small> : null}
                          {entry.current ? <small>Esta sesión</small> : null}
                        </td>
                        <td>
                          {entry.roles.length > 0
                            ? entry.roles.map((role) => roleLabels[role] ?? role).join(', ')
                            : 'Sin rol'}
                        </td>
                        <td>
                          <StatusChip state={state.tone}>{state.label}</StatusChip>
                          {revocationReasonLabel(entry.revocationReason) ? (
                            <small>{revocationReasonLabel(entry.revocationReason)}</small>
                          ) : null}
                        </td>
                        <td title="Métodos informados por el proveedor de identidad">
                          {entry.amr.length > 0 ? entry.amr.join(', ') : 'No informado'}
                        </td>
                        <td>
                          <RelativeTime value={entry.lastSeenAt} />
                        </td>
                        <td>
                          <time dateTime={entry.createdAt}>{dateTime(entry.createdAt)}</time>
                        </td>
                        <td>
                          <time dateTime={entry.absoluteExpiresAt}>
                            {dateTime(entry.absoluteExpiresAt)}
                          </time>
                        </td>
                        <td className="soc-admin-sessions__action">
                          {entry.state === 'active' && !entry.current ? (
                            <Button
                              variant={isConfirming ? 'ghost' : 'danger'}
                              disabled={busyRef === entry.ref}
                              onClick={() => {
                                setConfirmRef(isConfirming ? null : entry.ref);
                                setReason('');
                                setError(null);
                              }}
                            >
                              {isConfirming ? 'Cancelar' : 'Revocar'}
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                      {isConfirming ? (
                        <tr className="soc-admin-sessions__confirm-row">
                          <td colSpan={8}>
                            <form
                              onSubmit={(event) => {
                                event.preventDefault();
                                void revoke(entry);
                              }}
                            >
                              <label htmlFor={`session-reason-${entry.ref}`}>
                                Motivo de revocación · 10–500 caracteres
                              </label>
                              <textarea
                                id={`session-reason-${entry.ref}`}
                                value={reason}
                                maxLength={500}
                                onChange={(event) => setReason(event.target.value)}
                                required
                                minLength={10}
                              />
                              <Button
                                variant="danger"
                                type="submit"
                                disabled={busyRef === entry.ref || reason.trim().length < 10}
                              >
                                {busyRef === entry.ref ? 'Revocando…' : 'Confirmar revocación'}
                              </Button>
                            </form>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <footer className="soc-table-footer">
            <span>
              {countLabel} · ventana de {windowDays} días
            </span>
            {nextCursor ? (
              <Button
                variant="secondary"
                disabled={refreshing}
                onClick={() => void load(true, nextCursor)}
              >
                {refreshing ? 'Cargando…' : 'Cargar siguientes'}
              </Button>
            ) : null}
          </footer>
        </div>
      ) : null}
    </div>
  );
}
