/**
 * Sprint 5 · fase 3 — padrón del grupo de admisión para la administración (`users.read`).
 *
 * - `GET /api/admin/users`: miembros y dueños del grupo con rol efectivo y su origen
 *   (`group_owner`, `deploy_binding`, `entra_app_role` o `none` = «sin acceso asignado»), estado
 *   de cuenta y actividad QAPAQ (última solicitud autenticada y sesiones activas). Incluye el
 *   estado de la sincronización y si el padrón está viejo.
 * - `GET /api/admin/users/:oid`: la misma fila más sus sesiones recientes (las referencias
 *   sirven para revocar en `POST /api/admin/sessions/:ref/revoke`).
 *
 * Con la sincronización deshabilitada no hay padrón: se listan solo las identidades declaradas
 * en el deploy (dueños y asignaciones), sin nombre, con `membership: null`. Nada se inventa.
 *
 * Las sesiones se asocian a una persona por UPN (la sesión guarda `preferred_username`, no el
 * OID). Es una asociación declarada: un cambio de UPN en Entra la corta hasta el próximo inicio.
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

  private async sessionsByUpn(tenantId: string): Promise<Map<string, Session[]>> {
    const since = new Date(this.runtime.now().getTime() - SESSION_WINDOW_MS);
    const sessions = await this.runtime.sessions.recentByTenant(tenantId, since, SESSION_LIMIT);
    const byUpn = new Map<string, Session[]>();
    for (const session of sessions) {
      const upn = session.email?.toLowerCase();
      if (!upn) continue;
      byUpn.set(upn, [...(byUpn.get(upn) ?? []), session]);
    }
    return byUpn;
  }

  private view(row: UserRow, owners: ReadonlySet<string>, sessions: readonly Session[]) {
    const active = sessions.filter((session) => session.state === 'active');
    const latest = [...sessions].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())[0];
    const grants = this.runtime.roleGrantsConfig ?? { bindings: {}, groupOwnerOids: [] };
    const role: { roles: readonly string[]; origin: RoleOrigin } = explainRole(
      grants,
      owners,
      row.oid,
      latest?.roles ?? [],
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
    const [{ rows, owners }, sessions, sync] = await Promise.all([
      this.roster(actor.tenantId),
      this.sessionsByUpn(actor.tenantId),
      this.syncView(),
    ]);
    const items = [...rows.values()]
      .map((row) =>
        this.view(row, owners, row.upn ? (sessions.get(row.upn.toLowerCase()) ?? []) : []),
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
    const sessions = row.upn
      ? ((await this.sessionsByUpn(actor.tenantId)).get(row.upn.toLowerCase()) ?? [])
      : [];
    const currentReference = this.runtime.sessionReferenceOf(session.id);
    return {
      correlationId,
      user: this.view(row, owners, sessions),
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
