/**
 * Administración de roles concedidos por QAPAQ (entra-soc-user-admin.md, ADR-017).
 *
 * No existe asignación directa: todo cambio es una solicitud que resuelven aprobadores distintos.
 *
 * - `GET  /api/admin/users/:oid/role-grant` (`users.read`): grant dinámico vigente con su revisión,
 *   más las fuentes que la consola no puede cambiar (deploy y dueño del grupo), por separado.
 * - `POST /api/admin/users/:oid/role-requests` (`roles.request` + CSRF): pide conceder o retirar
 *   uno de los cuatro roles runtime. Exige `reason`, `ticket?` y `expectedRevision` del grant.
 * - `GET  /api/admin/role-requests?status=&pageSize=&cursor=` (`roles.request`, `roles.approve` o
 *   `roles.approve.privileged`): bandeja de solicitudes del tenant.
 * - `POST /api/admin/role-requests/:requestId/approve|reject` (capability exacta de la etapa
 *   pendiente + OID declarado como aprobador + CSRF): exige `expectedRevision` de la solicitud y
 *   `reason`.
 *
 * Las reglas (SoD, padrón fresco, miembros vigentes, CAS, auditoría atómica, step-up) viven en
 * `runtime/role-administration.ts`; aquí solo se valida la forma y se traduce el resultado.
 *
 * Tras la aprobación final, las sesiones activas del objetivo se revocan **después** del commit:
 * el store de sesiones no comparte la transacción del grant. Si alguna queda activa, el cambio ya
 * está confirmado, la respuesta lo dice en `sessionRevocation.remaining` y el hueco se audita;
 * la contención pendiente se completa con `POST /api/admin/sessions/{ref}/revoke`.
 *
 * Mismo error para inexistente y no autorizado: la API no confirma OIDs ni solicitudes ajenas.
 */

import { randomUUID } from 'node:crypto';

import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import {
  isRequestableRole,
  OPEN_ROLE_REQUEST_STATUSES,
  REQUESTABLE_ROLES,
  ROLE_REQUEST_ACTIONS,
  ROLE_REQUEST_STATUSES,
  type Capability,
  type RoleGrant,
  type RoleRequest,
  type RoleRequestAction,
  type RoleRequestStatus,
} from '@qapaq/access';
import { recordAudit } from '@qapaq/audit';
import { GROUP_OWNER_ROLE } from '@qapaq/configuration';

import { ApiError } from '../http/api-error.js';
import type { IncomingRequest } from '../http/http-contracts.js';
import {
  decideRoleRequest,
  submitRoleRequest,
  type RoleAdministrationActor,
  type RoleAdministrationDependencies,
  type RoleAdministrationFailure,
} from '../runtime/role-administration.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';
import { mutatingActor, readingActor } from './session-actor.js';
import { SECOPS_RUNTIME } from './tokens.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const REASON_LIMITS = Object.freeze({ minimumLength: 10, maximumLength: 500 });
/** Referencia de ticket: identificador corto, sin texto libre ni caracteres de control. */
const TICKET = /^[\p{L}\p{N}][\p{L}\p{N} ._:#/-]{0,119}$/u;
const PAGE_SIZE = Object.freeze({ default: 50, maximum: 100 });
const LIST_STATUSES: Readonly<Record<string, readonly RoleRequestStatus[]>> = Object.freeze({
  pending: OPEN_ROLE_REQUEST_STATUSES,
  closed: ROLE_REQUEST_STATUSES.filter((status) => !OPEN_ROLE_REQUEST_STATUSES.includes(status)),
  all: ROLE_REQUEST_STATUSES,
});
const INBOX_CAPABILITIES: readonly Capability[] = [
  'roles.request',
  'roles.approve',
  'roles.approve.privileged',
];
const DECISION_CAPABILITIES: readonly Capability[] = ['roles.approve', 'roles.approve.privileged'];

interface RoleRequestBody {
  readonly action?: unknown;
  readonly role?: unknown;
  readonly reason?: unknown;
  readonly ticket?: unknown;
  readonly expectedRevision?: unknown;
}

interface DecisionBody {
  readonly expectedRevision?: unknown;
  readonly reason?: unknown;
}

/** Roles que se pueden solicitar: el catálogo runtime, ni uno más (sin los de aprobador). */
export const ASSIGNABLE_ROLES: readonly string[] = Object.freeze([...REQUESTABLE_ROLES]);

function grantView(grant: RoleGrant) {
  return {
    roles: grant.roles,
    revision: grant.revision,
    updatedAt: grant.updatedAt?.toISOString() ?? null,
    updatedBy: grant.updatedBy,
  };
}

function requestView(request: RoleRequest) {
  return {
    id: request.id,
    targetOid: request.targetOid,
    action: request.action,
    role: request.role,
    reason: request.reason,
    ticket: request.ticket,
    status: request.status,
    approvalStage:
      request.status === 'pending_access'
        ? 'access'
        : request.status === 'pending_security'
          ? 'security'
          : null,
    requesterOid: request.requesterOid,
    priorApproverOid: request.accessApproval?.oid ?? null,
    securityApproverOid: request.securityApproval?.oid ?? null,
    closure: request.closure
      ? { at: request.closure.at.toISOString(), reason: request.closure.reason }
      : null,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    revision: request.revision,
  };
}

function failure(code: RoleAdministrationFailure, correlationId: string): ApiError {
  const mapping = {
    UNAVAILABLE: 'RESOURCE_UNAVAILABLE',
    CONFLICT: 'STATE_CONFLICT',
    STEP_UP_REQUIRED: 'STEP_UP_REQUIRED',
  } as const;
  return new ApiError(mapping[code], correlationId);
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function trimmedReason(value: unknown): string | undefined {
  const reason = typeof value === 'string' ? value.trim() : '';
  const { minimumLength, maximumLength } = REASON_LIMITS;
  return reason.length >= minimumLength && reason.length <= maximumLength ? reason : undefined;
}

type ResolvedActor = Awaited<ReturnType<typeof readingActor>>;

function administrationActor({ actor, session }: ResolvedActor): RoleAdministrationActor {
  return {
    subjectId: actor.subjectId,
    sessionId: actor.sessionId,
    oid: session.oid?.toLowerCase(),
    capabilities: actor.capabilities,
    amr: session.amr,
  };
}

@Controller('api/admin')
export class AdminRoleGrantsController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  /**
   * Padrón Graph y administración de roles, o nada: sin padrón no hay cómo validar miembros, y el
   * composition root tampoco suma grants dinámicos al iniciar sesión.
   */
  private dependencies(tenantId: string): RoleAdministrationDependencies | undefined {
    const directory = this.runtime.directory;
    const administration = this.runtime.roleAdministration;
    if (directory?.mode !== 'graph' || !administration) return undefined;
    if (tenantId !== this.runtime.tenantIdForDirectory) return undefined;
    return {
      administration,
      directory: {
        store: directory.store,
        groupId: directory.groupId,
        intervalMs: directory.intervalMs,
      },
      config: this.runtime.roleGrantsConfig,
      tenantId,
      now: () => this.runtime.now(),
    };
  }

  /** Fuentes que no cambian por esta API; se muestran para que la vista no las confunda. */
  private async fixedSources(tenantId: string, groupId: string, oid: string) {
    const config = this.runtime.roleGrantsConfig;
    const graphOwners =
      this.runtime.directory?.mode === 'graph'
        ? await this.runtime.directory.store.owners(tenantId, groupId)
        : [];
    const isOwner =
      (config?.groupOwnerOids.includes(oid) ?? false) ||
      graphOwners.some((owner) => owner.oid.toLowerCase() === oid);
    return {
      deployRoles: config?.bindings[oid] ?? [],
      groupOwnerRoles: isOwner ? [GROUP_OWNER_ROLE] : [],
    };
  }

  @Get('users/:oid/role-grant')
  public async current(@Req() request: IncomingRequest, @Param('oid') oid: string) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    const deps = this.dependencies(actor.tenantId);
    if (!actor.capabilities.has('users.read') || !GUID.test(oid) || !deps) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const key = oid.toLowerCase();
    const member = await deps.directory.store.member(deps.tenantId, deps.directory.groupId, key);
    if (!member) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    const [grant, fixed] = await Promise.all([
      deps.administration.grants.current(deps.tenantId, key),
      this.fixedSources(deps.tenantId, deps.directory.groupId, key),
    ]);
    return {
      correlationId,
      oid: key,
      // Solo un miembro vigente con cuenta habilitada recibe los grants al iniciar sesión.
      eligible: member.membership === 'member' && member.accountEnabled === true,
      grant: grantView(grant),
      ...fixed,
      assignableRoles: ASSIGNABLE_ROLES,
    };
  }

  @Post('users/:oid/role-requests')
  public async submit(
    @Req() request: IncomingRequest,
    @Param('oid') oid: string,
    @Body() body: RoleRequestBody | undefined,
  ) {
    const resolved = await mutatingActor(this.runtime, request);
    const { actor, correlationId } = resolved;
    const deps = this.dependencies(actor.tenantId);
    if (!actor.capabilities.has('roles.request') || !deps) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const input = body ?? {};
    const reason = trimmedReason(input.reason);
    const ticket =
      input.ticket === undefined || input.ticket === null
        ? null
        : typeof input.ticket === 'string' && TICKET.test(input.ticket.trim())
          ? input.ticket.trim()
          : undefined;
    const invalid: string[] = [];
    const actionValid = (ROLE_REQUEST_ACTIONS as readonly unknown[]).includes(input.action);
    if (!actionValid) invalid.push('action');
    if (!isRequestableRole(input.role)) invalid.push('role');
    if (!reason) invalid.push('reason');
    if (ticket === undefined) invalid.push('ticket');
    if (!validRevision(input.expectedRevision)) invalid.push('expectedRevision');
    if (invalid.length > 0) throw new ApiError('VALIDATION_FAILED', correlationId, invalid);
    if (!GUID.test(oid)) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);

    const result = await submitRoleRequest(
      deps,
      administrationActor(resolved),
      {
        targetOid: oid.toLowerCase(),
        action: input.action as RoleRequestAction,
        role: input.role as (typeof REQUESTABLE_ROLES)[number],
        reason: reason!,
        ticket: ticket ?? null,
        expectedRevision: input.expectedRevision as number,
      },
      correlationId,
    );
    if (!result.ok) throw failure(result.failure, correlationId);
    return { correlationId, request: requestView(result.value) };
  }

  @Get('role-requests')
  public async list(
    @Req() request: IncomingRequest,
    @Query() query: { status?: unknown; pageSize?: unknown; cursor?: unknown },
  ) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    const deps = this.dependencies(actor.tenantId);
    if (!INBOX_CAPABILITIES.some((capability) => actor.capabilities.has(capability)) || !deps) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const status = query.status === undefined ? 'pending' : query.status;
    const pageSize = query.pageSize === undefined ? PAGE_SIZE.default : Number(query.pageSize);
    const offset = query.cursor === undefined ? 0 : Number(query.cursor);
    const invalid: string[] = [];
    if (typeof status !== 'string' || !Object.hasOwn(LIST_STATUSES, status)) invalid.push('status');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE.maximum) {
      invalid.push('pageSize');
    }
    if (!Number.isSafeInteger(offset) || offset < 0) invalid.push('cursor');
    if (invalid.length > 0) throw new ApiError('VALIDATION_FAILED', correlationId, invalid);

    // El store devuelve como máximo `ROLE_REQUEST_LIST_LIMIT` filas recientes; el cursor es un
    // desplazamiento sobre esa ventana, suficiente para una bandeja de un grupo SOC.
    const rows = await deps.administration.requests.list(
      deps.tenantId,
      LIST_STATUSES[status as string]!,
    );
    const page = rows.slice(offset, offset + pageSize);
    const next = offset + page.length;
    return {
      correlationId,
      items: page.map(requestView),
      nextCursor: next < rows.length ? String(next) : null,
    };
  }

  @Post('role-requests/:requestId/approve')
  public approve(
    @Req() request: IncomingRequest,
    @Param('requestId') requestId: string,
    @Body() body: DecisionBody | undefined,
  ) {
    return this.decide(request, requestId, 'approve', body);
  }

  @Post('role-requests/:requestId/reject')
  public reject(
    @Req() request: IncomingRequest,
    @Param('requestId') requestId: string,
    @Body() body: DecisionBody | undefined,
  ) {
    return this.decide(request, requestId, 'reject', body);
  }

  private async decide(
    request: IncomingRequest,
    requestId: string,
    decision: 'approve' | 'reject',
    body: DecisionBody | undefined,
  ) {
    const resolved = await mutatingActor(this.runtime, request);
    const { actor, correlationId } = resolved;
    const deps = this.dependencies(actor.tenantId);
    // La capability exacta de la etapa la comprueba el caso de uso; sin ninguna, ni se valida.
    const approves = DECISION_CAPABILITIES.some((capability) => actor.capabilities.has(capability));
    if (!deps || !approves) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const input = body ?? {};
    const reason = trimmedReason(input.reason);
    const invalid: string[] = [];
    if (!validRevision(input.expectedRevision)) invalid.push('expectedRevision');
    if (!reason) invalid.push('reason');
    if (invalid.length > 0) throw new ApiError('VALIDATION_FAILED', correlationId, invalid);
    if (!GUID.test(requestId)) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);

    const result = await decideRoleRequest(
      deps,
      administrationActor(resolved),
      {
        requestId: requestId.toLowerCase(),
        decision,
        expectedRevision: input.expectedRevision as number,
        reason: reason!,
      },
      correlationId,
    );
    if (!result.ok) throw failure(result.failure, correlationId);
    const { request: decided, grant } = result.value;
    if (!grant) return { correlationId, request: requestView(decided) };

    // El grant ya está confirmado con su auditoría; las sesiones se revocan fuera de esa
    // transacción (otro store) y un hueco queda auditado, no oculto.
    const revocation = await this.runtime.revokeSessionsForRoleChange(
      decided.targetOid,
      { id: actor.subjectId, sessionId: actor.sessionId },
      correlationId,
    );
    if (revocation.remaining > 0) {
      await recordAudit(this.runtime.audit, {
        id: randomUUID(),
        tenantId: deps.tenantId,
        occurredAt: this.runtime.now(),
        actor: { id: actor.subjectId, type: 'user', sessionId: actor.sessionId },
        action: 'access.role_grant.sessions_revocation_incomplete',
        resource: { type: 'role_grant', id: decided.targetOid },
        outcome: 'failed',
        correlationId,
        reason: reason!,
        metadata: {
          requestId: decided.id,
          targetOid: decided.targetOid,
          revision: grant.revision,
          revoked: revocation.revoked,
          remaining: revocation.remaining,
        },
      });
    }
    return {
      correlationId,
      request: requestView(decided),
      grant: { roles: grant.roles, revision: grant.revision },
      sessionRevocation: revocation,
    };
  }
}
