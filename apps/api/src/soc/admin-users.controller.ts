/**
 * Sprint 5 · fase 3 — padrón del grupo de admisión para la administración (`users.read`).
 *
 * - `GET /api/admin/users`: miembros y dueños del grupo con rol efectivo y su origen
 *   (`group_owner`, `admin_group`, `qapaq_assignment`, `deploy_binding`, `entra_app_role` o `none` = «sin acceso
 *   asignado»), estado
 *   de cuenta y actividad QAPAQ (última solicitud autenticada y sesiones activas). Incluye el
 *   estado de la sincronización y si el padrón está viejo.
 * - `GET /api/admin/users/:oid`: la misma fila más sus sesiones recientes (las referencias
 *   sirven para revocar en `POST /api/admin/sessions/:ref/revoke`).
 *
 * Con la sincronización deshabilitada no hay padrón: se listan solo las identidades declaradas
 * en el deploy (dueños y asignaciones), sin nombre, con `membership: null`. Nada se inventa.
 *
 * Las sesiones se asocian por OID cuando la sesión lo trae y usan UPN solo para sesiones antiguas.
 * Un OID fuera del padrón y fuera del deploy responde igual que uno inexistente.
 */

import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import type { Session } from '@qapaq/access';

import { ApiError } from '../http/api-error.js';
import type { IncomingRequest } from '../http/http-contracts.js';
import { explainRole, type RoleOrigin } from '../runtime/role-grants.js';
import { readingActor } from './session-actor.js';
import { SECOPS_RUNTIME } from './tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';

const SESSION_WINDOW_MS = 7 * 86_400_000;
const SESSION_LIMIT = 2_000;
/** Un padrón sin éxito durante tres intervalos se declara viejo. */
const STALE_AFTER_INTERVALS = 3;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface UserRow {
  readonly oid: string;
  readonly displayName: string | null;
  readonly upn: string | null;
  readonly accountEnabled: boolean | null;
  readonly membership: 'member' | 'removed' | null;
  readonly isOwner: boolean;
}

@Controller('api/admin/users')
export class AdminUsersController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  /** Personas visibles: padrón sincronizado más identidades declaradas en el deploy. */
  private async roster(tenantId: string) {
    const directory = this.runtime.directory;
    const grants = this.runtime.roleGrantsConfig;
    const rows = new Map<string, UserRow>();
    let owners = new Set<string>();
    if (directory?.mode === 'graph') {
      const [members, ownerList] = await Promise.all([
        directory.store.members(tenantId, directory.groupId),
        directory.store.owners(tenantId, directory.groupId),
      ]);
      owners = new Set(ownerList.map((owner) => owner.oid.toLowerCase()));
      for (const member of members) {
        rows.set(member.oid, { ...member, isOwner: owners.has(member.oid) });
      }
      for (const owner of ownerList) {
        if (!rows.has(owner.oid))
          rows.set(owner.oid, { ...owner, membership: null, isOwner: true });
      }
    }
    // Identidades del deploy que el padrón no trae (o sin padrón): sin nombre, sin inventar.
    for (const oid of [...(grants?.groupOwnerOids ?? []), ...Object.keys(grants?.bindings ?? {})]) {
      if (!rows.has(oid)) {
        rows.set(oid, {
          oid,
          displayName: null,
          upn: null,
          accountEnabled: null,
          membership: null,
          isOwner: grants?.groupOwnerOids.includes(oid) ?? false,
        });
      }
    }
    return { rows, owners };
  }

  private async sessionsByUser(tenantId: string): Promise<{
    byOid: Map<string, Session[]>;
    byUpn: Map<string, Session[]>;
  }> {
    const since = new Date(this.runtime.now().getTime() - SESSION_WINDOW_MS);
    const sessions = await this.runtime.sessions.recentByTenant(tenantId, since, SESSION_LIMIT);
    const byOid = new Map<string, Session[]>();
    const byUpn = new Map<string, Session[]>();
    for (const session of sessions) {
      if (session.oid) {
        const oid = session.oid.toLowerCase();
        byOid.set(oid, [...(byOid.get(oid) ?? []), session]);
        continue;
      }
      const upn = session.email?.toLowerCase();
      if (!upn) continue;
      byUpn.set(upn, [...(byUpn.get(upn) ?? []), session]);
    }
    return { byOid, byUpn };
  }

  private async assignmentsByOid(tenantId: string): Promise<Map<string, readonly string[]>> {
    const store = this.runtime.roleAdministration?.grants;
    if (!store) return new Map();
    const grants = await store.list(tenantId);
    return new Map(grants.map((grant) => [grant.oid.toLowerCase(), grant.roles]));
  }

  private view(
    row: UserRow,
    owners: ReadonlySet<string>,
    sessions: readonly Session[],
    dynamicRoles: readonly string[],
  ) {
    const active = sessions.filter((session) => session.state === 'active');
    const latest = [...sessions].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())[0];
    const grants = this.runtime.roleGrantsConfig ?? {
      bindings: {},
      groupOwnerOids: [],
      adminGroupIds: [],
    };
    const directory = this.runtime.directory;
    const adminGroupMember =
      row.membership === 'member' &&
      directory?.mode === 'graph' &&
      grants.adminGroupIds.includes(directory.groupId.toLowerCase());
    const role: { roles: readonly string[]; origin: RoleOrigin } = explainRole(
      grants,
      owners,
      row.oid,
      latest?.roles ?? [],
      adminGroupMember,
      dynamicRoles,
    );
    return {
      oid: row.oid,
      displayName: row.displayName,
      upn: row.upn,
      accountEnabled: row.accountEnabled,
      membership: row.membership,
      isOwner: row.isOwner || role.origin === 'group_owner',
      roles: role.roles,
      roleOrigin: role.origin,
      lastSeenAt: latest?.lastSeenAt.toISOString() ?? null,
      activeSessions: active.length,
    };
  }

  private async syncView() {
    const directory = this.runtime.directory;
    if (!directory || directory.mode !== 'graph') {
      return {
        mode: 'disabled' as const,
        status: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastErrorClass: null,
        stale: false,
      };
    }
    const tenantId = this.runtime.tenantIdForDirectory;
    const state = await directory.store.syncState(tenantId, directory.groupId);
    const lastSuccessAt = state?.lastSuccessAt ?? null;
    const stale =
      !lastSuccessAt ||
      this.runtime.now().getTime() - lastSuccessAt.getTime() >
        STALE_AFTER_INTERVALS * directory.intervalMs;
    return {
      mode: 'graph' as const,
      status: state?.status ?? 'never',
      lastAttemptAt: state?.lastAttemptAt?.toISOString() ?? null,
      lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
      lastErrorClass: state?.lastErrorClass ?? null,
      stale,
    };
  }

  @Get()
  public async list(@Req() request: IncomingRequest) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    if (!actor.capabilities.has('users.read'))
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    const [{ rows, owners }, sessions, assignments, sync] = await Promise.all([
      this.roster(actor.tenantId),
      this.sessionsByUser(actor.tenantId),
      this.assignmentsByOid(actor.tenantId),
      this.syncView(),
    ]);
    const items = [...rows.values()]
      .map((row) =>
        this.view(
          row,
          owners,
          sessions.byOid.get(row.oid) ?? sessions.byUpn.get(row.upn?.toLowerCase() ?? '') ?? [],
          assignments.get(row.oid) ?? [],
        ),
      )
      .sort((a, b) => (a.displayName ?? a.oid).localeCompare(b.displayName ?? b.oid, 'es'));
    return { correlationId, sync, items, totalCount: items.length };
  }

  @Get(':oid')
  public async detail(@Req() request: IncomingRequest, @Param('oid') oid: string) {
    const { actor, session, correlationId } = await readingActor(this.runtime, request);
    if (!actor.capabilities.has('users.read') || !GUID.test(oid)) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const { rows, owners } = await this.roster(actor.tenantId);
    const row = rows.get(oid.toLowerCase());
    if (!row) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    const [sessionIndex, assignments] = await Promise.all([
      this.sessionsByUser(actor.tenantId),
      this.assignmentsByOid(actor.tenantId),
    ]);
    const sessions =
      sessionIndex.byOid.get(row.oid) ??
      sessionIndex.byUpn.get(row.upn?.toLowerCase() ?? '') ??
      [];
    const currentReference = this.runtime.sessionReferenceOf(session.id);
    return {
      correlationId,
      user: this.view(row, owners, sessions, assignments.get(row.oid) ?? []),
      sessions: sessions
        .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
        .map((item) => ({
          ref: item.id,
          current: item.id === currentReference,
          state: item.state,
          createdAt: item.createdAt.toISOString(),
          lastSeenAt: item.lastSeenAt.toISOString(),
          // Motivo de cierre (p. ej. `membership_removed`, `ownership_removed`); `null` si sigue activa.
          revocationReason: item.revocationReason ?? null,
          amr: item.amr,
          revision: item.revision,
        })),
    };
  }
}
