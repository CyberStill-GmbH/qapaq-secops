/**
 * Casos de uso de la administración de roles (entra-soc-user-admin.md, ADR-017).
 *
 * Flujo: solicitar (`roles.request`) → aprobar etapa de Acceso (`roles.approve`) → para
 * `qapaq.platform.admin`, aprobar etapa de Seguridad (`roles.approve.privileged`). Solo la
 * aprobación final cambia el grant. Reglas que aquí no se relajan:
 *
 * 1. Solicitante, objetivo y cada aprobador son personas distintas (por OID de Entra).
 * 2. Todos deben ser miembros vigentes del grupo de admisión configurado, con la cuenta habilitada,
 *    y el padrón debe tener una sincronización exitosa reciente. Sin padrón fresco no se decide
 *    nada: la API falla cerrada.
 * 3. Aprobar exige la capability de la etapa **y** que el OID esté declarado en el deploy como
 *    aprobador de esa etapa. No hay aprobadores por defecto: sin declaración, las solicitudes no
 *    se pueden crear ni resolver.
 * 4. Grant, solicitud y AuditEvent sellado se confirman en una sola unidad de trabajo. Ningún
 *    conflicto deja un grant cambiado sin su auditoría.
 * 5. La etapa de Seguridad exige autenticación fuerte y reciente (step-up). La sesión actual no
 *    guarda `auth_time` ni una reautenticación propia, así que no puede probarse sin cambiar la
 *    autenticación: esa etapa se rechaza con `STEP_UP_REQUIRED` (auditado) hasta que exista.
 *    Consecuencia operativa: hoy ningún grant de `qapaq.platform.admin` se puede aprobar desde la
 *    consola. Es un bloqueo declarado, no un defecto a esquivar.
 * 6. La revocación de sesiones del objetivo ocurre **después** del commit y en otro store: no es
 *    atómica con el grant. El llamador la ejecuta y audita si quedó incompleta.
 */

import { randomUUID } from 'node:crypto';

import {
  approveRoleRequest,
  cancelRoleRequest,
  isPrivilegedRole,
  MFA_AMR_VALUES,
  openRoleRequest,
  pendingStage,
  rejectRoleRequest,
  rolesAfter,
  type DirectoryStore,
  type RequestableRole,
  type RoleAdministration,
  type RoleAdministrationContext,
  type RoleRequest,
  type RoleRequestAction,
} from '@qapaq/access';
import { recordAudit, type AuditEventDraft } from '@qapaq/audit';
import type { RoleGrantsConfig } from '@qapaq/configuration';
import {
  isRoleRosterFresh,
  ROSTER_STALE_AFTER_INTERVALS as ROLE_ROSTER_STALE_AFTER_INTERVALS,
} from './role-grants.js';

/** Un padrón sin éxito durante tres intervalos se declara viejo (igual que la vista de usuarios). */
export const ROSTER_STALE_AFTER_INTERVALS = ROLE_ROSTER_STALE_AFTER_INTERVALS;
const SYSTEM_ACTOR = 'system:directory-sync';

export interface RoleAdministrationDependencies {
  readonly administration: RoleAdministration;
  readonly directory: {
    readonly store: DirectoryStore;
    readonly groupId: string;
    readonly intervalMs: number;
  };
  readonly config: RoleGrantsConfig | undefined;
  readonly tenantId: string;
  readonly now: () => Date;
  /**
   * Verificador de step-up para la etapa de Seguridad. Ningún composition root lo configura: no
   * existe evidencia `auth_time` + `amr` de una reautenticación reciente. Sin él, falla cerrada.
   * Solo las specs lo inyectan para cubrir el camino posterior al step-up.
   */
  readonly stepUp?: (actor: RoleAdministrationActor) => boolean;
}

/** Quien actúa: lo que la sesión ya prueba, sin consultar otra vez al IdP. */
export interface RoleAdministrationActor {
  readonly subjectId: string;
  readonly sessionId: string;
  readonly oid: string | undefined;
  readonly capabilities: ReadonlySet<string>;
  readonly amr: readonly string[];
}

export type RoleAdministrationFailure =
  /** No autorizado, inexistente, sin padrón o sin aprobadores: misma respuesta, no enumera. */
  | 'UNAVAILABLE'
  /** CAS, etapa equivocada, persona repetida, objetivo no elegible o cambio sin efecto. */
  | 'CONFLICT'
  /** La etapa exige autenticación fuerte y reciente que la sesión no prueba. */
  | 'STEP_UP_REQUIRED';

export type RoleAdministrationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: RoleAdministrationFailure };

class Abort extends Error {
  public constructor(public readonly failure: RoleAdministrationFailure) {
    super(failure);
    this.name = 'RoleAdministrationAbort';
  }
}

const fail = <T>(failure: RoleAdministrationFailure): RoleAdministrationResult<T> => ({
  ok: false,
  failure,
});

/** Ejecuta la unidad de trabajo; un `Abort` la deshace y se traduce en resultado. */
async function inUnitOfWork<T>(
  deps: Pick<RoleAdministrationDependencies, 'administration'>,
  work: (context: RoleAdministrationContext) => Promise<T>,
): Promise<RoleAdministrationResult<T>> {
  try {
    return { ok: true, value: await deps.administration.run(work) };
  } catch (error) {
    if (error instanceof Abort) return fail(error.failure);
    throw error;
  }
}

async function rosterFresh(deps: RoleAdministrationDependencies): Promise<boolean> {
  const state = await deps.directory.store.syncState(deps.tenantId, deps.directory.groupId);
  return isRoleRosterFresh(state, deps.now(), deps.directory.intervalMs);
}

/** Miembro vigente del grupo exacto configurado, con la cuenta habilitada. */
async function activeMember(deps: RoleAdministrationDependencies, oid: string): Promise<boolean> {
  const member = await deps.directory.store.member(
    deps.tenantId,
    deps.directory.groupId,
    oid.toLowerCase(),
  );
  return member?.membership === 'member' && member.accountEnabled === true;
}

function approversFor(
  deps: RoleAdministrationDependencies,
  stage: 'access' | 'security',
): readonly string[] {
  return (
    (stage === 'access' ? deps.config?.accessApproverOids : deps.config?.securityApproverOids) ?? []
  );
}

/** Hay alguien declarado para cada etapa que el rol necesita. */
function approvalPathConfigured(deps: RoleAdministrationDependencies, role: RequestableRole) {
  return (
    approversFor(deps, 'access').length > 0 &&
    (!isPrivilegedRole(role) || approversFor(deps, 'security').length > 0)
  );
}

function mayApprove(
  deps: RoleAdministrationDependencies,
  actor: RoleAdministrationActor,
  stage: 'access' | 'security',
): boolean {
  const capability = stage === 'access' ? 'roles.approve' : 'roles.approve.privileged';
  return (
    actor.oid !== undefined &&
    actor.capabilities.has(capability) &&
    approversFor(deps, stage).includes(actor.oid.toLowerCase())
  );
}

function hasStrongAmr(actor: RoleAdministrationActor): boolean {
  return actor.amr.some((value) => (MFA_AMR_VALUES as readonly string[]).includes(value));
}

/**
 * Evidencia de autenticación fuerte **y reciente** para la etapa de Seguridad. La sesión trae
 * `amr` (método) pero no `auth_time` ni una reautenticación propia: la hora de creación de la
 * sesión no prueba que el IdP haya pedido credenciales (puede venir de SSO). Hasta que el flujo de
 * autenticación lo registre, no hay evidencia suficiente y la etapa falla cerrada.
 */
function hasRecentStrongAuthentication(
  deps: RoleAdministrationDependencies,
  actor: RoleAdministrationActor,
): boolean {
  return hasStrongAmr(actor) && (deps.stepUp?.(actor) ?? false);
}

function userActor(actor: RoleAdministrationActor): AuditEventDraft['actor'] {
  return { id: actor.subjectId, type: 'user', sessionId: actor.sessionId };
}

function requestMetadata(request: RoleRequest) {
  return {
    requestId: request.id,
    targetOid: request.targetOid,
    action: request.action,
    role: request.role,
    status: request.status,
    revision: request.revision,
    ...(request.ticket ? { ticket: request.ticket } : {}),
  };
}

/* ------------------------------------------------------------------ Solicitar */

export interface RoleRequestInput {
  readonly targetOid: string;
  readonly action: RoleRequestAction;
  readonly role: RequestableRole;
  readonly reason: string;
  readonly ticket: string | null;
  readonly expectedRevision: number;
}

export async function submitRoleRequest(
  deps: RoleAdministrationDependencies,
  actor: RoleAdministrationActor,
  input: RoleRequestInput,
  correlationId: string,
): Promise<RoleAdministrationResult<RoleRequest>> {
  if (!actor.capabilities.has('roles.request') || !actor.oid) return fail('UNAVAILABLE');
  if (!approvalPathConfigured(deps, input.role) || !(await rosterFresh(deps))) {
    return fail('UNAVAILABLE');
  }
  const target = input.targetOid.toLowerCase();
  if (!(await activeMember(deps, actor.oid))) return fail('UNAVAILABLE');
  if (!(await activeMember(deps, target))) return fail('UNAVAILABLE');
  if (actor.oid.toLowerCase() === target) return fail('CONFLICT');
  const requester = { oid: actor.oid, subjectId: actor.subjectId };
  return inUnitOfWork(deps, async ({ grants, requests, audit }) => {
    const at = deps.now();
    const grant = await grants.current(deps.tenantId, target);
    if (grant.revision !== input.expectedRevision) throw new Abort('CONFLICT');
    const planned = openRoleRequest({
      tenantId: deps.tenantId,
      id: randomUUID(),
      targetOid: target,
      action: input.action,
      role: input.role,
      reason: input.reason,
      ticket: input.ticket,
      expectedGrantRevision: grant.revision,
      currentRoles: grant.roles,
      requester,
      at,
    });
    if (!planned.ok) throw new Abort('CONFLICT');
    if (!(await requests.insert(planned.request))) throw new Abort('CONFLICT');
    await recordAudit(audit, {
      id: randomUUID(),
      tenantId: deps.tenantId,
      occurredAt: at,
      actor: userActor(actor),
      action: 'access.role_request.submitted',
      resource: { type: 'role_request', id: planned.request.id },
      outcome: 'succeeded',
      correlationId,
      reason: input.reason,
      metadata: { ...requestMetadata(planned.request), grantRevision: grant.revision },
    });
    return planned.request;
  });
}

/* ------------------------------------------------------------- Aprobar/rechazar */

export interface RoleDecisionInput {
  readonly requestId: string;
  readonly decision: 'approve' | 'reject';
  readonly expectedRevision: number;
  readonly reason: string;
}

export interface RoleDecisionOutcome {
  readonly request: RoleRequest;
  /** Presente solo si esta decisión cambió el grant (aprobación final). */
  readonly grant?: { readonly roles: readonly string[]; readonly revision: number };
}

export async function decideRoleRequest(
  deps: RoleAdministrationDependencies,
  actor: RoleAdministrationActor,
  input: RoleDecisionInput,
  correlationId: string,
): Promise<RoleAdministrationResult<RoleDecisionOutcome>> {
  if (!actor.oid) return fail('UNAVAILABLE');
  const current = await deps.administration.requests.byId(deps.tenantId, input.requestId);
  const stage = current ? pendingStage(current) : undefined;
  // Quien no puede resolver la etapa actual no distingue inexistente de ajeno ni de cerrado.
  if (!current || !stage || !mayApprove(deps, actor, stage)) return fail('UNAVAILABLE');
  if (!(await rosterFresh(deps)) || !(await activeMember(deps, actor.oid))) {
    return fail('UNAVAILABLE');
  }
  // Entre ciclos del padrón, una baja todavía no canceló la solicitud: se revalida aquí.
  const stillMembers = [
    current.targetOid,
    current.requesterOid,
    ...(current.accessApproval ? [current.accessApproval.oid] : []),
  ];
  for (const oid of stillMembers) {
    if (!(await activeMember(deps, oid))) return fail('CONFLICT');
  }
  // La etapa de Acceso no exige AMR propio (ADR-017 pide step-up solo para lo privilegiado); el
  // inicio de sesión ya aplicó la política MFA/passkey. La de Seguridad sí, más evidencia reciente.
  const approver = { oid: actor.oid, subjectId: actor.subjectId };

  if (
    input.decision === 'approve' &&
    stage === 'security' &&
    !hasRecentStrongAuthentication(deps, actor)
  ) {
    // Sin cambio de estado; el intento queda auditado para revisión.
    const denied = await inUnitOfWork(deps, async ({ requests, audit }) => {
      const request = await requests.byId(deps.tenantId, input.requestId);
      if (!request || request.revision !== input.expectedRevision) throw new Abort('CONFLICT');
      if (!approveRoleRequest(request, 'security', approver, input.reason, deps.now()).ok) {
        throw new Abort('CONFLICT');
      }
      await recordAudit(audit, {
        id: randomUUID(),
        tenantId: deps.tenantId,
        occurredAt: deps.now(),
        actor: userActor(actor),
        action: 'access.role_request.step_up_required',
        resource: { type: 'role_request', id: request.id },
        outcome: 'denied',
        correlationId,
        reason: input.reason,
        metadata: { ...requestMetadata(request), stage: 'security' },
      });
    });
    return denied.ok ? fail('STEP_UP_REQUIRED') : denied;
  }

  return inUnitOfWork(deps, async ({ grants, requests, audit }) => {
    const at = deps.now();
    const request = await requests.byId(deps.tenantId, input.requestId);
    if (!request || request.revision !== input.expectedRevision) throw new Abort('CONFLICT');
    const planned =
      input.decision === 'approve'
        ? approveRoleRequest(request, stage, approver, input.reason, at)
        : rejectRoleRequest(request, stage, approver, input.reason, at);
    if (!planned.ok) throw new Abort('CONFLICT');
    const next = planned.request;

    let grantChange: RoleDecisionOutcome['grant'];
    let grantMetadata: Record<string, unknown> = {};
    if (next.status === 'approved') {
      const before = await grants.current(deps.tenantId, request.targetOid);
      // La revisión que vio el solicitante: si el grant cambió desde entonces, nadie decide a ciegas.
      if (before.revision !== request.expectedGrantRevision) throw new Abort('CONFLICT');
      const roles = rolesAfter(before.roles, request.action, request.role);
      if (!roles) throw new Abort('CONFLICT');
      const after = await grants.replace(deps.tenantId, request.targetOid, {
        roles,
        expectedRevision: before.revision,
        actorId: actor.subjectId,
        at,
      });
      if (!after) throw new Abort('CONFLICT');
      grantChange = { roles: after.roles, revision: after.revision };
      grantMetadata = {
        grantBefore: { roles: [...before.roles], revision: before.revision },
        grantAfter: { roles: [...after.roles], revision: after.revision },
      };
    }
    if (!(await requests.update(next, request.revision))) throw new Abort('CONFLICT');
    await recordAudit(audit, {
      id: randomUUID(),
      tenantId: deps.tenantId,
      occurredAt: at,
      actor: userActor(actor),
      action:
        input.decision === 'reject'
          ? 'access.role_request.rejected'
          : next.status === 'approved'
            ? 'access.role_request.approved'
            : 'access.role_request.stage_approved',
      resource: { type: 'role_request', id: next.id },
      outcome: 'succeeded',
      correlationId,
      reason: input.reason,
      metadata: { ...requestMetadata(next), stage, ...grantMetadata },
    });
    return { request: next, ...(grantChange ? { grant: grantChange } : {}) };
  });
}

/* ------------------------------------------------------------ Bajas del padrón */

/**
 * Quien salió del grupo pierde sus grants dinámicos y sus solicitudes abiertas (como objetivo,
 * solicitante o aprobador de Acceso) se cancelan: si vuelve a entrar, no recupera nada sin una
 * solicitud y aprobación nuevas. Idempotente: corre en cada ciclo confirmado del padrón; un
 * conflicto se reintenta en el siguiente. Devuelve cuántas personas se limpiaron.
 */
export async function clearRemovedMembers(
  deps: Pick<RoleAdministrationDependencies, 'administration' | 'tenantId' | 'now'>,
  oids: readonly string[],
): Promise<number> {
  let cleared = 0;
  for (const oid of new Set(oids.map((value) => value.toLowerCase()))) {
    const [grant, open] = await Promise.all([
      deps.administration.grants.current(deps.tenantId, oid),
      deps.administration.requests.openInvolving(deps.tenantId, oid),
    ]);
    if (grant.roles.length === 0 && open.length === 0) continue;
    const result = await inUnitOfWork(deps, async ({ grants, requests, audit }) => {
      const at = deps.now();
      const correlationId = randomUUID();
      const before = await grants.current(deps.tenantId, oid);
      if (before.roles.length > 0) {
        const after = await grants.replace(deps.tenantId, oid, {
          roles: [],
          expectedRevision: before.revision,
          actorId: SYSTEM_ACTOR,
          at,
        });
        if (!after) throw new Abort('CONFLICT');
        await recordAudit(audit, {
          id: randomUUID(),
          tenantId: deps.tenantId,
          occurredAt: at,
          actor: { id: SYSTEM_ACTOR, type: 'service' },
          action: 'access.role_grant.cleared',
          resource: { type: 'role_grant', id: oid },
          outcome: 'succeeded',
          correlationId,
          reason: 'membership_removed',
          metadata: {
            targetOid: oid,
            grantBefore: { roles: [...before.roles], revision: before.revision },
            grantAfter: { roles: [], revision: after.revision },
          },
        });
      }
      for (const request of await requests.openInvolving(deps.tenantId, oid)) {
        const cancelled = cancelRoleRequest(request, SYSTEM_ACTOR, 'membership_removed', at);
        if (!(await requests.update(cancelled, request.revision))) throw new Abort('CONFLICT');
        await recordAudit(audit, {
          id: randomUUID(),
          tenantId: deps.tenantId,
          occurredAt: at,
          actor: { id: SYSTEM_ACTOR, type: 'service' },
          action: 'access.role_request.cancelled',
          resource: { type: 'role_request', id: request.id },
          outcome: 'succeeded',
          correlationId,
          reason: 'membership_removed',
          metadata: { ...requestMetadata(cancelled), removedOid: oid },
        });
      }
    });
    if (result.ok) cleared += 1;
  }
  return cleared;
}
