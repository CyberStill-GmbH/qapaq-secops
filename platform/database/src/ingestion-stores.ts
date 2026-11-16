/**
 * Sprint 5 · fase 0 — estado de la ingesta de fuentes en PostgreSQL.
 *
 * El claim del cursor es un solo `INSERT … ON CONFLICT DO UPDATE … WHERE` atómico: crea la
 * fila si no existe y toma el lease solo si está libre o vencido. Dos réplicas que lo intentan
 * a la vez nunca obtienen ambas el claim. El avance de la marca está cercado por `claim_id` y
 * usa `GREATEST`, así nunca retrocede. Filas planas; el dominio vive en `modules/soc`.
 */

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '../generated/client/client.js';

export interface IngestionCursorKeyRow {
  readonly tenantId: string;
  readonly sourceId: string;
  readonly dataset: string;
}

export interface IngestionContinuationRow {
  readonly from: Date;
  readonly to: Date;
  readonly cursor: string;
}

interface IngestionCursorClaimRow {
  readonly watermark: Date | null;
  readonly continuationFrom: Date | null;
  readonly continuationTo: Date | null;
  readonly continuationCursor: string | null;
}

export interface SourcePollObservationRow {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceId: string;
  readonly dataset: string;
  readonly attemptedAt: Date;
  readonly completedAt: Date;
  readonly outcome: string;
  readonly recordsSeen: number;
  readonly normalized: number | null;
  readonly promoted: number;
  readonly quarantined: number;
  readonly duplicates: number | null;
  readonly notPromoted: number | null;
  readonly belowThreshold: number | null;
  readonly suppressed: number | null;
  readonly newestEventAt: Date | null;
  readonly errorClass: string | null;
}

export interface SourceHealthTransitionRow {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceId: string;
  readonly dataset: string;
  readonly fromState: string | null;
  readonly toState: string;
  readonly reason: string;
  readonly at: Date;
}

export interface StreamActivityRow {
  readonly stream: string;
  readonly lastEventAt: Date | null;
  readonly eventsInWindow: number;
  readonly windowHours: number;
  readonly measuredAt: Date;
}

export class PrismaIngestionStateStore {
  public constructor(private readonly client: PrismaClient) {}

  /** Lease del cursor; `undefined` si otra réplica lo tiene vigente. */
  public async claimCursor(
    key: IngestionCursorKeyRow,
    at: Date,
    leaseMs: number,
  ): Promise<
    | {
        readonly watermark: Date | null;
        readonly continuation: IngestionContinuationRow | null;
        readonly claimId: string;
      }
    | undefined
  > {
    const claimId = randomUUID();
    const leaseUntil = new Date(at.getTime() + leaseMs);
    const rows = await this.client.$queryRaw<IngestionCursorClaimRow[]>`
      INSERT INTO "soc_ingestion_cursors"
        ("tenant_id", "source_id", "dataset", "watermark", "lease_until", "claim_id", "updated_at")
      VALUES (${key.tenantId}, ${key.sourceId}, ${key.dataset}, NULL, ${leaseUntil},
              ${claimId}::uuid, ${at})
      ON CONFLICT ("tenant_id", "source_id", "dataset") DO UPDATE
        SET "lease_until" = EXCLUDED."lease_until",
            "claim_id" = EXCLUDED."claim_id",
            "updated_at" = EXCLUDED."updated_at"
        WHERE "soc_ingestion_cursors"."lease_until" IS NULL
           OR "soc_ingestion_cursors"."lease_until" <= ${at}
      RETURNING "watermark", "continuation_from" AS "continuationFrom",
                "continuation_to" AS "continuationTo",
                "continuation_cursor" AS "continuationCursor"`;
    const row = rows[0];
    if (!row) return undefined;
    const continuationParts = [row.continuationFrom, row.continuationTo, row.continuationCursor];
    const populatedParts = continuationParts.filter((part) => part !== null).length;
    if (populatedParts !== 0 && populatedParts !== continuationParts.length) {
      throw new Error('INGESTION_CURSOR_CONTINUATION_INVALID');
    }
    const continuation =
      populatedParts === 0
        ? null
        : {
            from: row.continuationFrom!,
            to: row.continuationTo!,
            cursor: row.continuationCursor!,
          };
    if (
      continuation &&
      (continuation.from.getTime() >= continuation.to.getTime() || continuation.cursor.length === 0)
    ) {
      throw new Error('INGESTION_CURSOR_CONTINUATION_INVALID');
    }
    return { watermark: row.watermark, continuation, claimId };
  }

  /** Avanza la marca solo con el claim vigente; nunca retrocede. */
  public async advanceCursor(
    key: IngestionCursorKeyRow,
    claimId: string,
    watermark: Date,
    at: Date,
  ): Promise<boolean> {
    const updated = await this.client.$executeRaw`
      UPDATE "soc_ingestion_cursors"
         SET "watermark" = GREATEST(coalesce("watermark", ${watermark}), ${watermark}),
             "updated_at" = ${at}
       WHERE "tenant_id" = ${key.tenantId}
         AND "source_id" = ${key.sourceId}
         AND "dataset" = ${key.dataset}
         AND "claim_id" = ${claimId}::uuid`;
    return updated === 1;
  }

  /** Guarda o elimina el checkpoint de páginas solo con el claim vigente. */
  public async saveContinuation(
    key: IngestionCursorKeyRow,
    claimId: string,
    continuation: IngestionContinuationRow | null,
    at: Date,
  ): Promise<boolean> {
    if (
      continuation &&
      (continuation.from.getTime() >= continuation.to.getTime() || continuation.cursor.length === 0)
    ) {
      throw new Error('INGESTION_CURSOR_CONTINUATION_INVALID');
    }
    const updated = await this.client.$executeRaw`
      UPDATE "soc_ingestion_cursors"
         SET "continuation_from" = ${continuation?.from ?? null},
             "continuation_to" = ${continuation?.to ?? null},
             "continuation_cursor" = ${continuation?.cursor ?? null},
             "updated_at" = ${at}
       WHERE "tenant_id" = ${key.tenantId}
         AND "source_id" = ${key.sourceId}
         AND "dataset" = ${key.dataset}
         AND "claim_id" = ${claimId}::uuid`;
    return updated === 1;
  }

  public async releaseCursor(key: IngestionCursorKeyRow, claimId: string): Promise<void> {
    await this.client.socIngestionCursor.updateMany({
      where: { ...key, claimId },
      data: { leaseUntil: null, claimId: null },
    });
  }

  /** Idempotente por `id`: repetir el registro de una pasada no duplica. */
  public async recordObservation(observation: SourcePollObservationRow): Promise<void> {
    await this.client.sourcePollObservation.createMany({
      data: [{ ...observation }],
      skipDuplicates: true,
    });
  }

  public async recentObservations(
    key: IngestionCursorKeyRow,
    limit: number,
  ): Promise<readonly SourcePollObservationRow[]> {
    return this.client.sourcePollObservation.findMany({
      where: key,
      orderBy: [{ attemptedAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 1_000),
    });
  }

  public async recentTransitions(
    key: IngestionCursorKeyRow,
    limit: number,
  ): Promise<readonly SourceHealthTransitionRow[]> {
    return this.client.sourceHealthTransition.findMany({
      where: key,
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  /** Idempotente por `id`; la tabla rechaza ediciones y borrados. */
  public async appendTransition(transition: SourceHealthTransitionRow): Promise<void> {
    await this.client.sourceHealthTransition.createMany({
      data: [{ ...transition }],
      skipDuplicates: true,
    });
  }

  /**
   * Una medición en una transacción: los streams no medidos pasan a cero eventos en la ventana
   * (conservan su último evento) y los medidos se actualizan. Sin DELETE.
   */
  public async saveActivity(
    key: IngestionCursorKeyRow,
    records: readonly StreamActivityRow[],
  ): Promise<void> {
    const measuredAt = records[0]?.measuredAt;
    if (!measuredAt) return;
    await this.client.$transaction(async (tx) => {
      await tx.sourceStreamActivity.updateMany({
        where: key,
        data: { eventsInWindow: 0, measuredAt },
      });
      for (const record of records) {
        await tx.sourceStreamActivity.upsert({
          where: { tenantId_sourceId_dataset_stream: { ...key, stream: record.stream } },
          create: { ...key, ...record },
          update: { ...record },
        });
      }
    });
  }

  public async activity(key: IngestionCursorKeyRow): Promise<readonly StreamActivityRow[]> {
    return this.client.sourceStreamActivity.findMany({
      where: key,
      orderBy: [{ stream: 'asc' }],
      take: 50,
      select: {
        stream: true,
        lastEventAt: true,
        eventsInWindow: true,
        windowHours: true,
        measuredAt: true,
      },
    });
  }
}
