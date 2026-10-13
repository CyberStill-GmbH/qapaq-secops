/**
 * C-18/C-25 — almacenamiento PostgreSQL de sesiones del BFF.
 *
 * Filas planas: el dominio (`Session`, capabilities) vive en `modules/access`. Este store no
 * recibe nunca el identificador de la cookie: trabaja con su SHA-256 (`idHash`), que calcula
 * el adapter del módulo. `update` es compare-and-set sobre `revision`.
 */

import type { PrismaClient } from '../generated/client/client.js';

export interface SessionRow {
  readonly idHash: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly subjectOid: string | null;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly state: string;
  readonly roles: readonly string[];
  readonly scopes: readonly string[];
  readonly capabilities: readonly string[];
  readonly amr: readonly string[];
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly idpSessionId: string | null;
  readonly clientIp: string;
  readonly revokedAt: Date | null;
  readonly revocationReason: string | null;
  readonly revision: number;
}

function data(row: SessionRow) {
  return {
    ...row,
    roles: [...row.roles],
    scopes: [...row.scopes],
    capabilities: [...row.capabilities],
    amr: [...row.amr],
  };
}

export class PrismaSessionStore {
  public constructor(private readonly client: PrismaClient) {}

  public async create(row: SessionRow): Promise<void> {
    await this.client.accessSession.create({ data: data(row) });
  }

  public async byIdHash(idHash: string): Promise<SessionRow | undefined> {
    const row = await this.client.accessSession.findUnique({ where: { idHash } });
    return row ?? undefined;
  }

  public async activeBySubject(
    tenantId: string,
    subjectId: string,
  ): Promise<readonly SessionRow[]> {
    return this.client.accessSession.findMany({
      where: { tenantId, subjectId, state: 'active' },
      orderBy: [{ createdAt: 'asc' }],
    });
  }

  public async activeByOid(tenantId: string, oid: string): Promise<readonly SessionRow[]> {
    return this.client.accessSession.findMany({
      where: { tenantId, subjectOid: oid.toLowerCase(), state: 'active' },
      orderBy: [{ createdAt: 'asc' }],
    });
  }

  /** Compare-and-set: `false` si otra réplica escribió primero. */
  public async update(row: SessionRow, expectedRevision: number): Promise<boolean> {
    const { idHash, ...rest } = data(row);
    const updated = await this.client.accessSession.updateMany({
      where: { idHash, revision: expectedRevision },
      data: rest,
    });
    return updated.count === 1;
  }

  /** Sesiones recientes de un tenant, para la vista de administración (C-10). */
  public async recentByTenant(
    tenantId: string,
    since: Date,
    limit: number,
  ): Promise<readonly SessionRow[]> {
    return this.client.accessSession.findMany({
      where: { tenantId, lastSeenAt: { gte: since } },
      orderBy: [{ lastSeenAt: 'desc' }],
      take: Math.min(Math.max(limit, 1), 2_000),
    });
  }
}
