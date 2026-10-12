import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiErrorBody } from '@qapaq/contracts';
import {
  api,
  type SocAdminRole,
  type SocAdminSession,
  type SocAdminUser,
  type SocRoleRequestView,
} from '../../api/client.js';
import { Button, EmptyState, ErrorState, RelativeTime, StatusChip, SocIcon } from './soc-ui.js';
import { PageHeader, Panel } from './soc-data-ui.js';

const roleLabels: Readonly<Record<SocAdminRole, string>> = {
  'qapaq.soc.analyst': 'Analista SOC',
  'qapaq.soc.lead': 'Líder SOC',
  'qapaq.auditor': 'Auditor',
  'qapaq.platform.admin': 'Administrador de plataforma',
};
const roles = Object.keys(roleLabels) as SocAdminRole[];
type GrantFilter = 'all' | 'active' | 'none' | 'suspended';

function presenceLabel(
  user: SocAdminUser,
  thresholdMinutes: number,
): { label: string; state: 'ok' | 'warn' | 'neutral' } {
  if (user.presence === 'active_recently')
    return { label: `Activo hace <${thresholdMinutes} min`, state: 'ok' };
  if (user.presence === 'seen') return { label: 'Visto recientemente', state: 'warn' };
  if (user.presence === 'no_session') return { label: 'Sin sesión', state: 'neutral' };
  return { label: 'Estado no disponible', state: 'neutral' };
}

export function UserAdministrationPage({
  session,
}: {
  readonly session: {
    readonly subjectId: string;
    readonly capabilities: readonly string[];
  };
}): React.JSX.Element {
  const [users, setUsers] = useState<readonly SocAdminUser[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [lastDirectorySyncAt, setLastDirectorySyncAt] = useState<string | null>(null);
  const [presenceThresholdMinutes, setPresenceThresholdMinutes] = useState(5);
  const [syncStale, setSyncStale] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<GrantFilter>('all');
  const [selected, setSelected] = useState<SocAdminUser | null>(null);
  const [sessions, setSessions] = useState<readonly SocAdminSession[]>([]);
  const [sessionCursor, setSessionCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [requestError, setRequestError] = useState<ApiErrorBody | null>(null);
  const [updated, setUpdated] = useState<string | null>(null);
  const [role, setRole] = useState<SocAdminRole>('qapaq.soc.analyst');
  const [action, setAction] = useState<'grant' | 'revoke'>('grant');
  const [reason, setReason] = useState('');
  const [ticket, setTicket] = useState('');
  const [sensitiveReason, setSensitiveReason] = useState('');
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [roleRequests, setRoleRequests] = useState<readonly SocRoleRequestView[]>([]);
  const [roleRequestCursor, setRoleRequestCursor] = useState<string | null>(null);
  const [decisionReasons, setDecisionReasons] = useState<Readonly<Record<string, string>>>({});
  const [decisionBusyId, setDecisionBusyId] = useState<string | null>(null);
  const directoryRequest = useRef(0);
  const selectedOid = useRef<string | null>(null);
  const canRequestRole = session.capabilities.includes('roles.request');
  const canReadSessions = session.capabilities.includes('sessions.read');
  const canRevokeSessions = session.capabilities.includes('sessions.revoke');
  const canSuspendUsers = session.capabilities.includes('users.suspend');
  const canApproveAccessRoles = session.capabilities.includes('roles.approve');
  const canApprovePrivilegedRoles = session.capabilities.includes('roles.approve.privileged');
  const canApproveRoles = canApproveAccessRoles || canApprovePrivilegedRoles;
  const selectedRoles = useMemo(() => new Set(selected?.roles ?? []), [selected]);
  const selectableRoles =
    action === 'revoke' ? roles.filter((entry) => selectedRoles.has(entry)) : roles;
  const selectedRole = selectableRoles.includes(role) ? role : (selectableRoles[0] ?? role);

  const load = useCallback(
    async (append = false, pageCursor?: string) => {
      const requestId = ++directoryRequest.current;
      setLoading(true);
      const result = await api.adminUsers({
        q: search,
        status: filter,
        ...(pageCursor ? { cursor: pageCursor } : {}),
      });
      if (requestId !== directoryRequest.current) return;
      if (!result.ok) {
        setError(result.error);
        setLoading(false);
        return;
      }
      setUsers((current) => (append ? [...current, ...result.data.items] : result.data.items));
      setNextCursor(result.data.nextCursor);
      setLastDirectorySyncAt(result.data.lastDirectorySyncAt);
      setPresenceThresholdMinutes(Math.max(1, result.data.presenceThresholdMinutes));
      setSyncStale(result.data.syncStale);
      setUpdated(new Date().toISOString());
      setError(null);
      setLoading(false);
      if (!append) {
        selectedOid.current = null;
        setSelected(null);
        setSessions([]);
        setSessionCursor(null);
      }
    },
    [filter, search],
  );

  const loadRoleRequests = useCallback(async (cursor?: string, append = false) => {
    const result = await api.adminRoleRequests(cursor);
    if (!result.ok) {
      setRequestError(result.error);
      return;
    }
    setRoleRequests((current) => (append ? [...current, ...result.data.items] : result.data.items));
    setRoleRequestCursor(result.data.nextCursor);
    setRequestError(null);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (canApproveRoles) void loadRoleRequests();
  }, [canApproveRoles, loadRoleRequests]);

  async function selectUser(user: SocAdminUser): Promise<void> {
    selectedOid.current = user.oid;
    setSelected(user);
    setSessions([]);
    setSessionCursor(null);
    setReceipt(null);
    setSensitiveReason('');
    setConfirmAction(null);
    setRequestError(null);
    setSessionsLoading(false);
    if (!canReadSessions) return;
    setSessionsLoading(true);
    const result = await api.adminUserSessions(user.oid);
    if (selectedOid.current !== user.oid) return;
    if (!result.ok) setRequestError(result.error);
    else {
      setSessions(result.data.items);
      setSessionCursor(result.data.nextCursor);
    }
    setSessionsLoading(false);
  }

  async function requestChange(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (
      !selected ||
      !canRequestRole ||
      (action === 'grant' && syncStale) ||
      selected.oid === session.subjectId ||
      (action === 'grant' && (selected.membership !== 'member' || !selected.accountEnabled)) ||
      (action === 'revoke' && !selectedRoles.has(selectedRole))
    )
      return;
    setSubmitting(true);
    setRequestError(null);
    setReceipt(null);
    const result = await api.requestRoleChange(selected.oid, {
      action,
      role: selectedRole,
      reason: reason.trim(),
      ...(ticket.trim() ? { ticket: ticket.trim() } : {}),
      expectedRevision: selected.revision,
    });
    if (!result.ok) setRequestError(result.error);
    else {
      setReceipt(
        `Solicitud ${result.data.requestId} · pendiente de aprobación independiente. El acceso aún no cambia.`,
      );
      setReason('');
      setTicket('');
    }
    setSubmitting(false);
  }

  async function loadMoreSessions(): Promise<void> {
    if (!selected || !sessionCursor) return;
    setSessionsLoading(true);
    const result = await api.adminUserSessions(selected.oid, sessionCursor);
    if (selectedOid.current !== selected.oid) return;
    if (!result.ok) setRequestError(result.error);
    else {
      setSessions((current) => [...current, ...result.data.items]);
      setSessionCursor(result.data.nextCursor);
    }
    setSessionsLoading(false);
  }

  async function revokeSession(entry: SocAdminSession): Promise<void> {
    if (!selected || !canRevokeSessions || entry.revokedAt) return;
    if (confirmAction !== entry.id) {
      setConfirmAction(entry.id);
      return;
    }
    if (sensitiveReason.trim().length < 12) return;
    setSessionsLoading(true);
    const result = await api.revokeAdminSession(selected.oid, entry.id, sensitiveReason.trim());
    if (!result.ok) setRequestError(result.error);
    else {
      setSessions((current) =>
        current.map((value) => (value.id === entry.id ? result.data.session : value)),
      );
      setReceipt(`Sesión revocada · ${result.data.correlationId}`);
      setSensitiveReason('');
      setConfirmAction(null);
    }
    setSessionsLoading(false);
  }

  async function changeUserAccess(): Promise<void> {
    if (!selected || !canSuspendUsers || selected.oid === session.subjectId) return;
    const suspend = selected.grantStatus !== 'suspended';
    const actionKey = suspend ? 'suspend-user' : 'restore-user';
    if (confirmAction !== actionKey) {
      setConfirmAction(actionKey);
      return;
    }
    if (sensitiveReason.trim().length < 12) return;
    setSubmitting(true);
    const result = await api.setAdminUserSuspended(
      selected.oid,
      suspend,
      sensitiveReason.trim(),
      selected.revision,
    );
    if (!result.ok) setRequestError(result.error);
    else {
      setSelected(result.data.user);
      setUsers((current) =>
        current.map((user) => (user.oid === selected.oid ? result.data.user : user)),
      );
      setSessions((current) =>
        suspend
          ? current.map((entry) => ({
              ...entry,
              revokedAt: entry.revokedAt ?? new Date().toISOString(),
            }))
          : current,
      );
      setReceipt(
        `${suspend ? 'Acceso QAPAQ suspendido' : 'Acceso QAPAQ restablecido'} · ${result.data.correlationId}`,
      );
      setSensitiveReason('');
      setConfirmAction(null);
    }
    setSubmitting(false);
  }

  async function decideRoleRequest(
    request: SocRoleRequestView,
    decision: 'approve' | 'reject',
  ): Promise<void> {
    const decisionReason = decisionReasons[request.id]?.trim() ?? '';
    const hasStageCapability =
      request.approvalStage === 'security' ? canApprovePrivilegedRoles : canApproveAccessRoles;
    if (
      !hasStageCapability ||
      request.requesterOid === session.subjectId ||
      request.targetOid === session.subjectId ||
      request.priorApproverOid === session.subjectId ||
      decisionReason.length < 12
    )
      return;
    setDecisionBusyId(request.id);
    const result = await api.decideAdminRoleRequest(
      request.id,
      decision,
      decisionReason,
      request.revision,
    );
    if (!result.ok) setRequestError(result.error);
    else {
      setRoleRequests((current) => current.filter((entry) => entry.id !== request.id));
      setDecisionReasons((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });
      setReceipt(
        `Solicitud ${request.id} ${decision === 'approve' ? 'aprobada' : 'rechazada'} · ${result.data.correlationId}`,
      );
    }
    setDecisionBusyId(null);
  }

  return (
    <div className="soc-page soc-user-admin">
      <PageHeader
        title="Usuarios y acceso"
        description="Miembros del grupo de admisión QAPAQ-SecOps-Users en Microsoft Entra."
        updated={updated}
        action={
          <Button onClick={() => void load()} disabled={loading}>
            <SocIcon name="refresh" /> Actualizar
          </Button>
        }
      />
      <div className="soc-operation-strip" role="status">
        <div>
          <StatusChip state={syncStale ? 'warn' : lastDirectorySyncAt ? 'ok' : 'neutral'}>
            {syncStale
              ? 'Directorio desactualizado'
              : lastDirectorySyncAt
                ? 'Directorio sincronizado'
                : 'Sin sincronización'}
          </StatusChip>
        </div>
        <div>
          <span>Última sincronización</span>
          <span>
            <RelativeTime value={lastDirectorySyncAt} />
          </span>
        </div>
        <div>
          <span>Actividad</span>
          <span>Sesiones de QAPAQ; no presencia en Teams</span>
        </div>
      </div>
      {syncStale ? (
        <p className="soc-page-note" role="status">
          La membresía está desactualizada. Las asignaciones y elevaciones de rol quedan bloqueadas
          hasta recuperar una sincronización confiable.
        </p>
      ) : null}
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      {requestError ? (
        <ErrorState
          error={requestError}
          onRetry={() => {
            setRequestError(null);
            if (canApproveRoles) void loadRoleRequests();
            if (selected) void selectUser(selected);
          }}
        />
      ) : null}
      {canApproveRoles ? (
        <Panel
          title="Aprobaciones de acceso"
          action={
            <Button onClick={() => void loadRoleRequests()} disabled={decisionBusyId !== null}>
              <SocIcon name="refresh" /> Actualizar
            </Button>
          }
        >
          <p className="soc-page-note">
            Quien solicitó el cambio y la persona objetivo no pueden aprobar ni rechazar la
            solicitud.
          </p>
          {roleRequests.length ? (
            <div className="soc-table-scroll">
              <table className="soc-table">
                <thead>
                  <tr>
                    <th>Solicitud</th>
                    <th>Objetivo</th>
                    <th>Razón</th>
                    <th>Resolución</th>
                  </tr>
                </thead>
                <tbody>
                  {roleRequests.map((request) => (
                    <tr key={request.id}>
                      <td>
                        <strong>
                          {request.action === 'grant' ? 'Asignar' : 'Retirar'} ·{' '}
                          {roleLabels[request.role]}
                        </strong>
                        <small>
                          {request.requester} · <RelativeTime value={request.submittedAt} />
                        </small>
                        {request.ticket ? <small>{request.ticket}</small> : null}
                      </td>
                      <td>
                        {request.targetDisplayName}
                        <small>{request.targetUpn}</small>
                      </td>
                      <td>{request.reason}</td>
                      <td>
                        <label className="soc-user-admin__decision-reason">
                          <span>Motivo de decisión</span>
                          <textarea
                            value={decisionReasons[request.id] ?? ''}
                            onChange={(event) =>
                              setDecisionReasons((current) => ({
                                ...current,
                                [request.id]: event.currentTarget.value,
                              }))
                            }
                            minLength={12}
                            maxLength={500}
                          />
                        </label>
                        <div className="soc-user-admin__decision-actions">
                          <Button
                            onClick={() => void decideRoleRequest(request, 'approve')}
                            disabled={
                              decisionBusyId === request.id ||
                              request.requesterOid === session.subjectId ||
                              request.priorApproverOid === session.subjectId ||
                              request.targetOid === session.subjectId ||
                              (request.approvalStage === 'security' &&
                                !canApprovePrivilegedRoles) ||
                              (request.approvalStage === 'access' && !canApproveAccessRoles) ||
                              (decisionReasons[request.id]?.trim().length ?? 0) < 12
                            }
                          >
                            {decisionBusyId === request.id
                              ? 'Guardando…'
                              : request.approvalStage === 'security'
                                ? 'Aprobar etapa de Seguridad'
                                : 'Aprobar etapa de Acceso'}
                          </Button>
                          <Button
                            variant="danger"
                            onClick={() => void decideRoleRequest(request, 'reject')}
                            disabled={
                              decisionBusyId === request.id ||
                              request.requesterOid === session.subjectId ||
                              request.priorApproverOid === session.subjectId ||
                              request.targetOid === session.subjectId ||
                              (request.approvalStage === 'security' &&
                                !canApprovePrivilegedRoles) ||
                              (request.approvalStage === 'access' && !canApproveAccessRoles) ||
                              (decisionReasons[request.id]?.trim().length ?? 0) < 12
                            }
                          >
                            Rechazar
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>No hay solicitudes de acceso pendientes.</EmptyState>
          )}
          {roleRequestCursor ? (
            <div className="soc-table-footer">
              <Button onClick={() => void loadRoleRequests(roleRequestCursor, true)}>
                Cargar más solicitudes
              </Button>
            </div>
          ) : null}
        </Panel>
      ) : null}

      <div className="soc-user-admin__toolbar">
        <label className="soc-user-admin__search">
          <span>Buscar miembro</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Nombre o UPN"
            autoComplete="off"
          />
        </label>
        <label className="soc-user-admin__filter">
          <span>Acceso QAPAQ</span>
          <select
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value as GrantFilter)}
          >
            <option value="all">Todos</option>
            <option value="active">Con acceso</option>
            <option value="none">Sin acceso asignado</option>
            <option value="suspended">Suspendido</option>
          </select>
        </label>
        <span className="soc-user-admin__scope">
          Solo grupo de admisión · {users.length} en página
        </span>
      </div>

      <div className="soc-user-admin__layout">
        <section className="soc-table-panel" aria-label="Miembros del grupo SOC">
          <div className="soc-table-scroll">
            <table className="soc-table">
              <thead>
                <tr>
                  <th>Persona</th>
                  <th>Rol QAPAQ</th>
                  <th>Sesión</th>
                  <th>Última actividad</th>
                  <th>Entra</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const presence = presenceLabel(user, presenceThresholdMinutes);
                  return (
                    <tr key={user.oid} className={selected?.oid === user.oid ? 'is-selected' : ''}>
                      <td>
                        <button
                          type="button"
                          className="soc-user-admin__person"
                          onClick={() => void selectUser(user)}
                        >
                          <strong>{user.displayName}</strong>
                          <span>{user.upn}</span>
                        </button>
                      </td>
                      <td>
                        {user.roles.length ? (
                          user.roles.map((entry) => (
                            <span className="soc-user-admin__role" key={entry}>
                              {roleLabels[entry]}
                            </span>
                          ))
                        ) : (
                          <span className="soc-muted">Sin acceso asignado</span>
                        )}
                      </td>
                      <td>
                        <StatusChip state={presence.state}>{presence.label}</StatusChip>
                        {user.activeSessions > 0 ? (
                          <small className="soc-user-admin__session-count">
                            {user.activeSessions} sesión{user.activeSessions === 1 ? '' : 'es'}
                          </small>
                        ) : null}
                      </td>
                      <td>
                        <RelativeTime value={user.lastSeenAt} />
                      </td>
                      <td>
                        <StatusChip
                          state={
                            user.accountEnabled && user.membership === 'member' ? 'ok' : 'warn'
                          }
                        >
                          {user.membership === 'pending_removal'
                            ? 'Salida pendiente'
                            : user.accountEnabled
                              ? 'Habilitada'
                              : 'Deshabilitada'}
                        </StatusChip>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!loading && users.length === 0 && !error ? (
            <EmptyState>No hay miembros con estos filtros en el grupo de admisión.</EmptyState>
          ) : null}
          {loading && users.length === 0 ? (
            <p className="soc-table-placeholder" role="status">
              Consultando directorio…
            </p>
          ) : null}
          {nextCursor ? (
            <div className="soc-table-footer">
              <Button onClick={() => void load(true, nextCursor)} disabled={loading}>
                Cargar más miembros
              </Button>
              <span>{users.length} cargados</span>
            </div>
          ) : null}
        </section>

        {selected ? (
          <aside
            className="soc-panel soc-user-admin__detail"
            aria-label={`Detalle de ${selected.displayName}`}
          >
            <header className="soc-panel__header">
              <h2>{selected.displayName}</h2>
              <span>{selected.upn}</span>
            </header>
            <div className="soc-user-admin__detail-body">
              {canSuspendUsers ? (
                <Button
                  variant={selected.grantStatus === 'suspended' ? 'secondary' : 'danger'}
                  onClick={() => void changeUserAccess()}
                  disabled={
                    submitting ||
                    selected.oid === session.subjectId ||
                    (sensitiveReason.trim().length < 12 &&
                      confirmAction ===
                        (selected.grantStatus === 'suspended' ? 'restore-user' : 'suspend-user'))
                  }
                >
                  {confirmAction ===
                  (selected.grantStatus === 'suspended' ? 'restore-user' : 'suspend-user')
                    ? `Confirmar ${selected.grantStatus === 'suspended' ? 'restablecimiento' : 'suspensión'}`
                    : selected.grantStatus === 'suspended'
                      ? 'Restablecer acceso QAPAQ'
                      : 'Suspender acceso QAPAQ'}
                </Button>
              ) : null}
              <dl className="soc-user-admin__facts">
                <div>
                  <dt>Último acceso a QAPAQ</dt>
                  <dd>
                    <RelativeTime value={selected.lastSignInAt} />
                  </dd>
                </div>
                <div>
                  <dt>Última actividad</dt>
                  <dd>
                    <RelativeTime value={selected.lastSeenAt} />
                  </dd>
                </div>
                <div>
                  <dt>Estado del grant</dt>
                  <dd>
                    {selected.grantStatus === 'none'
                      ? 'Sin acceso asignado'
                      : selected.grantStatus === 'suspended'
                        ? 'Suspendido en QAPAQ'
                        : 'Activo'}
                  </dd>
                </div>
                <div>
                  <dt>Capability efectivas</dt>
                  <dd>
                    {selected.capabilities.length ? selected.capabilities.join(', ') : 'Ninguna'}
                  </dd>
                </div>
              </dl>

              {canReadSessions ? (
                <section className="soc-user-admin__sessions">
                  <h3>Sesiones QAPAQ</h3>
                  {sessionsLoading && sessions.length === 0 ? (
                    <p role="status">Consultando sesiones…</p>
                  ) : null}
                  {sessions.length ? (
                    <ul>
                      {sessions.map((entry) => (
                        <li key={entry.id}>
                          <span>
                            <strong>{entry.revokedAt ? 'Revocada' : 'Sesión'}</strong>
                            <small>{entry.amr.join(' · ') || 'Método MFA no informado'}</small>
                            {canRevokeSessions && !entry.revokedAt ? (
                              <Button
                                onClick={() => void revokeSession(entry)}
                                disabled={
                                  sessionsLoading ||
                                  (confirmAction === entry.id && sensitiveReason.trim().length < 12)
                                }
                              >
                                {confirmAction === entry.id
                                  ? 'Confirmar revocación'
                                  : 'Revocar sesión'}
                              </Button>
                            ) : null}
                          </span>
                          <span>
                            Inicio <RelativeTime value={entry.startedAt} />
                            <small>
                              Último uso <RelativeTime value={entry.lastSeenAt} />
                            </small>
                            <small>
                              Expira <RelativeTime value={entry.expiresAt} />
                            </small>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : !sessionsLoading && !requestError ? (
                    <p className="soc-muted">No hay sesiones recientes.</p>
                  ) : null}
                  {sessionCursor ? (
                    <Button onClick={() => void loadMoreSessions()} disabled={sessionsLoading}>
                      Cargar más sesiones
                    </Button>
                  ) : null}
                </section>
              ) : null}

              {canRequestRole ? (
                <section className="soc-user-admin__role-request">
                  <h3>Solicitar cambio de rol</h3>
                  {selected.oid === session.subjectId ? (
                    <p className="soc-page-note">
                      No puedes cambiar tu propio acceso. Solicita el cambio a otro administrador.
                    </p>
                  ) : null}
                  <form onSubmit={(event) => void requestChange(event)}>
                    <label>
                      Operación
                      <select
                        value={action}
                        onChange={(event) =>
                          setAction(event.currentTarget.value as 'grant' | 'revoke')
                        }
                      >
                        <option value="grant">Asignar rol</option>
                        <option value="revoke">Retirar rol</option>
                      </select>
                    </label>
                    <label>
                      Rol
                      <select
                        value={selectedRole}
                        onChange={(event) => setRole(event.currentTarget.value as SocAdminRole)}
                      >
                        {selectableRoles.length ? (
                          selectableRoles.map((entry) => (
                            <option key={entry} value={entry}>
                              {roleLabels[entry]}
                            </option>
                          ))
                        ) : (
                          <option value={selectedRole}>Sin rol asignado</option>
                        )}
                      </select>
                    </label>
                    <label>
                      Motivo del cambio
                      <textarea
                        value={reason}
                        onChange={(event) => setReason(event.currentTarget.value)}
                        minLength={12}
                        maxLength={500}
                        required
                        placeholder="Describe la necesidad del cambio"
                      />
                    </label>
                    <label>
                      Ticket (opcional)
                      <input
                        value={ticket}
                        onChange={(event) => setTicket(event.currentTarget.value)}
                        maxLength={80}
                        placeholder="Ej. INC-4821"
                      />
                    </label>
                    <Button
                      variant="primary"
                      type="submit"
                      disabled={
                        submitting ||
                        selected.oid === session.subjectId ||
                        (action === 'grant' &&
                          (syncStale ||
                            selected.membership !== 'member' ||
                            !selected.accountEnabled)) ||
                        (action === 'revoke' && selectableRoles.length === 0) ||
                        reason.trim().length < 12
                      }
                    >
                      {submitting ? 'Enviando solicitud…' : 'Enviar a aprobación'}
                    </Button>
                  </form>
                </section>
              ) : null}
              {canRevokeSessions || canSuspendUsers ? (
                <label className="soc-user-admin__reason">
                  Motivo de acción sensible
                  <textarea
                    value={sensitiveReason}
                    onChange={(event) => setSensitiveReason(event.currentTarget.value)}
                    minLength={12}
                    maxLength={500}
                    placeholder="Mínimo 12 caracteres; quedará en auditoría"
                  />
                </label>
              ) : null}
              {receipt ? (
                <p className="soc-page-note" role="status">
                  {receipt}
                </p>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>
      <p className="soc-page-note">
        La lista proviene exclusivamente del grupo Entra configurado. “Activo hace menos de{' '}
        {presenceThresholdMinutes} min” es actividad reciente de una sesión QAPAQ y no prueba
        presencia en pantalla. QAPAQ no cambia membresía ni estado de cuenta de Microsoft.
      </p>
    </div>
  );
}
