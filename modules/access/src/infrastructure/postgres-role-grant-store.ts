/**
 * Adapter PostgreSQL de la administración de roles: grants dinámicos y solicitudes con aprobación.
 *
 * La unidad de trabajo es la existente del SOC (`PrismaSocUnitOfWork`): el grant, la solicitud y
 * el AuditEvent sellado comparten transacción y cadena de auditoría (`audit_events`, con el
 * advisory lock por tenant de `PrismaAuditStore`). Si algo falla, no queda ni grant sin auditoría
 * ni auditoría de un cambio que no ocurrió.
 *
 * Traduce filas planas (`@qapaq/database`) al dominio y valida lo leído contra los catálogos de
 * este módulo: un valor desconocido en la base es un error de integridad, no algo que se descarta
 * en silencio ni que se concede.
 */

import type { AuditStore, SealedAuditEvent } from '@qapaq/audit';
import {
  closeDatabaseClient,
  createDatabaseClient,
  PrismaRoleGrantStore,
  PrismaRoleRequestStore,
  PrismaSocUnitOfWork,
  type DatabaseConnectionOptions,
  type PrismaAuditStore,
  type RoleGrantRow,
  type RoleRequestRow,
  type SealedAuditRow,
} from '@qapaq/database';

import { REQUESTABLE_ROLES } from '../capabilities.js';
import {
  emptyRoleGrant,
  normalizeGrantRoles,
  type RoleGrant,
  type RoleGrantStore,
} from '../role-grants.js';
import {
  ROLE_REQUEST_ACTIONS,
  ROLE_REQUEST_STATUSES,
  type RoleAdministration,
  type RoleAdministrationContext,
  type RoleRequest,
  type RoleRequestDecision,
  type RoleRequestStore,
} from '../role-requests.js';

export class RoleGrantIntegrityError extends Error {
  public constructor(public readonly column: string) {
    super(`Valor fuera de catálogo en ${column}.`);
    this.name = 'RoleGrantIntegrityError';
  }
}

function oneOf<T extends string>(catalog: readonly T[], value: string, column: string): T {
  if (!(catalog as readonly string[]).includes(value)) throw new RoleGrantIntegrityError(column);
  return value as T;
}

function toGrant(row: RoleGrantRow): RoleGrant {
  for (const role of row.roles) oneOf(REQUESTABLE_ROLES, role, 'access_role_grants.roles');
  return {
    tenantId: row.tenantId,
    oid: row.oid.toLowerCase(),
    roles: normalizeGrantRoles(row.roles),
    revision: row.revision,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

function grantPort(store: PrismaRoleGrantStore): RoleGrantStore {
  return {
    current: async (tenantId, oid) => {
      const row = await store.current(tenantId, oid.toLowerCase());
      return row ? toGrant(row) : emptyRoleGrant(tenantId, oid);
    },
    list: async (tenantId) => (await store.list(tenantId)).map(toGrant),
    replace: async (tenantId, oid, change) => {
      const row = await store.replace(
        tenantId,
        oid.toLowerCase(),
        normalizeGrantRoles(change.roles),
        change.expectedRevision,
        change.actorId,
        change.at,
      );
      return row ? toGrant(row) : undefined;
    },
  };
}

function decision(
  oid: string | null,
  subjectId: string | null,
  at: Date | null,
  reason: string | null,
): RoleRequestDecision | null {
  return oid && subjectId && at && reason
    ? { oid: oid.toLowerCase(), subjectId, at, reason }
    : null;
}

function toRequest(row: RoleRequestRow): RoleRequest {
  return {
    tenantId: row.tenantId,
    id: row.id,
    targetOid: row.targetOid.toLowerCase(),
    action: oneOf(ROLE_REQUEST_ACTIONS, row.action, 'access_role_requests.action'),
    role: oneOf(REQUESTABLE_ROLES, row.role, 'access_role_requests.role'),
    reason: row.reason,
    ticket: row.ticket,
    expectedGrantRevision: row.expectedGrantRevision,
    requesterOid: row.requesterOid.toLowerCase(),
    requesterSubjectId: row.requesterSubjectId,
    createdAt: row.createdAt,
    status: oneOf(ROLE_REQUEST_STATUSES, row.status, 'access_role_requests.status'),
    accessApproval: decision(
      row.accessApproverOid,
      row.accessApproverSubjectId,
      row.accessApprovedAt,
      row.accessReason,
    ),
    securityApproval: decision(
      row.securityApproverOid,
      row.securityApproverSubjectId,
      row.securityApprovedAt,
      row.securityReason,
    ),
    closure:
      row.closedAt && row.closedBy && row.closedReason
        ? {
            oid: row.closedByOid?.toLowerCase() ?? null,
            actorId: row.closedBy,
            at: row.closedAt,
            reason: row.closedReason,
          }
        : null,
    revision: row.revision,
    updatedAt: row.updatedAt,
  };
}

function fromRequest(request: RoleRequest): RoleRequestRow {
  return {
    tenantId: request.tenantId,
    id: request.id,
    targetOid: request.targetOid,
    action: request.action,
    role: request.role,
    reason: request.reason,
    ticket: request.ticket,
    expectedGrantRevision: request.expectedGrantRevision,
    requesterOid: request.requesterOid,
    requesterSubjectId: request.requesterSubjectId,
    createdAt: request.createdAt,
    status: request.status,
    accessApproverOid: request.accessApproval?.oid ?? null,
    accessApproverSubjectId: request.accessApproval?.subjectId ?? null,
    accessApprovedAt: request.accessApproval?.at ?? null,
    accessReason: request.accessApproval?.reason ?? null,
    securityApproverOid: request.securityApproval?.oid ?? null,
    securityApproverSubjectId: request.securityApproval?.subjectId ?? null,
    securityApprovedAt: request.securityApproval?.at ?? null,
    securityReason: request.securityApproval?.reason ?? null,
    closedByOid: request.closure?.oid ?? null,
    closedBy: request.closure?.actorId ?? null,
    closedAt: request.closure?.at ?? null,
    closedReason: request.closure?.reason ?? null,
    revision: request.revision,
    updatedAt: request.updatedAt,
  };
}

function requestPort(store: PrismaRoleRequestStore): RoleRequestStore {
  return {
    byId: async (tenantId, id) => {
      const row = await store.byId(tenantId, id);
      return row ? toRequest(row) : undefined;
    },
    list: async (tenantId, statuses) => (await store.list(tenantId, statuses)).map(toRequest),
    openInvolving: async (tenantId, oid) =>
      (await store.openInvolving(tenantId, oid.toLowerCase())).map(toRequest),
    insert: (request) => store.insert(fromRequest(request)),
    update: (request, expectedRevision) => store.update(fromRequest(request), expectedRevision),
  };
}

/**
 * Misma traducción que el adapter SOC: la fila de auditoría y el evento sellado tienen la misma
 * forma, solo difiere el tipo de `metadata`.
 */
function auditPort(store: PrismaAuditStore): AuditStore {
  return {
    head: (tenantId) => store.head(tenantId),
    append: (event: SealedAuditEvent) => store.append(event as SealedAuditRow),
    read: async (query) => {
      const page = await store.read(query);
      return { events: page.events as readonly SealedAuditEvent[], nextCursor: page.nextCursor };
    },
    range: async (tenantId, fromSequence, limit) =>
      (await store.range(tenantId, fromSequence, limit)) as readonly SealedAuditEvent[],
  };
}

export class PostgresRoleAdministration implements RoleAdministration {
  public readonly grants: RoleGrantStore;
  public readonly requests: RoleRequestStore;
  private readonly unitOfWork: PrismaSocUnitOfWork;

  private constructor(
    client: ReturnType<typeof createDatabaseClient>,
    private readonly closeClient: () => Promise<void>,
  ) {
    this.grants = grantPort(new PrismaRoleGrantStore(client));
    this.requests = requestPort(new PrismaRoleRequestStore(client));
    this.unitOfWork = new PrismaSocUnitOfWork(client);
  }

  public static connect(options: DatabaseConnectionOptions): PostgresRoleAdministration {
    const client = createDatabaseClient(options);
    return new PostgresRoleAdministration(client, () => closeDatabaseClient(client));
  }

  public run<T>(work: (context: RoleAdministrationContext) => Promise<T>): Promise<T> {
    return this.unitOfWork.run((stores) =>
      work({
        grants: grantPort(new PrismaRoleGrantStore(stores.tx)),
        requests: requestPort(new PrismaRoleRequestStore(stores.tx)),
        audit: auditPort(stores.audit),
      }),
    );
  }

  public close(): Promise<void> {
    return this.closeClient();
  }
}
