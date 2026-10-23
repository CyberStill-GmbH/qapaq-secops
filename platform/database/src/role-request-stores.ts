/**
 * Solicitudes de cambio de rol en PostgreSQL.
 *
 * - `insert` usa `ON CONFLICT DO NOTHING`: el índice único parcial (una abierta por objetivo y rol)
 *   resuelve la carrera sin abortar la transacción en curso.
 * - `update` es compare-and-set sobre `revision`.
 * - Las restricciones de la migración repiten las reglas del dominio (distinción de personas,
 *   etapas, rol privilegiado), así que una fila inválida no se puede escribir ni desde aquí.
 *
 * Filas planas; el dominio (`RoleRequestStore`) vive en `modules/access`. Acepta el cliente o la
 * transacción de `PrismaSocUnitOfWork`.
 */

import type { Prisma, PrismaClient } from '../generated/client/client.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface RoleRequestRow {
  readonly tenantId: string;
  readonly id: string;
  readonly targetOid: string;
  readonly action: string;
  readonly role: string;
  readonly reason: string;
  readonly ticket: string | null;
  readonly expectedGrantRevision: number;
  readonly requesterOid: string;
  readonly requesterSubjectId: string;
  readonly createdAt: Date;
  readonly status: string;
  readonly accessApproverOid: string | null;
  readonly accessApproverSubjectId: string | null;
  readonly accessApprovedAt: Date | null;
  readonly accessReason: string | null;
  readonly securityApproverOid: string | null;
  readonly securityApproverSubjectId: string | null;
  readonly securityApprovedAt: Date | null;
  readonly securityReason: string | null;
  readonly closedByOid: string | null;
  readonly closedBy: string | null;
  readonly closedAt: Date | null;
  readonly closedReason: string | null;
  readonly revision: number;
  readonly updatedAt: Date;
}

/** Tope de filas por lectura: la bandeja de solicitudes es chica; más indica un error. */
export const ROLE_REQUEST_QUERY_LIMIT = 500;

const OPEN_STATUSES = ['pending_access', 'pending_security'];

export class PrismaRoleRequestStore {
  public constructor(private readonly client: Db) {}

  public async byId(tenantId: string, id: string): Promise<RoleRequestRow | undefined> {
    const row = await this.client.accessRoleRequest.findUnique({
      where: { tenantId_id: { tenantId, id } },
    });
    return row ?? undefined;
  }

  public list(tenantId: string, statuses: readonly string[]): Promise<readonly RoleRequestRow[]> {
    return this.client.accessRoleRequest.findMany({
      where: { tenantId, status: { in: [...statuses] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: ROLE_REQUEST_QUERY_LIMIT,
    });
  }

  public openInvolving(tenantId: string, oid: string): Promise<readonly RoleRequestRow[]> {
    return this.client.accessRoleRequest.findMany({
      where: {
        tenantId,
        status: { in: OPEN_STATUSES },
        OR: [
          { targetOid: oid },
          { requesterOid: oid },
          { accessApproverOid: oid },
          { securityApproverOid: oid },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: ROLE_REQUEST_QUERY_LIMIT,
    });
  }

  /** `false` si ya existe el id o una abierta para el mismo objetivo y rol. */
  public async insert(row: RoleRequestRow): Promise<boolean> {
    const created = await this.client.accessRoleRequest.createMany({
      data: [{ ...row }],
      skipDuplicates: true,
    });
    return created.count === 1;
  }

  /** Compare-and-set: `false` si la revisión guardada no es `expectedRevision`. */
  public async update(row: RoleRequestRow, expectedRevision: number): Promise<boolean> {
    const updated = await this.client.accessRoleRequest.updateMany({
      where: { tenantId: row.tenantId, id: row.id, revision: expectedRevision },
      data: {
        status: row.status,
        accessApproverOid: row.accessApproverOid,
        accessApproverSubjectId: row.accessApproverSubjectId,
        accessApprovedAt: row.accessApprovedAt,
        accessReason: row.accessReason,
        securityApproverOid: row.securityApproverOid,
        securityApproverSubjectId: row.securityApproverSubjectId,
        securityApprovedAt: row.securityApprovedAt,
        securityReason: row.securityReason,
        closedByOid: row.closedByOid,
        closedBy: row.closedBy,
        closedAt: row.closedAt,
        closedReason: row.closedReason,
        revision: row.revision,
        updatedAt: row.updatedAt,
      },
    });
    return updated.count === 1;
  }
}
