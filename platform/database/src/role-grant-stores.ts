/**
 * Grants de rol dinámicos (administración) en PostgreSQL.
 *
 * - `replace` es compare-and-set sobre `revision`. Sin fila, la revisión esperada es 0 y el alta
 *   es un `INSERT … ON CONFLICT DO NOTHING`: dos altas simultáneas no pueden ganar las dos.
 * - El runtime no tiene DELETE: retirar todos los roles guarda el conjunto vacío.
 *
 * Filas planas; el dominio (`RoleGrantStore`) vive en `modules/access`. El store acepta el cliente
 * o la transacción de `PrismaSocUnitOfWork`: dentro de ella, el cambio del grant, la solicitud que
 * lo aprueba y su AuditEvent se confirman juntos.
 */

import type { Prisma, PrismaClient } from '../generated/client/client.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface RoleGrantRow {
  readonly tenantId: string;
  readonly oid: string;
  readonly roles: readonly string[];
  readonly revision: number;
  readonly updatedAt: Date;
  readonly updatedBy: string;
}

/** Tope de filas por lectura: un grupo SOC es chico; más indica un error. */
export const ROLE_GRANT_QUERY_LIMIT = 2_000;

export class PrismaRoleGrantStore {
  public constructor(private readonly client: Db) {}

  public async current(tenantId: string, oid: string): Promise<RoleGrantRow | undefined> {
    const row = await this.client.accessRoleGrant.findUnique({
      where: { tenantId_oid: { tenantId, oid } },
    });
    return row ?? undefined;
  }

  public list(tenantId: string): Promise<readonly RoleGrantRow[]> {
    return this.client.accessRoleGrant.findMany({
      where: { tenantId, NOT: { roles: { isEmpty: true } } },
      orderBy: { oid: 'asc' },
      take: ROLE_GRANT_QUERY_LIMIT,
    });
  }

  /** `undefined` si la revisión guardada no es `expectedRevision`; entonces no escribe nada. */
  public async replace(
    tenantId: string,
    oid: string,
    roles: readonly string[],
    expectedRevision: number,
    updatedBy: string,
    at: Date,
  ): Promise<RoleGrantRow | undefined> {
    // Se devuelve lo escrito, no una relectura: otra escritura posterior no se confunde con esta.
    const written: RoleGrantRow = {
      tenantId,
      oid,
      roles: [...roles],
      revision: expectedRevision + 1,
      updatedAt: at,
      updatedBy,
    };
    if (expectedRevision === 0) {
      const inserted = await this.client.$queryRaw<{ oid: string }[]>`
        INSERT INTO "access_role_grants" ("tenant_id", "oid", "roles", "revision", "updated_at", "updated_by")
        VALUES (${tenantId}, ${oid}::uuid, ${[...roles]}::text[], 1, ${at}, ${updatedBy})
        ON CONFLICT ("tenant_id", "oid") DO NOTHING
        RETURNING "oid"`;
      return inserted.length === 0 ? undefined : written;
    }
    const updated = await this.client.accessRoleGrant.updateMany({
      where: { tenantId, oid, revision: expectedRevision },
      data: { roles: [...roles], revision: written.revision, updatedAt: at, updatedBy },
    });
    return updated.count === 0 ? undefined : written;
  }
}
