/**
 * Padrón en memoria (specs y desarrollo). Misma semántica que PostgreSQL: lease con fencing y
 * un ciclo se aplica entero o no se aplica.
 */

import { randomUUID } from 'node:crypto';

import {
  applyMemberCycle,
  type DirectoryClaim,
  type DirectoryMemberRecord,
  type DirectoryPerson,
  type DirectoryStore,
  type DirectorySyncCycle,
  type DirectorySyncState,
} from './directory.js';

interface SyncRow {
  state: DirectorySyncState;
  leaseUntil: Date | null;
  claimId: string | null;
}

const keyOf = (tenantId: string, groupId: string) => `${tenantId}|${groupId}`;

export class InMemoryDirectoryStore implements DirectoryStore {
  private readonly syncRows = new Map<string, SyncRow>();
  private readonly memberRows = new Map<string, Map<string, DirectoryMemberRecord>>();
  private readonly ownerRows = new Map<string, readonly DirectoryPerson[]>();

  public claimSync(
    tenantId: string,
    groupId: string,
    at: Date,
    leaseMs: number,
  ): Promise<DirectoryClaim | undefined> {
    const key = keyOf(tenantId, groupId);
    const row = this.syncRows.get(key) ?? {
      state: {
        tenantId,
        groupId,
        deltaLink: null,
        status: 'never' as const,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastErrorClass: null,
      },
      leaseUntil: null,
      claimId: null,
    };
    if (row.leaseUntil && row.leaseUntil > at) return Promise.resolve(undefined);
    const claimId = randomUUID();
    this.syncRows.set(key, { ...row, leaseUntil: new Date(at.getTime() + leaseMs), claimId });
    return Promise.resolve({ tenantId, groupId, claimId, state: row.state });
  }

  public commitSync(claim: DirectoryClaim, cycle: DirectorySyncCycle): Promise<boolean> {
    const key = keyOf(claim.tenantId, claim.groupId);
    const row = this.syncRows.get(key);
    if (!row || row.claimId !== claim.claimId) return Promise.resolve(false);
    this.memberRows.set(key, applyMemberCycle(this.memberRows.get(key) ?? new Map(), cycle));
    this.ownerRows.set(
      key,
      cycle.owners.map((owner) => ({ ...owner, oid: owner.oid.toLowerCase() })),
    );
    this.syncRows.set(key, {
      state: {
        ...row.state,
        deltaLink: cycle.deltaLink,
        status: 'ok',
        lastAttemptAt: cycle.at,
        lastSuccessAt: cycle.at,
        lastErrorClass: null,
      },
      leaseUntil: null,
      claimId: null,
    });
    return Promise.resolve(true);
  }

  public failSync(
    claim: DirectoryClaim,
    errorClass: string,
    at: Date,
    resetDelta: boolean,
  ): Promise<void> {
    const key = keyOf(claim.tenantId, claim.groupId);
    const row = this.syncRows.get(key);
    if (row && row.claimId === claim.claimId) {
      this.syncRows.set(key, {
        state: {
          ...row.state,
          ...(resetDelta ? { deltaLink: null } : {}),
          status: 'failed',
          lastAttemptAt: at,
          lastErrorClass: errorClass,
        },
        leaseUntil: null,
        claimId: null,
      });
    }
    return Promise.resolve();
  }

  public syncState(tenantId: string, groupId: string): Promise<DirectorySyncState | undefined> {
    return Promise.resolve(this.syncRows.get(keyOf(tenantId, groupId))?.state);
  }

  public members(tenantId: string, groupId: string): Promise<readonly DirectoryMemberRecord[]> {
    return Promise.resolve([...(this.memberRows.get(keyOf(tenantId, groupId))?.values() ?? [])]);
  }

  public member(
    tenantId: string,
    groupId: string,
    oid: string,
  ): Promise<DirectoryMemberRecord | undefined> {
    return Promise.resolve(this.memberRows.get(keyOf(tenantId, groupId))?.get(oid.toLowerCase()));
  }

  public owners(tenantId: string, groupId: string): Promise<readonly DirectoryPerson[]> {
    return Promise.resolve(this.ownerRows.get(keyOf(tenantId, groupId)) ?? []);
  }
}
