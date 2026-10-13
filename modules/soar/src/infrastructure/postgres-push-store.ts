/** Sprint 5 — adapter PostgreSQL de `PushSubscriptionStore`. */

import {
  closeDatabaseClient,
  createDatabaseClient,
  type DatabaseConnectionOptions,
} from '@qapaq/database';
import { PrismaPushSubscriptionStore } from '@qapaq/database/push-stores';

import type { PushSubscriptionRecord, PushSubscriptionStore } from '../push.js';

export class PostgresPushSubscriptionStore implements PushSubscriptionStore {
  private constructor(
    private readonly store: PrismaPushSubscriptionStore,
    private readonly closeClient: () => Promise<void>,
  ) {}

  public static connect(options: DatabaseConnectionOptions): PostgresPushSubscriptionStore {
    const client = createDatabaseClient(options);
    return new PostgresPushSubscriptionStore(new PrismaPushSubscriptionStore(client), () =>
      closeDatabaseClient(client),
    );
  }

  public upsert(record: PushSubscriptionRecord): Promise<PushSubscriptionRecord> {
    return this.store.upsert({ ...record, subjectKey: record.subjectKey.toLowerCase() });
  }

  public activeForSubject(
    tenantId: string,
    subjectKey: string,
  ): Promise<readonly PushSubscriptionRecord[]> {
    return this.store.activeForSubjects(tenantId, [subjectKey.toLowerCase()]);
  }

  public activeForSubjects(
    tenantId: string,
    subjectKeys: readonly string[],
  ): Promise<readonly PushSubscriptionRecord[]> {
    return this.store.activeForSubjects(
      tenantId,
      subjectKeys.map((key) => key.toLowerCase()),
    );
  }

  public revoke(
    tenantId: string,
    id: string,
    subjectKey: string | null,
    reason: string,
    at: Date,
  ): Promise<boolean> {
    return this.store.revoke(tenantId, id, subjectKey?.toLowerCase() ?? null, reason, at);
  }

  public markDelivered(id: string, at: Date): Promise<void> {
    return this.store.markDelivered(id, at);
  }

  public close(): Promise<void> {
    return this.closeClient();
  }
}
