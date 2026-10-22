/**
 * Solicitudes de cambio de rol con aprobación separada (entra-soc-user-admin.md, ADR-017).
 *
 * Nadie cambia un grant directamente. Una persona con `roles.request` pide conceder o retirar
 * uno de los cuatro roles runtime a otro miembro del padrón; la solicitud queda pendiente hasta
 * que la resuelven aprobadores distintos:
 *
 * - etapa de Acceso (`roles.approve`) para todo rol;
 * - etapa de Seguridad (`roles.approve.privileged`) además, para `qapaq.platform.admin`.
 *
 * Solicitante, objetivo y cada aprobador son personas distintas (por `oid`). Solo la aprobación
 * final cambia el grant, y lo hace bajo compare-and-set sobre la revisión que vio el solicitante:
 * si el grant cambió desde entonces, la aprobación es un conflicto y no escribe nada.
 *
 * Este archivo contiene las reglas (funciones puras) y los puertos. El grant, la solicitud y el
 * AuditEvent sellado de cada paso se escriben en una sola unidad de trabajo
 * (`RoleAdministration.run`): o queda todo, o nada.
 */

import type { AuditStore } from '@qapaq/audit';

import { PRIVILEGED_ROLES, REQUESTABLE_ROLES, type RequestableRole } from './capabilities.js';
import { InMemoryRoleGrantStore, normalizeGrantRoles, type RoleGrantStore } from './role-grants.js';

export const ROLE_REQUEST_ACTIONS = ['grant', 'revoke'] as const;
export type RoleRequestAction = (typeof ROLE_REQUEST_ACTIONS)[number];

export const ROLE_REQUEST_STATUSES = [
  'pending_access',
  'pending_security',
  'approved',
  'rejected',
  'cancelled',
] as const;
export type RoleRequestStatus = (typeof ROLE_REQUEST_STATUSES)[number];
export const OPEN_ROLE_REQUEST_STATUSES: readonly RoleRequestStatus[] = [
  'pending_access',
  'pending_security',
];

export interface RoleRequestDecision {
  /** OID de Entra (minúsculas) de quien decidió. */
  readonly oid: string;
  readonly subjectId: string;
  readonly at: Date;
  readonly reason: string;
}

export interface RoleRequestClosure {
  /** `null` cuando cierra el sistema (baja del padrón), no una persona. */
  readonly oid: string | null;
  readonly actorId: string;
  readonly at: Date;
  readonly reason: string;
}

export interface RoleRequest {
  readonly tenantId: string;
  readonly id: string;
  readonly targetOid: string;
  readonly action: RoleRequestAction;
  readonly role: RequestableRole;
  readonly reason: string;
  readonly ticket: string | null;
  /** Revisión del grant que vio el solicitante; la aprobación final la exige. */
  readonly expectedGrantRevision: number;
  readonly requesterOid: string;
  readonly requesterSubjectId: string;
  readonly createdAt: Date;
  readonly status: RoleRequestStatus;
  readonly accessApproval: RoleRequestDecision | null;
  readonly securityApproval: RoleRequestDecision | null;
  /** Rechazo o cancelación. */
  readonly closure: RoleRequestClosure | null;
  /** Avanza en cada cambio de estado (CAS). */
  readonly revision: number;
  readonly updatedAt: Date;
}

export interface RoleRequestActor {
  readonly oid: string;
  readonly subjectId: string;
}

export type RoleRequestDenial =
  /** Solicitante, objetivo o aprobadores repetidos. */
  | 'NOT_DISTINCT'
  /** La solicitud ya no está en la etapa que se intenta resolver. */
  | 'WRONG_STAGE'
  /** Conceder un rol que ya tiene o retirar uno que no tiene. */
  | 'NO_CHANGE';

export type RoleRequestResult =
  | { readonly ok: true; readonly request: RoleRequest }
  | { readonly ok: false; readonly reason: RoleRequestDenial };

export function isRequestableRole(value: unknown): value is RequestableRole {
  return typeof value === 'string' && (REQUESTABLE_ROLES as readonly string[]).includes(value);
}

export function isPrivilegedRole(role: RequestableRole): boolean {
  return PRIVILEGED_ROLES.includes(role);
}

export function isOpenRoleRequest(request: RoleRequest): boolean {
  return OPEN_ROLE_REQUEST_STATUSES.includes(request.status);
}

/** Etapa que resuelve la solicitud ahora; `undefined` si ya está cerrada. */
export function pendingStage(request: RoleRequest): 'access' | 'security' | undefined {
  if (request.status === 'pending_access') return 'access';
  if (request.status === 'pending_security') return 'security';
  return undefined;
}

/**
 * Roles del grant tras aplicar la acción, o `undefined` si no cambiaría nada. Conceder un rol que
 * ya está, o retirar uno que no está, no es un cambio válido: se rechaza en vez de auditar un no-op.
 */
export function rolesAfter(
  current: readonly string[],
  action: RoleRequestAction,
  role: RequestableRole,
): string[] | undefined {
  const has = current.includes(role);
  if (action === 'grant') return has ? undefined : normalizeGrantRoles([...current, role]);
  return has ? normalizeGrantRoles(current.filter((value) => value !== role)) : undefined;
}

export function openRoleRequest(input: {
  readonly tenantId: string;
  readonly id: string;
  readonly targetOid: string;
  readonly action: RoleRequestAction;
  readonly role: RequestableRole;
  readonly reason: string;
  readonly ticket: string | null;
  readonly expectedGrantRevision: number;
  readonly currentRoles: readonly string[];
  readonly requester: RoleRequestActor;
  readonly at: Date;
}): RoleRequestResult {
  const target = input.targetOid.toLowerCase();
  const requester = input.requester.oid.toLowerCase();
  if (requester === target) return { ok: false, reason: 'NOT_DISTINCT' };
  if (!rolesAfter(input.currentRoles, input.action, input.role)) {
    return { ok: false, reason: 'NO_CHANGE' };
  }
  return {
    ok: true,
    request: {
      tenantId: input.tenantId,
      id: input.id,
      targetOid: target,
      action: input.action,
      role: input.role,
      reason: input.reason,
      ticket: input.ticket,
      expectedGrantRevision: input.expectedGrantRevision,
      requesterOid: requester,
      requesterSubjectId: input.requester.subjectId,
      createdAt: input.at,
      status: 'pending_access',
      accessApproval: null,
      securityApproval: null,
      closure: null,
      revision: 1,
      updatedAt: input.at,
    },
  };
}

/** Personas que ya participaron y no pueden resolver la etapa pendiente. */
function participants(request: RoleRequest): string[] {
  return [
    request.requesterOid,
    request.targetOid,
    ...(request.accessApproval ? [request.accessApproval.oid] : []),
  ];
}

/**
 * Aprueba la etapa pendiente. Acceso pasa a Seguridad si el rol es privilegiado; si no, la
 * solicitud queda aprobada. Seguridad siempre la deja aprobada.
 */
export function approveRoleRequest(
  request: RoleRequest,
  stage: 'access' | 'security',
  approver: RoleRequestActor,
  reason: string,
  at: Date,
): RoleRequestResult {
  if (pendingStage(request) !== stage) return { ok: false, reason: 'WRONG_STAGE' };
  const oid = approver.oid.toLowerCase();
  if (participants(request).includes(oid)) return { ok: false, reason: 'NOT_DISTINCT' };
  const decision: RoleRequestDecision = { oid, subjectId: approver.subjectId, at, reason };
  const next: RoleRequest =
    stage === 'access'
      ? {
          ...request,
          accessApproval: decision,
          status: isPrivilegedRole(request.role) ? 'pending_security' : 'approved',
        }
      : { ...request, securityApproval: decision, status: 'approved' };
  return { ok: true, request: { ...next, revision: request.revision + 1, updatedAt: at } };
}

/** Rechazo por quien puede resolver la etapa pendiente; también debe ser alguien distinto. */
export function rejectRoleRequest(
  request: RoleRequest,
  stage: 'access' | 'security',
  approver: RoleRequestActor,
  reason: string,
  at: Date,
): RoleRequestResult {
  if (pendingStage(request) !== stage) return { ok: false, reason: 'WRONG_STAGE' };
  const oid = approver.oid.toLowerCase();
  if (participants(request).includes(oid)) return { ok: false, reason: 'NOT_DISTINCT' };
  return {
    ok: true,
    request: {
      ...request,
      status: 'rejected',
      closure: { oid, actorId: approver.subjectId, at, reason },
      revision: request.revision + 1,
      updatedAt: at,
    },
  };
}

/** Cierre por el sistema (p. ej. baja del padrón de alguno de los participantes). */
export function cancelRoleRequest(
  request: RoleRequest,
  actorId: string,
  reason: string,
  at: Date,
): RoleRequest {
  return {
    ...request,
    status: 'cancelled',
    closure: { oid: null, actorId, at, reason },
    revision: request.revision + 1,
    updatedAt: at,
  };
}

/* ---------------------------------------------------------------------- Puertos */

/** Persistencia de solicitudes. Todas las operaciones filtran por tenant. */
export interface RoleRequestStore {
  byId(tenantId: string, id: string): Promise<RoleRequest | undefined>;
  /** Más recientes primero; acotado por el adapter. */
  list(tenantId: string, statuses: readonly RoleRequestStatus[]): Promise<readonly RoleRequest[]>;
  /** Abiertas donde `oid` es objetivo, solicitante o aprobador de Acceso. */
  openInvolving(tenantId: string, oid: string): Promise<readonly RoleRequest[]>;
  /** `false` si ya hay una abierta para el mismo objetivo y rol: no se duplican. */
  insert(request: RoleRequest): Promise<boolean>;
  /** Compare-and-set sobre `revision`; `false` si otra escritura se adelantó. */
  update(request: RoleRequest, expectedRevision: number): Promise<boolean>;
}

export interface RoleAdministrationContext {
  readonly grants: RoleGrantStore;
  readonly requests: RoleRequestStore;
  /** La misma cadena de auditoría del SOC, dentro de la misma transacción. */
  readonly audit: AuditStore;
}

export interface RoleAdministration {
  /** Lecturas fuera de transacción (inicio de sesión, vistas). */
  readonly grants: RoleGrantStore;
  readonly requests: Pick<RoleRequestStore, 'byId' | 'list' | 'openInvolving'>;
  /** Unidad de trabajo: grant, solicitud y auditoría se confirman juntos o no se confirman. */
  run<T>(work: (context: RoleAdministrationContext) => Promise<T>): Promise<T>;
}

/* ---------------------------------------------------------------- En memoria */

/** Tope de filas por lectura, igual que el adapter PostgreSQL. */
export const ROLE_REQUEST_LIST_LIMIT = 500;

export class InMemoryRoleRequestStore implements RoleRequestStore {
  private rows = new Map<string, RoleRequest>();

  private static key(tenantId: string, id: string): string {
    return `${tenantId}\u0000${id}`;
  }

  public snapshot(): ReadonlyMap<string, RoleRequest> {
    return new Map(this.rows);
  }

  public restore(snapshot: ReadonlyMap<string, RoleRequest>): void {
    this.rows = new Map(snapshot);
  }

  public byId(tenantId: string, id: string): Promise<RoleRequest | undefined> {
    return Promise.resolve(this.rows.get(InMemoryRoleRequestStore.key(tenantId, id)));
  }

  public list(
    tenantId: string,
    statuses: readonly RoleRequestStatus[],
  ): Promise<readonly RoleRequest[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((row) => row.tenantId === tenantId && statuses.includes(row.status))
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .slice(0, ROLE_REQUEST_LIST_LIMIT),
    );
  }

  public openInvolving(tenantId: string, oid: string): Promise<readonly RoleRequest[]> {
    const key = oid.toLowerCase();
    return Promise.resolve(
      [...this.rows.values()].filter(
        (row) =>
          row.tenantId === tenantId &&
          isOpenRoleRequest(row) &&
          (row.targetOid === key ||
            row.requesterOid === key ||
            row.accessApproval?.oid === key),
      ),
    );
  }

  public insert(request: RoleRequest): Promise<boolean> {
    const duplicate = [...this.rows.values()].some(
      (row) =>
        row.tenantId === request.tenantId &&
        row.targetOid === request.targetOid &&
        row.role === request.role &&
        isOpenRoleRequest(row),
    );
    const key = InMemoryRoleRequestStore.key(request.tenantId, request.id);
    if (duplicate || this.rows.has(key)) return Promise.resolve(false);
    this.rows.set(key, request);
    return Promise.resolve(true);
  }

  public update(request: RoleRequest, expectedRevision: number): Promise<boolean> {
    const key = InMemoryRoleRequestStore.key(request.tenantId, request.id);
    const stored = this.rows.get(key);
    if (!stored || stored.revision !== expectedRevision) return Promise.resolve(false);
    this.rows.set(key, request);
    return Promise.resolve(true);
  }
}

/**
 * Unidad de trabajo en memoria (specs y desarrollo). `runAudit` abre la unidad de trabajo dueña
 * de la cadena de auditoría (la del SOC en memoria, que deshace su auditoría si algo falla, también
 * en el commit); aquí se deshacen grants y solicitudes. Las unidades se serializan para que un
 * deshacer no pise el trabajo de otra.
 */
export class InMemoryRoleAdministration implements RoleAdministration {
  public readonly grants = new InMemoryRoleGrantStore();
  public readonly requests = new InMemoryRoleRequestStore();
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly runAudit: <T>(work: (audit: AuditStore) => Promise<T>) => Promise<T>,
  ) {}

  public run<T>(work: (context: RoleAdministrationContext) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const grants = this.grants.snapshot();
      const requests = this.requests.snapshot();
      try {
        return await this.runAudit((audit) =>
          work({ grants: this.grants, requests: this.requests, audit }),
        );
      } catch (error) {
        this.grants.restore(grants);
        this.requests.restore(requests);
        throw error;
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
