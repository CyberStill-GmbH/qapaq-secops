/** PostgreSQL adapter de C-20, publicado aparte para que el modo memoria no cargue Prisma. */

import {
  closeDatabaseClient,
  createDatabaseClient,
  PrismaAuditStore,
  type DatabaseConnectionOptions,
} from '@qapaq/database';
import {
  PrismaNotificationAttemptStore,
  PrismaNotificationChannelStore,
} from '@qapaq/database/notification-stores';
import { recordAudit, type AuditEventDraft, type AuditStore } from '@qapaq/audit';

import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  SUPPRESSION_REASONS,
  type DeliveryEvidence,
  type NotificationAttempt,
} from '../notification.js';
import type { AttemptStore, ProviderAcceptanceLatency } from '../ports.js';
import { CHANNEL_IDS, type ChannelRecord, type ChannelStore } from '../notification-channels.js';

function toAttempt(
  row: Awaited<ReturnType<PrismaNotificationAttemptStore['byId']>>,
): NotificationAttempt | undefined {
  if (!row) return undefined;
  const channel = NOTIFICATION_CHANNELS.find((candidate) => candidate === row.channel);
  const status = NOTIFICATION_STATUSES.find((candidate) => candidate === row.status);
  if (!channel || !status) throw new Error('SOAR_STORAGE_CATALOG_INVALID');
  const context =
    row.context && typeof row.context === 'object' && !Array.isArray(row.context)
      ? (row.context as Readonly<Record<string, unknown>>)
      : null;
  return {
    ...row,
    channel,
    status,
    groupKey: row.groupKey ?? null,
    context,
    delivery: Array.isArray(row.delivery) ? (row.delivery as DeliveryEvidence[]) : [],
    suppressionReason:
      SUPPRESSION_REASONS.find((reason) => reason === row.suppressionReason) ?? null,
    supersededBy: row.supersededBy ?? null,
    digestId: row.digestId ?? null,
  };
}

/** Adapter de dominio y dueño del pool Prisma usado por el dispatcher. */
export class PostgresNotificationAttemptStore implements AttemptStore {
  /** Canales administrables, en el mismo pool (pocas lecturas y escrituras). */
  public readonly channels: ChannelStore;

  private constructor(
    private readonly store: PrismaNotificationAttemptStore,
    channelStore: PrismaNotificationChannelStore,
    private readonly closeClient: () => Promise<void>,
  ) {
    const toRecord = (row: Awaited<ReturnType<PrismaNotificationChannelStore['get']>>) => {
      if (!row) return undefined;
      const channelId = CHANNEL_IDS.find((id) => id === row.channelId);
      if (!channelId) return undefined;
      const outcome =
        row.lastTestOutcome === 'accepted' || row.lastTestOutcome === 'failed'
          ? row.lastTestOutcome
          : null;
      return { ...row, channelId, lastTestOutcome: outcome } satisfies ChannelRecord;
    };
    this.channels = {
      list: async (tenantId) =>
        (await channelStore.list(tenantId)).flatMap((row) => {
          const record = toRecord(row);
          return record ? [record] : [];
        }),
      get: async (tenantId, channelId) => toRecord(await channelStore.get(tenantId, channelId)),
      create: (record) => channelStore.create(record),
      saveConfig: (record, expectedRevision) => channelStore.saveConfig(record, expectedRevision),
      saveHealth: (tenantId, channelId, health, expectedRevision) =>
        channelStore.saveHealth(tenantId, channelId, health, expectedRevision),
    };
  }

  public static connect(options: DatabaseConnectionOptions): PostgresNotificationAttemptStore {
    const client = createDatabaseClient(options);
    return new PostgresNotificationAttemptStore(
      new PrismaNotificationAttemptStore(client),
      new PrismaNotificationChannelStore(client),
      () => closeDatabaseClient(client),
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

  public async acknowledgeWithAudit(
    tenantId: string,
    attemptId: string,
    actorId: string,
    at: Date,
    draft: (previousStatus: string) => AuditEventDraft,
    _memoryAudit?: AuditStore,
  ): Promise<NotificationAttempt | undefined> {
    const row = await this.store.acknowledgeWithAudit(
      tenantId,
      attemptId,
      actorId,
      at,
      async (tx, previousStatus) => {
        await recordAudit(new PrismaAuditStore(tx), draft(previousStatus));
      },
    );
    return toAttempt(row);
  }

  public countByStatusSince(
    tenantId: string,
    since: Date,
  ): Promise<Readonly<Record<string, number>>> {
    return this.store.countByStatusSince(tenantId, since);
  }

  public async providerAcceptanceLatencySince(
    tenantId: string,
    since: Date,
    through: Date,
  ): Promise<ProviderAcceptanceLatency> {
    const metric = await this.store.providerAcceptanceLatencySince(tenantId, since, through);
    return {
      windowHours: 24,
      sampleCount: Number(metric.sampleCount),
      excludedClockSkewCount: Number(metric.excludedClockSkewCount),
      sampleCapReached: metric.sampleCapReached,
      p50: metric.p50 === null ? null : Math.round(metric.p50),
      p95: metric.p95 === null ? null : Math.round(metric.p95),
      p99: metric.p99 === null ? null : Math.round(metric.p99),
    };
  }

  public async lastNotifiedInGroup(
    tenantId: string,
    groupKey: string,
    since: Date,
  ): Promise<NotificationAttempt | undefined> {
    return toAttempt(await this.store.lastNotifiedInGroup(tenantId, groupKey, since));
  }

  public async listSuppressedInGroup(
    tenantId: string,
    groupKey: string,
    after: Date,
    limit: number,
  ): Promise<readonly NotificationAttempt[]> {
    const rows = await this.store.listSuppressedInGroup(tenantId, groupKey, after, limit);
    return rows.map((row) => toAttempt(row)!);
  }

  public reserveP2ImmediateSlot(
    tenantId: string,
    idempotencyKey: string,
    at: Date,
    maximum: number,
  ): Promise<boolean> {
    return this.store.reserveP2ImmediateSlot(tenantId, idempotencyKey, at, maximum);
  }

  public settleP2ImmediateSlot(
    tenantId: string,
    idempotencyKey: string,
    at: Date,
    result: 'delivered' | 'failed' | 'uncertain',
  ): Promise<void> {
    return this.store.settleP2ImmediateSlot(tenantId, idempotencyKey, at, result);
  }

  public reserveGroupDispatchSlot(
    tenantId: string,
    groupKey: string,
    idempotencyKey: string,
    attemptId: string,
    fencingToken: string,
    at: Date,
    quietPeriodMs: number,
    leaseMs: number,
  ) {
    return this.store.reserveGroupDispatchSlot(
      tenantId,
      groupKey,
      idempotencyKey,
      attemptId,
      fencingToken,
      at,
      quietPeriodMs,
      leaseMs,
    );
  }

  public settleGroupDispatchSlot(
    tenantId: string,
    groupKey: string,
    idempotencyKey: string,
    fencingToken: string,
    at: Date,
    quietPeriodMs: number,
    leaseMs: number,
    result: 'delivered' | 'failed' | 'uncertain',
  ): Promise<void> {
    return this.store.settleGroupDispatchSlot(
      tenantId,
      groupKey,
      idempotencyKey,
      fencingToken,
      at,
      quietPeriodMs,
      leaseMs,
      result,
    );
  }

  public async listUndigested(
    tenantId: string,
    limit: number,
  ): Promise<readonly NotificationAttempt[]> {
    const rows = await this.store.listUndigested(tenantId, limit);
    return rows.map((row) => toAttempt(row)!);
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

// Sprint 5: dispositivos Web Push en el mismo subpath `@qapaq/soar/postgres`.
export { PostgresPushSubscriptionStore } from './postgres-push-store.js';
