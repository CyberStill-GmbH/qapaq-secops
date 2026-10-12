/** PostgreSQL adapter de C-20, publicado aparte para que el modo memoria no cargue Prisma. */

import {
  closeDatabaseClient,
  createDatabaseClient,
  type DatabaseConnectionOptions,
} from '@qapaq/database';
import { PrismaNotificationAttemptStore } from '@qapaq/database/notification-stores';

import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  type NotificationAttempt,
} from '../notification.js';
import type { AttemptStore } from '../ports.js';

function toAttempt(
  row: Awaited<ReturnType<PrismaNotificationAttemptStore['byId']>>,
): NotificationAttempt | undefined {
  if (!row) return undefined;
  const channel = NOTIFICATION_CHANNELS.find((candidate) => candidate === row.channel);
  const status = NOTIFICATION_STATUSES.find((candidate) => candidate === row.status);
  if (!channel || !status) throw new Error('SOAR_STORAGE_CATALOG_INVALID');
  return {
    ...row,
    channel,
    status,
  };
}

/** Adapter de dominio y dueño del pool Prisma usado por el dispatcher. */
export class PostgresNotificationAttemptStore implements AttemptStore {
  private constructor(
    private readonly store: PrismaNotificationAttemptStore,
    private readonly closeClient: () => Promise<void>,
  ) {}

  public static connect(options: DatabaseConnectionOptions): PostgresNotificationAttemptStore {
    const client = createDatabaseClient(options);
    return new PostgresNotificationAttemptStore(new PrismaNotificationAttemptStore(client), () =>
      closeDatabaseClient(client),
    );
  }

  public async byIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<NotificationAttempt | undefined> {
    return toAttempt(await this.store.byIdempotencyKey(tenantId, idempotencyKey));
  }

  public async byId(tenantId: string, attemptId: string): Promise<NotificationAttempt | undefined> {
    return toAttempt(await this.store.byId(tenantId, attemptId));
  }

  public save(attempt: NotificationAttempt): Promise<void> {
    return this.store.save(attempt);
  }

  public countByStatusSince(
    tenantId: string,
    since: Date,
  ): Promise<Readonly<Record<string, number>>> {
    return this.store.countByStatusSince(tenantId, since);
  }

  public async listByTenant(
    tenantId: string,
    limit: number,
  ): Promise<readonly NotificationAttempt[]> {
    const rows = await this.store.listByTenant(tenantId, limit);
    return rows.map((row) => toAttempt(row)!);
  }

  public close(): Promise<void> {
    return this.closeClient();
  }
}
