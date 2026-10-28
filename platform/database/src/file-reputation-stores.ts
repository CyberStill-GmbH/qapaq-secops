/**
 * Reputación de archivos por hash en PostgreSQL: caché de resultados (24 h) y usos de cuota.
 * Filas planas; la política (ventanas, límites, qué se cachea) vive en `modules/connectors`.
 *
 * La reserva de cuota cuenta y registra bajo un advisory lock por tenant y servicio: dos réplicas
 * que reservan a la vez se serializan y no pueden ver el mismo cupo libre.
 */

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '../generated/client/client.js';

export interface FileReputationCacheRow {
  readonly tenantId: string;
  readonly provider: string;
  readonly algorithm: string;
  readonly hash: string;
  readonly status: string;
  readonly result: unknown;
  readonly checkedAt: Date;
  readonly expiresAt: Date;
}

export interface FileReputationWindowRow {
  readonly minuteUsed: number;
  readonly dayUsed: number;
  readonly oldestInMinute: Date | null;
}

export interface FileReputationWindowQuery {
  readonly tenantId: string;
  readonly provider: string;
  readonly at: Date;
  readonly minuteSince: Date;
  readonly daySince: Date;
}

type Queryable = Pick<PrismaClient, '$queryRaw'>;

async function countWindow(
  client: Queryable,
  query: FileReputationWindowQuery,
): Promise<FileReputationWindowRow> {
  const horizon = query.minuteSince < query.daySince ? query.minuteSince : query.daySince;
  const rows = await client.$queryRaw<
    { minute_used: bigint; day_used: bigint; oldest_in_minute: Date | null }[]
  >`
    SELECT
      count(*) FILTER (WHERE "used_at" > ${query.minuteSince}) AS minute_used,
      count(*) FILTER (WHERE "used_at" >= ${query.daySince}) AS day_used,
      min("used_at") FILTER (WHERE "used_at" > ${query.minuteSince}) AS oldest_in_minute
    FROM "file_reputation_quota_uses"
    WHERE "tenant_id" = ${query.tenantId}
      AND "provider" = ${query.provider}
      AND "used_at" >= ${horizon}`;
  const row = rows[0];
  return {
    minuteUsed: Number(row?.minute_used ?? 0n),
    dayUsed: Number(row?.day_used ?? 0n),
    oldestInMinute: row?.oldest_in_minute ?? null,
  };
}

export class PrismaFileReputationStore {
  public constructor(private readonly client: PrismaClient) {}

  public async cached(
    tenantId: string,
    provider: string,
    hash: string,
    now: Date,
  ): Promise<FileReputationCacheRow | undefined> {
    const row = await this.client.fileReputationCache.findUnique({
      where: { tenantId_provider_hash: { tenantId, provider, hash } },
    });
    return row && row.expiresAt.getTime() > now.getTime() ? row : undefined;
  }

  public async remember(row: FileReputationCacheRow): Promise<void> {
    const result =
      row.result === null || row.result === undefined ? null : JSON.stringify(row.result);
    // Un `found` que pasa a `unknown` (o al revés) reemplaza también el resultado anterior.
    await this.client.$executeRaw`
      INSERT INTO "file_reputation_cache"
        ("tenant_id", "provider", "algorithm", "hash", "status", "result", "checked_at", "expires_at")
      VALUES (${row.tenantId}, ${row.provider}, ${row.algorithm}, ${row.hash}, ${row.status},
        ${result}::jsonb, ${row.checkedAt}, ${row.expiresAt})
      ON CONFLICT ("tenant_id", "provider", "hash") DO UPDATE SET
        "algorithm" = EXCLUDED."algorithm",
        "status" = EXCLUDED."status",
        "result" = EXCLUDED."result",
        "checked_at" = EXCLUDED."checked_at",
        "expires_at" = EXCLUDED."expires_at"`;
  }

  public async consume(
    query: FileReputationWindowQuery,
    limits: { readonly perMinute: number; readonly perDay: number },
  ): Promise<{ readonly granted: boolean; readonly usage: FileReputationWindowRow }> {
    return this.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`file-reputation:${query.tenantId}:${query.provider}`}, 0))`;
      const usage = await countWindow(tx, query);
      if (usage.minuteUsed >= limits.perMinute || usage.dayUsed >= limits.perDay) {
        return { granted: false, usage };
      }
      await tx.fileReputationQuotaUse.create({
        data: {
          id: randomUUID(),
          tenantId: query.tenantId,
          provider: query.provider,
          usedAt: query.at,
        },
      });
      return {
        granted: true,
        usage: {
          minuteUsed: usage.minuteUsed + 1,
          dayUsed: usage.dayUsed + 1,
          oldestInMinute: usage.oldestInMinute ?? query.at,
        },
      };
    });
  }

  public usage(query: FileReputationWindowQuery): Promise<FileReputationWindowRow> {
    return countWindow(this.client, query);
  }
}
