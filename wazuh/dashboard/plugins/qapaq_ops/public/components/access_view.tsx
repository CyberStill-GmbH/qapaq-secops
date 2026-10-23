/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import {
  EuiBadge,
  EuiBasicTable,
  EuiBasicTableColumn,
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiDescriptionList,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutHeader,
  EuiFormRow,
  EuiLoadingContent,
  EuiModal,
  EuiModalBody,
  EuiModalFooter,
  EuiModalHeader,
  EuiModalHeaderTitle,
  EuiSpacer,
  EuiSelect,
  EuiTab,
  EuiTabs,
  EuiTextArea,
  EuiTitle,
} from '@elastic/eui';
import {
  AdminSession,
  CAPABILITIES,
  DirectorySync,
  DirectoryUser,
  DirectoryUserDetail,
  Page,
  RequestableRole,
  ROLE_LABEL,
  RoleGrantView,
  RoleRequestAction,
  RoleRequestListResponse,
  RoleRequestView,
  SESSION_STATE_LABEL,
  ROLE_ORIGIN_LABEL,
  userState,
} from '../../common';
import { QapaqPage, useChanges, useConsole } from './console_context';
import { EmptyLine, ErrorCallout, HealthMark, Mono, Timestamp, useAsync } from './primitives';

const REASON_MIN = 10;
const REASON_MAX = 500;

function Roles({ roles }: { roles: readonly string[] }) {
  if (roles.length === 0) return <span className="qapaqMuted">Sin rol</span>;
  return (
    <span className="qapaqIdList">
      {roles.map((role) => (
        <EuiBadge key={role} color="hollow">
          {ROLE_LABEL[role] ?? role}
        </EuiBadge>
      ))}
    </span>
  );
}

export function AccessView() {
  const { can } = useConsole();
  const canUsers = can(CAPABILITIES.usersRead);
  const canSessions = can(CAPABILITIES.sessionsRead);
  const canRoleRequests = can(CAPABILITIES.rolesRequest);
  const canReviewRoles = can(CAPABILITIES.rolesApprove) || can(CAPABILITIES.rolesApprovePrivileged);
  const [tab, setTab] = useState<'users' | 'sessions' | 'role-requests'>(
    canUsers ? 'users' : canSessions ? 'sessions' : 'role-requests',
  );

  return (
    <QapaqPage
      title="Usuarios y sesiones"
      description="Admisión por Microsoft Entra ID y el grupo Accesos_SOC. Salir del grupo revoca las sesiones abiertas."
    >
      {!canUsers && !canSessions && !canRoleRequests && !canReviewRoles ? (
        <EmptyLine>Tu rol no incluye la administración de accesos.</EmptyLine>
      ) : (
        <>
          <EuiTabs size="s" className="qapaqTabs">
            {canUsers && (
              <EuiTab isSelected={tab === 'users'} onClick={() => setTab('users')}>
                Miembros
              </EuiTab>
            )}
            {canSessions && (
              <EuiTab isSelected={tab === 'sessions'} onClick={() => setTab('sessions')}>
                Sesiones
              </EuiTab>
            )}
            {(canRoleRequests || canReviewRoles) && (
              <EuiTab isSelected={tab === 'role-requests'} onClick={() => setTab('role-requests')}>
                Solicitudes de rol
              </EuiTab>
            )}
          </EuiTabs>
          <EuiSpacer size="m" />
          {tab === 'users' && canUsers && <UsersPanel />}
          {tab === 'sessions' && canSessions && <SessionsPanel />}
          {tab === 'role-requests' && (canRoleRequests || canReviewRoles) && (
            <RoleRequestsPanel canReviewRoles={canReviewRoles} />
          )}
        </>
      )}
    </QapaqPage>
  );
}

function UsersPanel() {
  const { api } = useConsole();
  const users = useAsync(
    () =>
      api.get<{ sync: DirectorySync; items: DirectoryUser[]; totalCount: number }>('/admin/users'),
    [api],
  );
  const [selected, setSelected] = useState<string | null>(null);
  useChanges(['session'], () => users.reload(), 1000);
  if (users.error) return <ErrorCallout error={users.error} onRetry={users.reload} />;

  const columns: Array<EuiBasicTableColumn<DirectoryUser>> = [
    {
      field: 'displayName',
      name: 'Persona',
      truncateText: false,
      render: (value: string | null, user: DirectoryUser) => (
        <span className="qapaqCellTitle" data-qapaq-no-translate="">
          <span>{value ?? 'Sin nombre'}</span>
          <span className="qapaqCellMeta">{user.upn ?? user.oid}</span>
        </span>
      ),
      mobileOptions: { header: false },
    },
    {
      name: 'Estado',
      render: (user: DirectoryUser) => {
        const state = userState(user);
        return <HealthMark tone={state.tone} label={state.label} />;
      },
    },
    {
      field: 'membership',
      name: 'Accesos_SOC',
      render: (value: DirectoryUser['membership'], user: DirectoryUser) =>
        value === 'member' ? (
          user.isOwner ? (
            'Propietario'
          ) : (
            'Miembro'
          )
        ) : value === 'removed' ? (
          'Retirado'
        ) : user.isOwner ? (
          'Propietario'
        ) : (
          <span className="qapaqMuted">Sin dato</span>
        ),
    },
    {
      field: 'roles',
      name: 'Rol y origen',
      render: (roles: string[], user: DirectoryUser) => (
        <span className="qapaqCellTitle">
          <Roles roles={roles} />
          <span className="qapaqCellMeta">
            {ROLE_ORIGIN_LABEL[user.roleOrigin] ?? user.roleOrigin}
          </span>
        </span>
      ),
    },
    {
      field: 'activeSessions',
      name: 'Sesiones activas',
      align: 'right',
      render: (value: number) => <span className="qapaqTabular">{value}</span>,
    },
    {
      field: 'lastSeenAt',
      name: 'Última actividad',
      render: (value: string | null) => <Timestamp iso={value} />,
    },
  ];

  const sync = users.data?.sync;
  return (
    <>
      {sync && sync.mode !== 'graph' && (
        <>
          <EuiCallOut
            size="s"
            color="primary"
            iconType="iInCircle"
            title="Sin sincronización con Microsoft Graph."
          >
            <p>
              Solo se listan los dueños del grupo y las asignaciones del despliegue; no hay datos de
              cuenta ni de pertenencia.
            </p>
          </EuiCallOut>
          <EuiSpacer size="m" />
        </>
      )}
      {sync && sync.mode === 'graph' && (sync.status !== 'ok' || sync.stale) && (
        <>
          <EuiCallOut
            size="s"
            color="warning"
            iconType="alert"
            title={
              sync.status === 'never'
                ? 'El directorio todavía no se ha sincronizado con Entra ID.'
                : sync.status === 'failed'
                  ? `La última sincronización con Entra ID falló${sync.lastErrorClass ? ` (${sync.lastErrorClass})` : ''}.`
                  : 'La sincronización con Entra ID está desactualizada.'
            }
          >
            <p>
              Última correcta: <Timestamp iso={sync.lastSuccessAt} />
            </p>
          </EuiCallOut>
          <EuiSpacer size="m" />
        </>
      )}
      <EuiBasicTable<DirectoryUser>
        items={users.data?.items ?? []}
        columns={columns}
        loading={users.loading}
        responsive
        tableLayout="auto"
        rowProps={(user: DirectoryUser) => ({
          onClick: () => setSelected(user.oid),
          className: 'qapaqRow',
        })}
        noItemsMessage={
          users.loading ? 'Cargando miembros…' : 'El grupo no tiene miembros sincronizados.'
        }
      />
      {selected && <UserFlyout oid={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

/** Detalle de una persona (`GET /api/admin/users/:oid`): estado, rol y sus sesiones de 7 días. */
function UserFlyout({ oid, onClose }: { oid: string; onClose: () => void }) {
  const { api, can } = useConsole();
  const canRequestRole = can(CAPABILITIES.rolesRequest);
  const detail = useAsync(
    () => api.get<DirectoryUserDetail>(`/admin/users/${encodeURIComponent(oid)}`),
    [api, oid],
  );
  const user = detail.data?.user;
  const state = user ? userState(user) : null;
  const [requestingRole, setRequestingRole] = useState(false);
  return (
    <EuiFlyout onClose={onClose} size="m" className="qapaqFlyout" aria-labelledby="qapaqUserTitle">
      <EuiFlyoutHeader hasBorder>
        <EuiTitle size="s">
          <h2 id="qapaqUserTitle" data-qapaq-no-translate="">
            {user?.displayName ?? user?.upn ?? 'Persona'}
          </h2>
        </EuiTitle>
        {state && (
          <>
            <EuiSpacer size="xs" />
            <HealthMark tone={state.tone} label={state.label} />
          </>
        )}
      </EuiFlyoutHeader>
      <EuiFlyoutBody>
        {detail.error != null && <ErrorCallout error={detail.error} onRetry={detail.reload} />}
        {user && detail.data && (
          <>
            <EuiDescriptionList
              type="responsiveColumn"
              compressed
              className="qapaqFacts"
              listItems={[
                {
                  title: 'Cuenta (UPN)',
                  description: user.upn ? <Mono>{user.upn}</Mono> : 'Sin dato',
                },
                { title: 'Object ID', description: <Mono>{user.oid}</Mono> },
                {
                  title: 'Cuenta en Entra',
                  description:
                    user.accountEnabled === null
                      ? 'Sin dato'
                      : user.accountEnabled
                        ? 'Habilitada'
                        : 'Deshabilitada',
                },
                {
                  title: 'Accesos_SOC',
                  description:
                    user.membership === 'member'
                      ? 'Miembro'
                      : user.membership === 'removed'
                        ? 'Retirado'
                        : 'Sin dato',
                },
                { title: 'Roles', description: <Roles roles={user.roles} /> },
                {
                  title: 'Origen del rol',
                  description: ROLE_ORIGIN_LABEL[user.roleOrigin] ?? user.roleOrigin,
                },
              ]}
            />
            {canRequestRole && (
              <>
                <EuiSpacer size="m" />
                <EuiButton
                  size="s"
                  iconType="pencil"
                  isDisabled={user.membership !== 'member' || user.accountEnabled !== true}
                  onClick={() => setRequestingRole(true)}
                >
                  Solicitar cambio de rol
                </EuiButton>
                {user.membership !== 'member' && (
                  <p className="qapaqCellMeta">
                    Solo se pueden solicitar roles para miembros vigentes de Accesos_SOC.
                  </p>
                )}
              </>
            )}
            <EuiSpacer size="l" />
            <EuiTitle size="xxs">
              <h3>Sesiones (últimos 7 días)</h3>
            </EuiTitle>
            <EuiSpacer size="s" />
            {detail.data.sessions.length === 0 ? (
              <EmptyLine>Sin sesiones en la ventana.</EmptyLine>
            ) : (
              <ol className="qapaqTimeline">
                {detail.data.sessions.map((item) => (
                  <li key={item.ref} className="qapaqTimeline__item">
                    <span className="qapaqTimeline__time">
                      <Timestamp iso={item.lastSeenAt} />
                    </span>
                    <span className="qapaqTimeline__body">
                      <span>
                        {SESSION_STATE_LABEL[item.state]}
                        {item.current ? ' · esta sesión' : ''}
                      </span>
                      <span className="qapaqCellMeta">
                        {item.amr.join(' + ') || 'sin método'}
                        {item.revocationReason ? ` · ${item.revocationReason}` : ''}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </EuiFlyoutBody>
      {requestingRole && user && (
        <RoleChangeModal
          user={user}
          onClose={() => setRequestingRole(false)}
          onSubmitted={() => {
            setRequestingRole(false);
            detail.reload();
          }}
        />
      )}
    </EuiFlyout>
  );
}

const ROLE_REQUEST_STATUS_LABEL: Record<RoleRequestView['status'], string> = {
  pending_access: 'Pendiente de Acceso',
  pending_security: 'Pendiente de Seguridad',
  approved: 'Aprobada',
  rejected: 'Rechazada',
  cancelled: 'Cancelada',
};

const ROLE_REQUEST_ACTION_LABEL: Record<RoleRequestAction, string> = {
  grant: 'Conceder',
  revoke: 'Retirar',
};

function RoleRequestsPanel({ canReviewRoles }: { canReviewRoles: boolean }) {
  const { api, can } = useConsole();
  const requests = useAsync(() => api.get<RoleRequestListResponse>('/admin/role-requests'), [api]);
  const [selected, setSelected] = useState<RoleRequestView | null>(null);
  const [items, setItems] = useState<readonly RoleRequestView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const canRequest = can(CAPABILITIES.rolesRequest);
  const canApproveAccess = can(CAPABILITIES.rolesApprove);
  const canApproveSecurity = can(CAPABILITIES.rolesApprovePrivileged);

  useEffect(() => {
    if (requests.data) {
      setItems(requests.data.items);
      setCursor(requests.data.nextCursor);
    }
  }, [requests.data]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await api.get<RoleRequestListResponse>('/admin/role-requests', { cursor });
      setItems((current) => [...current, ...next.items]);
      setCursor(next.nextCursor);
    } catch (error) {
      setMoreError(error);
    } finally {
      setLoadingMore(false);
    }
  };

  if (requests.error) return <ErrorCallout error={requests.error} onRetry={requests.reload} />;

  const columns: Array<EuiBasicTableColumn<RoleRequestView>> = [
    {
      field: 'createdAt',
      name: 'Creada',
      render: (value: string) => <Timestamp iso={value} />,
    },
    {
      name: 'Cambio solicitado',
      render: (request: RoleRequestView) => (
        <span className="qapaqCellTitle">
          <span>
            {ROLE_REQUEST_ACTION_LABEL[request.action]} · {ROLE_LABEL[request.role] ?? request.role}
          </span>
          <span className="qapaqCellMeta">
            Solicita <Mono>{request.requesterOid}</Mono> · objetivo <Mono>{request.targetOid}</Mono>
            {request.ticket ? ` · ${request.ticket}` : ''}
          </span>
        </span>
      ),
    },
    {
      field: 'approvalStage',
      name: 'Etapa',
      render: (stage: RoleRequestView['approvalStage']) =>
        stage === 'security'
          ? 'Seguridad · step-up requerido'
          : stage === 'access'
            ? 'Acceso'
            : '—',
    },
    {
      field: 'status',
      name: 'Estado',
      render: (status: RoleRequestView['status']) => (
        <EuiBadge color={status.startsWith('pending') ? 'warning' : 'hollow'}>
          {ROLE_REQUEST_STATUS_LABEL[status]}
        </EuiBadge>
      ),
    },
    {
      name: 'Acciones',
      width: '130px',
      render: (request: RoleRequestView) => {
        const stageCapability =
          request.approvalStage === 'access'
            ? canApproveAccess
            : request.approvalStage === 'security'
              ? canApproveSecurity
              : false;
        if (!stageCapability || request.approvalStage === null) return null;
        return (
          <EuiButtonEmpty size="xs" onClick={() => setSelected(request)}>
            Revisar
          </EuiButtonEmpty>
        );
      },
    },
  ];

  return (
    <>
      <EuiFlexGroup alignItems="center" justifyContent="spaceBetween" responsive wrap>
        <EuiFlexItem grow>
          <p>
            Los cambios requieren aprobación separada y quedan registrados en auditoría. La UI no
            concede roles directamente.
          </p>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButtonEmpty size="s" iconType="refresh" onClick={requests.reload}>
            Actualizar
          </EuiButtonEmpty>
        </EuiFlexItem>
      </EuiFlexGroup>
      {canReviewRoles && (
        <>
          <EuiCallOut
            size="s"
            color="warning"
            iconType="alert"
            title="El rol Administrador de plataforma requiere step-up reciente."
          >
            <p>
              La sesión actual no aporta evidencia de reautenticación reciente. La aprobación de esa
              segunda etapa seguirá fallando de forma segura hasta que el login la proporcione.
            </p>
          </EuiCallOut>
          <EuiSpacer size="m" />
        </>
      )}
      {!canRequest && canReviewRoles && (
        <EuiCallOut size="s" color="primary" iconType="iInCircle" title="Bandeja de aprobaciones">
          <p>
            Las acciones disponibles dependen de tu etapa de aprobación y las valida el backend.
          </p>
        </EuiCallOut>
      )}
      <EuiSpacer size="s" />
      <EuiBasicTable<RoleRequestView>
        items={[...items]}
        columns={columns}
        loading={requests.loading}
        responsive
        tableLayout="auto"
        noItemsMessage={
          requests.loading ? 'Cargando solicitudes…' : 'No hay solicitudes pendientes.'
        }
      />
      {moreError != null && <ErrorCallout error={moreError} />}
      {cursor && (
        <>
          <EuiSpacer size="s" />
          <EuiButtonEmpty size="s" isLoading={loadingMore} onClick={loadMore}>
            Cargar más
          </EuiButtonEmpty>
        </>
      )}
      {selected && (
        <RoleDecisionModal
          request={selected}
          onClose={() => setSelected(null)}
          onDecided={() => {
            setSelected(null);
            requests.reload();
          }}
        />
      )}
    </>
  );
}

function RoleChangeModal({
  user,
  onClose,
  onSubmitted,
}: {
  user: DirectoryUser;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const { api } = useConsole();
  const current = useAsync(
    () => api.get<RoleGrantView>(`/admin/users/${encodeURIComponent(user.oid)}/role-grant`),
    [api, user.oid],
  );
  const [action, setAction] = useState<RoleRequestAction>('grant');
  const [role, setRole] = useState<RequestableRole>('qapaq.soc.analyst');
  const [reason, setReason] = useState('');
  const [ticket, setTicket] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<string | null>(null);
  const length = reason.trim().length;
  const grantRoles = current.data?.grant.roles ?? [];
  const availableRoles = (current.data?.assignableRoles ?? []).filter((value) =>
    action === 'grant' ? !user.roles.includes(value) : grantRoles.includes(value),
  );
  const roleExists = availableRoles.includes(role);

  const submit = async () => {
    if (!current.data?.eligible || !roleExists || length < REASON_MIN) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ request: RoleRequestView }>(
        `/admin/users/${encodeURIComponent(user.oid)}/role-requests`,
        {
          action,
          role,
          reason: reason.trim(),
          ticket: ticket.trim() || null,
          expectedRevision: current.data.grant.revision,
        },
      );
      setCreated(result.request.id);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <EuiModal onClose={onClose} className="qapaqModal" maxWidth={560}>
      <EuiModalHeader>
        <EuiModalHeaderTitle>
          <h2>Solicitar cambio de rol</h2>
        </EuiModalHeaderTitle>
      </EuiModalHeader>
      <EuiModalBody>
        {error != null && <ErrorCallout error={error} />}
        {current.error && <ErrorCallout error={current.error} onRetry={current.reload} />}
        {created ? (
          <EuiCallOut size="s" color="success" iconType="check" title="Solicitud registrada">
            <p>
              La solicitud <Mono>{created}</Mono> quedó pendiente de aprobación. El rol no cambia
              hasta que termine el flujo requerido.
            </p>
          </EuiCallOut>
        ) : current.data ? (
          <>
            {!current.data.eligible && (
              <EuiCallOut
                size="s"
                color="warning"
                iconType="alert"
                title="La cuenta no es elegible para cambios de rol."
              >
                <p>Se requiere pertenencia vigente a Accesos_SOC y cuenta habilitada en Entra.</p>
              </EuiCallOut>
            )}
            <EuiSpacer size="m" />
            <EuiFormRow label="Acción" fullWidth>
              <EuiSelect
                fullWidth
                value={action}
                onChange={(event) => {
                  const next = event.target.value as RoleRequestAction;
                  setAction(next);
                  setRole(
                    next === 'grant' ? 'qapaq.soc.analyst' : (grantRoles[0] ?? 'qapaq.soc.analyst'),
                  );
                }}
                options={[
                  { value: 'grant', text: 'Conceder un rol' },
                  { value: 'revoke', text: 'Retirar un rol' },
                ]}
              />
            </EuiFormRow>
            <EuiFormRow label="Rol" fullWidth>
              <EuiSelect
                fullWidth
                value={role}
                onChange={(event) => setRole(event.target.value as RequestableRole)}
                options={availableRoles.map((value) => ({
                  value,
                  text: ROLE_LABEL[value] ?? value,
                }))}
                disabled={availableRoles.length === 0}
              />
            </EuiFormRow>
            {availableRoles.length === 0 && (
              <EuiCallOut
                size="s"
                color="primary"
                iconType="iInCircle"
                title="Sin cambios posibles"
              >
                <p>
                  {action === 'grant'
                    ? 'La persona ya tiene todos los roles solicitables.'
                    : 'La persona no tiene un rol QAPAQ que pueda retirarse.'}
                </p>
              </EuiCallOut>
            )}
            <EuiFormRow
              label="Motivo"
              fullWidth
              helpText={`${length}/${REASON_MAX} · mínimo ${REASON_MIN}`}
            >
              <EuiTextArea
                fullWidth
                rows={3}
                maxLength={REASON_MAX}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </EuiFormRow>
            <EuiFormRow label="Ticket o referencia (opcional)" fullWidth>
              <EuiFieldText
                fullWidth
                maxLength={120}
                value={ticket}
                onChange={(event) => setTicket(event.target.value)}
              />
            </EuiFormRow>
          </>
        ) : (
          <EuiLoadingContent lines={4} />
        )}
      </EuiModalBody>
      <EuiModalFooter>
        <EuiFlexGroup gutterSize="s" justifyContent="flexEnd" responsive={false} wrap>
          <EuiFlexItem grow={false}>
            <EuiButtonEmpty onClick={() => (created ? onSubmitted() : onClose())} disabled={busy}>
              {created ? 'Cerrar' : 'Cancelar'}
            </EuiButtonEmpty>
          </EuiFlexItem>
          {!created && (
            <EuiFlexItem grow={false}>
              <EuiButton
                fill
                isLoading={busy}
                isDisabled={
                  !current.data?.eligible || current.loading || !roleExists || length < REASON_MIN
                }
                onClick={submit}
              >
                Enviar solicitud
              </EuiButton>
            </EuiFlexItem>
          )}
        </EuiFlexGroup>
      </EuiModalFooter>
    </EuiModal>
  );
}

function RoleDecisionModal({
  request,
  onClose,
  onDecided,
}: {
  request: RoleRequestView;
  onClose: () => void;
  onDecided: () => void;
}) {
  const { api, can } = useConsole();
  const [decision, setDecision] = useState<'approve' | 'reject'>('approve');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const length = reason.trim().length;
  const path = `/admin/role-requests/${encodeURIComponent(request.id)}/${decision}`;
  const stepUpBlocked = request.approvalStage === 'security' && decision === 'approve';
  const capabilityAllowed =
    request.approvalStage === 'access'
      ? can(CAPABILITIES.rolesApprove)
      : can(CAPABILITIES.rolesApprovePrivileged);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(path, { expectedRevision: request.revision, reason: reason.trim() });
      onDecided();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <EuiModal onClose={onClose} className="qapaqModal" maxWidth={560}>
      <EuiModalHeader>
        <EuiModalHeaderTitle>
          <h2>Revisar solicitud de rol</h2>
        </EuiModalHeaderTitle>
      </EuiModalHeader>
      <EuiModalBody>
        {error != null && <ErrorCallout error={error} />}
        <EuiCallOut size="s" color="primary" iconType="iInCircle" title="Cambio propuesto">
          <p>
            {ROLE_REQUEST_ACTION_LABEL[request.action]} {ROLE_LABEL[request.role] ?? request.role}{' '}
            para <Mono>{request.targetOid}</Mono>. El solicitante es{' '}
            <Mono>{request.requesterOid}</Mono>.
          </p>
          <p>{request.reason}</p>
        </EuiCallOut>
        <EuiSpacer size="m" />
        {stepUpBlocked && (
          <EuiCallOut
            size="s"
            color="warning"
            iconType="alert"
            title="La aprobación requiere step-up reciente"
          >
            <p>
              La sesión actual no proporciona esa evidencia. Puedes rechazarla o cerrar la ventana.
            </p>
          </EuiCallOut>
        )}
        <EuiFormRow label="Decisión" fullWidth>
          <EuiSelect
            fullWidth
            value={decision}
            onChange={(event) => setDecision(event.target.value as 'approve' | 'reject')}
            options={[
              { value: 'approve', text: 'Aprobar etapa' },
              { value: 'reject', text: 'Rechazar solicitud' },
            ]}
          />
        </EuiFormRow>
        <EuiFormRow
          label="Motivo de la decisión"
          fullWidth
          helpText={`${length}/${REASON_MAX} · mínimo ${REASON_MIN}`}
        >
          <EuiTextArea
            fullWidth
            rows={3}
            maxLength={REASON_MAX}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </EuiFormRow>
      </EuiModalBody>
      <EuiModalFooter>
        <EuiFlexGroup gutterSize="s" justifyContent="flexEnd" responsive={false} wrap>
          <EuiFlexItem grow={false}>
            <EuiButtonEmpty onClick={onClose} disabled={busy}>
              Cancelar
            </EuiButtonEmpty>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiButton
              fill
              color={decision === 'reject' ? 'danger' : 'primary'}
              isLoading={busy}
              isDisabled={
                !capabilityAllowed ||
                (stepUpBlocked && decision === 'approve') ||
                length < REASON_MIN
              }
              onClick={submit}
            >
              {decision === 'approve' ? 'Confirmar aprobación' : 'Rechazar solicitud'}
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiModalFooter>
    </EuiModal>
  );
}

function SessionsPanel() {
  const { api, can } = useConsole();
  const sessions = useAsync(
    () => api.get<Page<AdminSession> & { windowDays: number }>('/admin/sessions'),
    [api],
  );
  const [revoking, setRevoking] = useState<AdminSession | null>(null);
  const [items, setItems] = useState<readonly AdminSession[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  useEffect(() => {
    if (sessions.data) {
      setItems(sessions.data.items);
      setCursor(sessions.data.nextCursor);
    }
  }, [sessions.data]);
  useChanges(['session'], () => sessions.reload(), 1000);

  const loadMore = async () => {
    if (!cursor) return;
    const next = await api.get<Page<AdminSession>>('/admin/sessions', { cursor });
    setItems((current) => [...current, ...next.items]);
    setCursor(next.nextCursor);
  };

  if (sessions.error) return <ErrorCallout error={sessions.error} onRetry={sessions.reload} />;

  const columns: Array<EuiBasicTableColumn<AdminSession>> = [
    {
      field: 'displayName',
      name: 'Persona',
      truncateText: false,
      render: (value: string | null, session: AdminSession) => (
        <span className="qapaqCellTitle">
          <span>
            {value ?? session.email ?? 'Sin nombre'}
            {session.current ? ' · esta sesión' : ''}
          </span>
          <span className="qapaqCellMeta">
            {session.amr.join(' + ') || 'sin método'} · {session.clientIp ?? 'IP sin dato'}
          </span>
        </span>
      ),
      mobileOptions: { header: false },
    },
    {
      field: 'state',
      name: 'Estado',
      render: (value: AdminSession['state'], session: AdminSession) => (
        <HealthMark
          tone={value === 'active' ? 'ok' : value === 'revoked' ? 'fail' : 'neutral'}
          label={`${SESSION_STATE_LABEL[value]}${session.revocationReason ? ` · ${session.revocationReason}` : ''}`}
        />
      ),
    },
    { field: 'roles', name: 'Roles', render: (roles: string[]) => <Roles roles={roles} /> },
    {
      field: 'lastSeenAt',
      name: 'Última actividad',
      render: (value: string) => <Timestamp iso={value} />,
    },
    {
      name: 'Acciones',
      width: '120px',
      render: (session: AdminSession) =>
        can(CAPABILITIES.sessionsRevoke) && session.state === 'active' && !session.current ? (
          <EuiButtonEmpty size="xs" color="danger" onClick={() => setRevoking(session)}>
            Revocar
          </EuiButtonEmpty>
        ) : null,
    },
  ];

  return (
    <>
      <EuiBasicTable<AdminSession>
        items={items as AdminSession[]}
        columns={columns}
        loading={sessions.loading}
        responsive
        tableLayout="auto"
        noItemsMessage={
          sessions.loading
            ? 'Cargando sesiones…'
            : `Sin sesiones en los últimos ${sessions.data?.windowDays ?? 7} días.`
        }
      />
      {cursor && (
        <>
          <EuiSpacer size="s" />
          <EuiButtonEmpty size="s" onClick={loadMore}>
            Cargar más
          </EuiButtonEmpty>
        </>
      )}
      {revoking && (
        <RevokeModal
          session={revoking}
          onClose={() => setRevoking(null)}
          onRevoked={() => {
            setRevoking(null);
            sessions.reload();
          }}
        />
      )}
    </>
  );
}

function RevokeModal({
  session,
  onClose,
  onRevoked,
}: {
  session: AdminSession;
  onClose: () => void;
  onRevoked: () => void;
}) {
  const { api } = useConsole();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const length = reason.trim().length;

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/admin/sessions/${encodeURIComponent(session.ref)}/revoke`, {
        reason: reason.trim(),
        expectedRevision: session.revision,
      });
      onRevoked();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <EuiModal onClose={onClose} className="qapaqModal" maxWidth={520}>
      <EuiModalHeader>
        <EuiModalHeaderTitle>
          <h2>Revocar sesión</h2>
        </EuiModalHeaderTitle>
      </EuiModalHeader>
      <EuiModalBody>
        {error != null && <ErrorCallout error={error} />}
        <p>
          La persona tendrá que volver a iniciar sesión. Queda registrado en la auditoría como{' '}
          <Mono>access.session.revoked</Mono>.
        </p>
        <EuiSpacer size="m" />
        <EuiFormRow
          label="Motivo"
          fullWidth
          helpText={`${length} de ${REASON_MAX} caracteres · mínimo ${REASON_MIN}`}
        >
          <EuiFieldText
            fullWidth
            value={reason}
            maxLength={REASON_MAX}
            onChange={(event) => setReason(event.target.value)}
          />
        </EuiFormRow>
      </EuiModalBody>
      <EuiModalFooter>
        <EuiFlexGroup gutterSize="s" justifyContent="flexEnd" responsive={false} wrap>
          <EuiFlexItem grow={false}>
            <EuiButtonEmpty onClick={onClose} disabled={busy}>
              Cancelar
            </EuiButtonEmpty>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiButton
              fill
              color="danger"
              isLoading={busy}
              isDisabled={length < REASON_MIN}
              onClick={revoke}
            >
              Revocar sesión
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiModalFooter>
    </EuiModal>
  );
}
