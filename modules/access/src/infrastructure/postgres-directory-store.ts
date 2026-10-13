/**
 * Sprint 5 · fase 3 — adapter PostgreSQL de `DirectoryStore`.
 *
 * Traduce filas planas (`@qapaq/database/directory-stores`) al dominio del padrón y valida los
 * catálogos leídos: un estado desconocido en la base es un error de integridad, no se adivina.
 * Separa las altas y bajas del ciclo antes de entregarlo al store, que lo aplica en una sola
 * transacción cercada por el claim.
 */

import {
  closeDatabaseClient,
  createDatabaseClient,
  type DatabaseConnectionOptions,
} from '@qapaq/database';
import {
  PrismaDirectoryStore,
  type DirectoryMemberRow,
  type DirectorySyncStateRow,
} from '@qapaq/database/directory-stores';

import {
  DIRECTORY_SYNC_STATUSES,
  type DirectoryClaim,
  type DirectoryMemberRecord,
  type DirectoryPerson,
  type DirectoryStore,
  type DirectorySyncCycle,
  type DirectorySyncState,
} from '../directory.js';

export class DirectoryIntegrityError extends Error {
  public constructor(public readonly column: string) {
    super(`Valor fuera de catálogo en ${column}.`);
    this.name = 'DirectoryIntegrityError';
  }
}

function toState(row: DirectorySyncStateRow): DirectorySyncState {
  if (!(DIRECTORY_SYNC_STATUSES as readonly string[]).includes(row.status)) {
    throw new DirectoryIntegrityError('directory_sync_state.status');
  }
  return { ...row, status: row.status as DirectorySyncState['status'] };
}

function toMember(row: DirectoryMemberRow): DirectoryMemberRecord {
  if (row.membership !== 'member' && row.membership !== 'removed') {
    throw new DirectoryIntegrityError('directory_members.membership');
  }
  return { ...row, membership: row.membership };
}

export class PostgresDirectoryStore implements DirectoryStore {
  private constructor(
    private readonly store: PrismaDirectoryStore,
    private readonly closeClient: () => Promise<void>,
  ) {}

  public static connect(options: DatabaseConnectionOptions): PostgresDirectoryStore {
    const client = createDatabaseClient(options);
    return new PostgresDirectoryStore(new PrismaDirectoryStore(client), () =>
      closeDatabaseClient(client),
    );
  }

  public async claimSync(
    tenantId: string,
    groupId: string,
    at: Date,
    leaseMs: number,
  ): Promise<DirectoryClaim | undefined> {
    const claim = await this.store.claimSync(tenantId, groupId, at, leaseMs);
    return claim
      ? { tenantId, groupId, claimId: claim.claimId, state: toState(claim.state) }
      : undefined;
  }

  public commitSync(claim: DirectoryClaim, cycle: DirectorySyncCycle): Promise<boolean> {
    const upserts: DirectoryPerson[] = [];
    const removals: string[] = [];
    for (const change of cycle.changes) {
      if (change.kind === 'upsert')
        upserts.push({ ...change.person, oid: change.person.oid.toLowerCase() });
      else removals.push(change.oid.toLowerCase());
    }
    return this.store.commitSync(claim.tenantId, claim.groupId, claim.claimId, {
      at: cycle.at,
      upserts,
      removals,
      fullRead: cycle.fullRead,
      owners: cycle.owners.map((owner) => ({ ...owner, oid: owner.oid.toLowerCase() })),
      deltaLink: cycle.deltaLink,
    });
  }

  public failSync(
    claim: DirectoryClaim,
    errorClass: string,
    at: Date,
    resetDelta: boolean,
  ): Promise<void> {
    return this.store.failSync(
      claim.tenantId,
      claim.groupId,
      claim.claimId,
      errorClass,
      at,
      resetDelta,
    );
  }

  public async syncState(
    tenantId: string,
    groupId: string,
  ): Promise<DirectorySyncState | undefined> {
    const row = await this.store.syncState(tenantId, groupId);
    return row ? toState(row) : undefined;
  }

  public async members(
    tenantId: string,
    groupId: string,
  ): Promise<readonly DirectoryMemberRecord[]> {
    return (await this.store.members(tenantId, groupId)).map(toMember);
  }

  public async member(
    tenantId: string,
    groupId: string,
    oid: string,
  ): Promise<DirectoryMemberRecord | undefined> {
    const row = await this.store.member(tenantId, groupId, oid.toLowerCase());
    return row ? toMember(row) : undefined;
  }

  public owners(tenantId: string, groupId: string): Promise<readonly DirectoryPerson[]> {
    return this.store.owners(tenantId, groupId);
  }

  public close(): Promise<void> {
    return this.closeClient();
  }
}
