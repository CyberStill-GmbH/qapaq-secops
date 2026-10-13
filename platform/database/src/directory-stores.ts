/**
 * Sprint 5 · fase 3 — padrón del grupo de admisión en PostgreSQL.
 *
 * - `claimSync`: un solo `INSERT … ON CONFLICT DO UPDATE … WHERE` atómico; crea el estado si no
 *   existe y toma el lease solo si está libre o vencido.
 * - `commitSync`: el ciclo entero en una transacción, cercada por `claim_id` con `FOR UPDATE`.
 *   Si el claim ya no es el vigente no escribe nada. El runtime no tiene DELETE: las bajas y
 *   los dueños que dejan de serlo son cambios de estado.
 *
 * Filas planas; el dominio (`DirectoryStore`, `applyMemberCycle`) vive en `modules/access`.
 */

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '../generated/client/client.js';
import { runDatabaseTransaction } from './transaction.js';

export interface DirectoryPersonRow {
  readonly oid: string;
  readonly displayName: string | null;
  readonly upn: string | null;
  readonly accountEnabled: boolean | null;
}

export interface DirectorySyncStateRow {
  readonly tenantId: string;
  readonly groupId: string;
  readonly deltaLink: string | null;
  readonly status: string;
  readonly lastAttemptAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly lastErrorClass: string | null;
}

export interface DirectoryMemberRow extends DirectoryPersonRow {
  readonly membership: string;
  readonly syncedAt: Date;
}

export interface DirectoryCycleRow {
  readonly at: Date;
  readonly upserts: readonly DirectoryPersonRow[];
  readonly removals: readonly string[];
  readonly fullRead: boolean;
  readonly owners: readonly DirectoryPersonRow[];
  readonly deltaLink: string;
}

/** Tope de filas por lectura del padrón: un grupo SOC es chico; más indica un error. */
export const DIRECTORY_QUERY_LIMIT = 2_000;

const stateSelect = {
  tenantId: true,
  groupId: true,
  deltaLink: true,
  status: true,
  lastAttemptAt: true,
  lastSuccessAt: true,
  lastErrorClass: true,
} as const;

export class PrismaDirectoryStore {
  public constructor(private readonly client: PrismaClient) {}

  public async claimSync(
    tenantId: string,
    groupId: string,
    at: Date,
    leaseMs: number,
  ): Promise<{ readonly claimId: string; readonly state: DirectorySyncStateRow } | undefined> {
    const claimId = randomUUID();
    const leaseUntil = new Date(at.getTime() + leaseMs);
    const rows = await this.client.$queryRaw<{ claim_id: string }[]>`
      INSERT INTO "directory_sync_state" ("tenant_id", "group_id", "status", "lease_until", "claim_id")
      VALUES (${tenantId}, ${groupId}::uuid, 'never', ${leaseUntil}, ${claimId}::uuid)
      ON CONFLICT ("tenant_id", "group_id") DO UPDATE
        SET "lease_until" = EXCLUDED."lease_until", "claim_id" = EXCLUDED."claim_id"
        WHERE "directory_sync_state"."lease_until" IS NULL
           OR "directory_sync_state"."lease_until" <= ${at}
      RETURNING "claim_id"`;
    if (rows.length === 0) return undefined;
    const state = await this.client.directorySyncState.findUnique({
      where: { tenantId_groupId: { tenantId, groupId } },
      select: stateSelect,
    });
    return state ? { claimId, state } : undefined;
  }

  /** `false` si el claim ya no es el vigente; entonces no escribe nada. */
  public async commitSync(
    tenantId: string,
    groupId: string,
    claimId: string,
    cycle: DirectoryCycleRow,
  ): Promise<boolean> {
    return runDatabaseTransaction(this.client, async (tx) => {
      const owned = await tx.$queryRaw<{ claim_id: string }[]>`
        SELECT "claim_id" FROM "directory_sync_state"
         WHERE "tenant_id" = ${tenantId} AND "group_id" = ${groupId}::uuid
           AND "claim_id" = ${claimId}::uuid
         FOR UPDATE`;
      if (owned.length === 0) return false;

      for (const person of cycle.upserts) {
        const data = {
          displayName: person.displayName,
          upn: person.upn,
          accountEnabled: person.accountEnabled,
          membership: 'member',
          syncedAt: cycle.at,
        };
        await tx.directoryMember.upsert({
          where: { tenantId_groupId_oid: { tenantId, groupId, oid: person.oid } },
          create: { tenantId, groupId, oid: person.oid, ...data },
          update: data,
        });
      }
      if (cycle.removals.length > 0) {
        await tx.directoryMember.updateMany({
          where: { tenantId, groupId, oid: { in: [...cycle.removals] } },
          data: { membership: 'removed', syncedAt: cycle.at },
        });
      }
      // Lectura completa: quien no apareció ya no es miembro.
      if (cycle.fullRead) {
        await tx.directoryMember.updateMany({
          where: {
            tenantId,
            groupId,
            membership: 'member',
            oid: { notIn: cycle.upserts.map((person) => person.oid) },
          },
          data: { membership: 'removed', syncedAt: cycle.at },
        });
      }

      // Dueños: el conjunto leído reemplaza al anterior (desactivar y reactivar los vistos).
      await tx.directoryOwner.updateMany({
        where: { tenantId, groupId, active: true },
        data: { active: false, syncedAt: cycle.at },
      });
      for (const owner of cycle.owners) {
        const data = {
          displayName: owner.displayName,
          upn: owner.upn,
          active: true,
          syncedAt: cycle.at,
        };
        await tx.directoryOwner.upsert({
          where: { tenantId_groupId_oid: { tenantId, groupId, oid: owner.oid } },
          create: { tenantId, groupId, oid: owner.oid, ...data },
          update: data,
        });
      }

      await tx.directorySyncState.update({
        where: { tenantId_groupId: { tenantId, groupId } },
        data: {
          deltaLink: cycle.deltaLink,
          status: 'ok',
          lastAttemptAt: cycle.at,
          lastSuccessAt: cycle.at,
          lastErrorClass: null,
          leaseUntil: null,
          claimId: null,
        },
      });
      return true;
    });
  }

  public async failSync(
    tenantId: string,
    groupId: string,
    claimId: string,
    errorClass: string,
    at: Date,
    resetDelta: boolean,
  ): Promise<void> {
    await this.client.directorySyncState.updateMany({
      where: { tenantId, groupId, claimId },
      data: {
        ...(resetDelta ? { deltaLink: null } : {}),
        status: 'failed',
        lastAttemptAt: at,
        lastErrorClass: errorClass,
        leaseUntil: null,
        claimId: null,
      },
    });
  }

  public async syncState(
    tenantId: string,
    groupId: string,
  ): Promise<DirectorySyncStateRow | undefined> {
    const row = await this.client.directorySyncState.findUnique({
      where: { tenantId_groupId: { tenantId, groupId } },
      select: stateSelect,
    });
    return row ?? undefined;
  }

  public async members(tenantId: string, groupId: string): Promise<readonly DirectoryMemberRow[]> {
    return this.client.directoryMember.findMany({
      where: { tenantId, groupId },
      orderBy: [{ displayName: 'asc' }, { oid: 'asc' }],
      take: DIRECTORY_QUERY_LIMIT,
    });
  }

  public async member(
    tenantId: string,
    groupId: string,
    oid: string,
  ): Promise<DirectoryMemberRow | undefined> {
    const row = await this.client.directoryMember.findUnique({
      where: { tenantId_groupId_oid: { tenantId, groupId, oid } },
    });
    return row ?? undefined;
  }

  public async owners(tenantId: string, groupId: string): Promise<readonly DirectoryPersonRow[]> {
    const rows = await this.client.directoryOwner.findMany({
      where: { tenantId, groupId, active: true },
      take: DIRECTORY_QUERY_LIMIT,
    });
    return rows.map((row) => ({
      oid: row.oid,
      displayName: row.displayName,
      upn: row.upn,
      accountEnabled: null,
    }));
  }
}
