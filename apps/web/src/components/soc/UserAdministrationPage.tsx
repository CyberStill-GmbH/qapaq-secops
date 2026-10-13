import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiErrorBody } from '@qapaq/contracts';
import { api, type SocAdminUser, type SocAdminUserSession } from '../../api/client.js';
import { Button, EmptyState, ErrorState, RelativeTime, StatusChip, SocIcon } from './soc-ui.js';
import { PageHeader } from './soc-data-ui.js';
import { useChanges } from './use-changes.js';

const roleLabels: Readonly<Record<string, string>> = {
  'qapaq.soc.analyst': 'Analista SOC',
  'qapaq.soc.lead': 'Líder SOC',
  'qapaq.auditor': 'Auditor',
  'qapaq.platform.admin': 'Administrador de plataforma',
};
const originLabels: Readonly<Record<SocAdminUser['roleOrigin'], string>> = {
  group_owner: 'Dueño del grupo',
  admin_group: 'Miembro del grupo admin',
  deploy_binding: 'Asignado en el deploy',
  entra_app_role: 'App role de Entra',
  none: 'Sin acceso',
};
const sessionStateLabels: Readonly<Record<SocAdminUserSession['state'], string>> = {
  active: 'Activa',
  expired: 'Expirada',
  revoked: 'Revocada',
  superseded: 'Reemplazada',
};
function revocationReasonLabel(reason: string | null | undefined): string | null {
  if (reason === 'membership_removed') return 'Salió del grupo';
  if (reason === 'ownership_removed') return 'Dejó de ser dueño del grupo';
  return null;
}

function syncStatus(sync: {
  readonly mode: 'disabled' | 'graph';
  readonly status: 'never' | 'ok' | 'failed' | null;
  readonly lastErrorClass: string | null;
  readonly stale: boolean;
}): { label: string; tone: 'ok' | 'warn' | 'fail' | 'neutral'; detail: string } {
  if (sync.mode === 'disabled')
    return {
      label: 'Sincronización deshabilitada',
      tone: 'neutral',
      detail: 'Se muestran únicamente las identidades declaradas en el deploy.',
    };
  if (sync.lastErrorClass === 'DIRECTORY_FORBIDDEN')
    return {
      label: 'Pendiente de consentimiento',
      tone: 'warn',
      detail: 'Graph no autorizó la lectura del grupo; no se muestra un padrón incompleto.',
    };
  if (sync.stale)
    return {
      label: 'Directorio desactualizado',
      tone: 'warn',
      detail: 'La última sincronización exitosa supera tres intervalos.',
    };
  if (sync.status === 'ok')
    return {
      label: 'Directorio sincronizado',
      tone: 'ok',
      detail: 'Miembros y dueños provienen del grupo configurado en Entra.',
    };
  if (sync.status === 'failed')
    return {
      label: 'Sincronización fallida',
      tone: 'fail',
      detail: 'La lista puede contener solo identidades conocidas por el deploy.',
    };
  return {
    label: 'Pendiente de primera sincronización',
    tone: 'neutral',
    detail: 'Aún no hay una lectura completa del grupo.',
  };
}

function membershipLabel(value: SocAdminUser['membership']): string {
  if (value === 'member') return 'Miembro del grupo';
  if (value === 'removed') return 'Fuera del grupo';
  return 'Identidad del deploy';
}

export function UserAdministrationPage(): React.JSX.Element {
  const [users, setUsers] = useState<readonly SocAdminUser[]>([]);
  const [sync, setSync] = useState<{
    mode: 'disabled' | 'graph';
    status: 'never' | 'ok' | 'failed' | null;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastErrorClass: string | null;
    stale: boolean;
  } | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<SocAdminUser | null>(null);
  const [selectedSessions, setSelectedSessions] = useState<readonly SocAdminUserSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [updated, setUpdated] = useState<string | null>(null);
  const detailRequest = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await api.adminUsers();
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setUsers(result.data.items);
    setTotalCount(result.data.totalCount);
    setSync(result.data.sync);
    setUpdated(new Date().toISOString());
    setError(null);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const liveChanges = useChanges({
    resourceTypes: ['session'],
    onChange: () => {
      void load();
      if (selected) void openUser(selected);
    },
  });

  const visibleUsers = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('es');
    if (!query) return users;
    return users.filter((user) =>
      [user.displayName, user.upn, user.oid, ...user.roles.map((role) => roleLabels[role] ?? role)]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase('es').includes(query)),
    );
  }, [search, users]);

  async function openUser(user: SocAdminUser): Promise<void> {
    const requestId = ++detailRequest.current;
    setSelected(user);
    setSelectedSessions([]);
    setDetailLoading(true);
    const result = await api.adminUser(user.oid);
    if (requestId !== detailRequest.current) return;
    setDetailLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSelected(result.data.user);
    setSelectedSessions(result.data.sessions);
    setError(null);
  }

  const status = sync ? syncStatus(sync) : null;
  return (
    <div className="soc-page soc-user-admin">
      <PageHeader
        title="Usuarios SOC"
        description="Miembros y dueños del grupo de admisión QAPAQ-SecOps-Users."
        updated={updated}
        action={
          <Button onClick={() => void load()} disabled={loading}>
            <SocIcon name="refresh" /> Actualizar
          </Button>
        }
      />
      {status ? (
        <div className="soc-operation-strip" role="status">
          <div>
            <StatusChip state={status.tone}>{status.label}</StatusChip>
          </div>
          <p>{status.detail}</p>
          <div>
            <span>Último intento</span>
            <span>
              <RelativeTime value={sync?.lastAttemptAt ?? null} />
            </span>
          </div>
          <div>
            <span>Último éxito</span>
            <span>
              <RelativeTime value={sync?.lastSuccessAt ?? null} />
            </span>
          </div>
        </div>
      ) : null}
      {liveChanges.length ? (
        <p className="soc-live-announcement" role="status" aria-live="polite">
          Actividad de sesión actualizada
        </p>
      ) : null}
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      <div className="soc-user-admin__toolbar">
        <label className="soc-user-admin__search">
          Buscar en el padrón
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Nombre, UPN o identificador"
          />
        </label>
        <span className="soc-user-admin__scope">
          {visibleUsers.length} de {totalCount} identidades
        </span>
      </div>
      <div className="soc-user-admin__layout">
        <section className="soc-table-panel" aria-label="Miembros del grupo SOC">
          <div className="soc-table-scroll">
            <table className="soc-table">
              <thead>
                <tr>
                  <th>Persona</th>
                  <th>Membresía</th>
                  <th>Acceso QAPAQ</th>
                  <th>Origen del rol</th>
                  <th>Sesiones activas</th>
                  <th>Última actividad</th>
                </tr>
              </thead>
              <tbody>
                {visibleUsers.map((user) => (
                  <tr key={user.oid} className={selected?.oid === user.oid ? 'is-selected' : ''}>
                    <td>
                      <button
                        type="button"
                        className="soc-user-admin__person"
                        onClick={() => void openUser(user)}
                      >
                        <strong>{user.displayName ?? 'Nombre no disponible'}</strong>
                        <span>{user.upn ?? user.oid}</span>
                      </button>
                    </td>
                    <td>
                      {membershipLabel(user.membership)}
                      {user.isOwner ? <small>Dueño del grupo</small> : null}
                    </td>
                    <td>
                      {user.roles.length
                        ? user.roles.map((role) => roleLabels[role] ?? role).join(', ')
                        : 'Sin acceso asignado'}
                    </td>
                    <td>{originLabels[user.roleOrigin]}</td>
                    <td className="is-numeric">{user.activeSessions}</td>
                    <td>
                      <RelativeTime value={user.lastSeenAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {loading && !users.length ? (
            <p className="soc-table-placeholder" role="status">
              Consultando el padrón autorizado…
            </p>
          ) : null}
          {!loading && !visibleUsers.length && !error ? (
            <EmptyState>
              {users.length
                ? 'No hay identidades que coincidan con la búsqueda.'
                : sync?.mode === 'graph' &&
                    (sync.status === 'never' || sync.lastErrorClass === 'DIRECTORY_FORBIDDEN')
                  ? 'El padrón no está disponible hasta que Graph complete una sincronización autorizada.'
                  : 'No hay miembros visibles ni identidades declaradas en el deploy.'}
            </EmptyState>
          ) : null}
        </section>
        {selected ? (
          <aside
            className="soc-panel soc-user-admin__detail"
            aria-label={`Detalle de ${selected.displayName ?? selected.oid}`}
          >
            <header className="soc-panel__header">
              <h2>{selected.displayName ?? 'Identidad del deploy'}</h2>
              <span>{selected.upn ?? selected.oid}</span>
            </header>
            <div className="soc-user-admin__detail-body">
              <dl className="soc-user-admin__facts">
                <div>
                  <dt>Membresía</dt>
                  <dd>{membershipLabel(selected.membership)}</dd>
                </div>
                <div>
                  <dt>Dueño del grupo</dt>
                  <dd>{selected.isOwner ? 'Sí' : 'No'}</dd>
                </div>
                <div>
                  <dt>Acceso QAPAQ</dt>
                  <dd>
                    {selected.roles.length
                      ? selected.roles.map((role) => roleLabels[role] ?? role).join(', ')
                      : 'Sin acceso asignado'}
                  </dd>
                </div>
                <div>
                  <dt>Origen del rol</dt>
                  <dd>{originLabels[selected.roleOrigin]}</dd>
                </div>
                <div>
                  <dt>Cuenta Entra</dt>
                  <dd>
                    {selected.accountEnabled === null
                      ? 'Sin dato'
                      : selected.accountEnabled
                        ? 'Habilitada'
                        : 'Deshabilitada'}
                  </dd>
                </div>
                <div>
                  <dt>Última solicitud autenticada</dt>
                  <dd>
                    <RelativeTime value={selected.lastSeenAt} />
                  </dd>
                </div>
                <div>
                  <dt>Sesiones activas</dt>
                  <dd>{selected.activeSessions}</dd>
                </div>
              </dl>
              <section className="soc-user-admin__sessions">
                <h3>Sesiones QAPAQ</h3>
                {detailLoading ? (
                  <p role="status">Consultando actividad…</p>
                ) : selectedSessions.length ? (
                  <ul>
                    {selectedSessions.map((entry) => (
                      <li key={entry.ref}>
                        <span>
                          <strong>
                            {entry.current ? 'Sesión actual' : sessionStateLabels[entry.state]}
                          </strong>
                          <small>{entry.amr.join(' · ') || 'Método MFA no informado'}</small>
                          {revocationReasonLabel(entry.revocationReason) ? (
                            <small>
                              Revocación: {revocationReasonLabel(entry.revocationReason)}
                            </small>
                          ) : null}
                        </span>
                        <span>
                          Inicio <RelativeTime value={entry.createdAt} />
                          <small>
                            Último uso <RelativeTime value={entry.lastSeenAt} />
                          </small>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="soc-muted">No hay sesiones asociadas a esta identidad.</p>
                )}
              </section>
              {sync?.mode === 'disabled' ? (
                <p className="soc-page-note">
                  La identidad proviene de la configuración del deploy; el nombre y la pertenencia
                  al grupo no se consultan.
                </p>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>
      <p className="soc-page-note">
        La lista se limita al grupo configurado. QAPAQ muestra roles efectivos y su origen; esta
        vista no cambia membresía ni asigna roles.
      </p>
    </div>
  );
}
