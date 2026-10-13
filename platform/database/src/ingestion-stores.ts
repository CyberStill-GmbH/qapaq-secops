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

export interface SourcePollObservationRow {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceId: string;
  readonly dataset: string;
  readonly attemptedAt: Date;
  readonly completedAt: Date;
  readonly outcome: string;
  readonly recordsSeen: number;
  readonly promoted: number;
  readonly quarantined: number;
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
  ): Promise<{ readonly watermark: Date | null; readonly claimId: string } | undefined> {
    const claimId = randomUUID();
    const leaseUntil = new Date(at.getTime() + leaseMs);
    const rows = await this.client.$queryRaw<{ watermark: Date | null }[]>`
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
      RETURNING "watermark"`;
    const row = rows[0];
    return row ? { watermark: row.watermark, claimId } : undefined;
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
