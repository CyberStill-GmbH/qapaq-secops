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
  EuiModal,
  EuiModalBody,
  EuiModalFooter,
  EuiModalHeader,
  EuiModalHeaderTitle,
  EuiSpacer,
  EuiTab,
  EuiTabs,
  EuiTitle,
} from '@elastic/eui';
import {
  AdminSession,
  CAPABILITIES,
  DirectorySync,
  DirectoryUser,
  DirectoryUserDetail,
  Page,
  ROLE_LABEL,
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
  const [tab, setTab] = useState<'users' | 'sessions'>(canUsers ? 'users' : 'sessions');

  return (
    <QapaqPage
      title="Usuarios y sesiones"
      description="Admisión por Microsoft Entra ID y el grupo Accesos_SOC. Salir del grupo revoca las sesiones abiertas."
    >
      {!canUsers && !canSessions ? (
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
          </EuiTabs>
          <EuiSpacer size="m" />
          {tab === 'users' && canUsers && <UsersPanel />}
          {tab === 'sessions' && canSessions && <SessionsPanel />}
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
  const { api } = useConsole();
  const detail = useAsync(
    () => api.get<DirectoryUserDetail>(`/admin/users/${encodeURIComponent(oid)}`),
    [api, oid],
  );
  const user = detail.data?.user;
  const state = user ? userState(user) : null;
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
    </EuiFlyout>
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
