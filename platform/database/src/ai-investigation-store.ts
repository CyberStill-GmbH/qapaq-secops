/**
 * Analista IA — persistencia PostgreSQL de investigaciones (docs/27).
 *
 * Filas planas: el dominio (política, validación del expediente, plan de acciones) vive en
 * `modules/assistant`. Aquí están las garantías que solo la base da:
 *
 * - Claim con `FOR UPDATE SKIP LOCKED` y token de fencing creciente: toda escritura del worker
 *   exige `(id, fencing_token, status = 'running')`, así que un dueño anterior no escribe.
 * - Reserva de presupuesto serializada por tenant con `pg_advisory_xact_lock`: dos réplicas no
 *   consumen a la vez la última cuota del día.
 * - Idempotencia por índices únicos: (tenant, clave) del trabajo, (trabajo, fase, huella) de la
 *   invocación y (trabajo, tipo) de la acción.
 */

import { randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '../generated/client/client.js';

type Tx = Prisma.TransactionClient;

export interface AiInvestigationJobRow {
  readonly id: string;
  readonly tenantId: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly subjectTitle: string;
  readonly subjectRuleId: string | null;
  readonly alertIds: unknown;
  readonly priority: string;
  readonly trigger: string;
  readonly source: string;
  readonly initiatedBy: string | null;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly policyVersion: string;
  readonly status: string;
  readonly stage: string | null;
  readonly inference: string | null;
  readonly attempt: number;
  readonly availableAt: Date;
  readonly leaseUntil: Date | null;
  readonly fencingToken: number;
  readonly cancelRequested: boolean;
  readonly lastErrorCode: string | null;
  readonly result: unknown;
  readonly plannedStatus: string | null;
  readonly evidence: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly revision: number;
}

export interface NewAiInvestigationJobRow {
  readonly id: string;
  readonly tenantId: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly subjectTitle: string;
  readonly subjectRuleId: string | null;
  readonly alertIds: readonly string[];
  readonly priority: string;
  readonly trigger: string;
  readonly source: string;
  readonly initiatedBy: string | null;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly policyVersion: string;
  readonly createdAt: Date;
  readonly availableAt: Date;
}

export interface AiInvestigationEventRow {
  readonly jobId: string;
  readonly sequence: number;
  readonly at: Date;
  readonly stage: string;
  readonly kind: string;
  readonly detail: unknown;
}

export interface AiInvestigationInvocationRow {
  readonly id: string;
  readonly jobId: string;
  readonly tenantId: string;
  readonly phase: string;
  readonly fingerprint: string;
  readonly tier: string;
  readonly model: string;
  readonly state: string;
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly reservedMicroUsd: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly estimatedMicroUsd: number | null;
  readonly rateCardVersion: string;
  readonly createdAt: Date;
  readonly settledAt: Date | null;
}

export interface AiInvestigationActionRow {
  readonly id: string;
  readonly jobId: string;
  readonly tenantId: string;
  readonly kind: string;
  readonly state: string;
  readonly reason: string;
  readonly urgency: string | null;
  readonly groupKey: string | null;
  readonly at: Date;
  readonly executedAt: Date | null;
  readonly refKind: string | null;
  readonly refId: string | null;
  readonly errorCode: string | null;
}

export interface AiAnalystSettingsRow {
  readonly tenantId: string;
  readonly document: unknown;
  readonly revision: number;
  readonly updatedAt: Date;
  readonly updatedBy: string;
}

export interface AiInvestigationEventInput {
  readonly at: Date;
  readonly stage: string;
  readonly kind: string;
  readonly detail: unknown;
}

export interface AiInvocationReservationInput {
  readonly at: Date;
  readonly phase: string;
  readonly fingerprint: string;
  readonly tier: string;
  readonly model: string;
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly reservedMicroUsd: number;
  readonly rateCardVersion: string;
  readonly dailyCeilingMicroUsd: number;
  readonly maxCallsPerRun: number;
}

export type AiInvocationReservationResult =
  | {
      readonly ok: true;
      readonly invocation: AiInvestigationInvocationRow;
      readonly reused: boolean;
    }
  | { readonly ok: false; readonly reason: 'DAILY_CAP' | 'RUN_CAP' | 'CANCELLED' | 'STALE_LEASE' };

export interface AiPlannedActionInput {
  readonly kind: string;
  readonly reason: string;
  readonly urgency: string | null;
  readonly groupKey: string | null;
}

export interface AiBudgetTotalsRow {
  readonly reservedMicroUsd: number;
  readonly settledMicroUsd: number;
  readonly unknownCount: number;
  readonly unknownMicroUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly runsNone: number;
  readonly runsEconomy: number;
  readonly runsAdvanced: number;
}

export interface AiActivityCountsRow {
  readonly queue: readonly {
    readonly status: string;
    readonly priority: string;
    readonly total: number;
    readonly oldest: Date | null;
  }[];
  readonly finished: readonly {
    readonly status: string;
    readonly inference: string | null;
    readonly total: number;
  }[];
  readonly settledMicroUsd: number;
}

export type AiCommandOutcome = 'ok' | 'conflict' | 'not_found' | 'terminal';

const ACTIVE = ['queued', 'running'];
const RETRYABLE = ['requires_review', 'partial', 'budget_exhausted', 'cancelled', 'failed'];
const DAY_MS = 86_400_000;

const JOB_COLUMNS = Prisma.raw(`
  "id", "tenant_id" AS "tenantId", "subject_kind" AS "subjectKind", "subject_id" AS "subjectId",
  "subject_title" AS "subjectTitle", "subject_rule_id" AS "subjectRuleId",
  "alert_ids" AS "alertIds", "priority", "trigger", "source", "initiated_by" AS "initiatedBy",
  "idempotency_key" AS "idempotencyKey", "fingerprint", "policy_version" AS "policyVersion",
  "status", "stage", "inference", "attempt", "available_at" AS "availableAt",
  "lease_until" AS "leaseUntil", "fencing_token" AS "fencingToken",
  "cancel_requested" AS "cancelRequested", "last_error_code" AS "lastErrorCode", "result",
  "planned_status" AS "plannedStatus", "evidence", "created_at" AS "createdAt",
  "updated_at" AS "updatedAt", "started_at" AS "startedAt", "finished_at" AS "finishedAt",
  "revision"`);

const INVOCATION_COLUMNS = Prisma.raw(`
  "id", "job_id" AS "jobId", "tenant_id" AS "tenantId", "phase", "fingerprint", "tier", "model",
  "state", "reserved_input_tokens" AS "reservedInputTokens",
  "reserved_output_tokens" AS "reservedOutputTokens", "reserved_micro_usd" AS "reservedMicroUsd",
  "input_tokens" AS "inputTokens", "output_tokens" AS "outputTokens",
  "cache_read_tokens" AS "cacheReadTokens", "cache_write_tokens" AS "cacheWriteTokens",
  "estimated_micro_usd" AS "estimatedMicroUsd", "rate_card_version" AS "rateCardVersion",
  "created_at" AS "createdAt", "settled_at" AS "settledAt"`);

const ACTION_COLUMNS = Prisma.raw(`
  "id", "job_id" AS "jobId", "tenant_id" AS "tenantId", "kind", "state", "reason", "urgency",
  "group_key" AS "groupKey", "at", "executed_at" AS "executedAt", "ref_kind" AS "refKind",
  "ref_id" AS "refId", "error_code" AS "errorCode"`);

type RawInvocation = Omit<
  AiInvestigationInvocationRow,
  'reservedMicroUsd' | 'estimatedMicroUsd'
> & {
  readonly reservedMicroUsd: bigint | number;
  readonly estimatedMicroUsd: bigint | number | null;
};

function invocationOf(row: RawInvocation): AiInvestigationInvocationRow {
  return {
    ...row,
    reservedMicroUsd: Number(row.reservedMicroUsd),
    estimatedMicroUsd: row.estimatedMicroUsd === null ? null : Number(row.estimatedMicroUsd),
  };
}

const json = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);

export class PrismaAiInvestigationStore {
  public constructor(private readonly client: PrismaClient) {}

  /** Falla si la migración `ai_investigations` no está aplicada. */
  public async ready(): Promise<void> {
    const rows = await this.client.$queryRaw<readonly { readonly present: boolean }[]>`
      SELECT (to_regclass('public.ai_investigation_jobs') IS NOT NULL
          AND to_regclass('public.ai_investigation_events') IS NOT NULL
          AND to_regclass('public.ai_investigation_invocations') IS NOT NULL
          AND to_regclass('public.ai_investigation_actions') IS NOT NULL
          AND to_regclass('public.ai_analyst_settings') IS NOT NULL) AS "present"`;
    if (rows[0]?.present !== true) throw new Error('AI_INVESTIGATION_SCHEMA_NOT_READY');
  }

  public async enqueue(
    row: NewAiInvestigationJobRow,
  ): Promise<{ readonly row: AiInvestigationJobRow; readonly created: boolean }> {
    const inserted = await this.client.$queryRaw<AiInvestigationJobRow[]>`
      INSERT INTO "ai_investigation_jobs" (
        "id", "tenant_id", "subject_kind", "subject_id", "subject_title", "subject_rule_id",
        "alert_ids", "priority", "trigger", "source", "initiated_by", "idempotency_key",
        "fingerprint", "policy_version", "available_at", "created_at", "updated_at"
      ) VALUES (
        ${row.id}::uuid, ${row.tenantId}, ${row.subjectKind}, ${row.subjectId},
        ${row.subjectTitle}, ${row.subjectRuleId}, ${JSON.stringify(row.alertIds)}::jsonb,
        ${row.priority}, ${row.trigger}, ${row.source}, ${row.initiatedBy},
        ${row.idempotencyKey}, ${row.fingerprint}, ${row.policyVersion}, ${row.availableAt},
        ${row.createdAt}, ${row.createdAt}
      )
      ON CONFLICT ("tenant_id", "idempotency_key") DO NOTHING
      RETURNING ${JOB_COLUMNS}`;
    if (inserted[0]) return { row: inserted[0], created: true };
    const existing = await this.client.$queryRaw<AiInvestigationJobRow[]>`
      SELECT ${JOB_COLUMNS} FROM "ai_investigation_jobs"
       WHERE "tenant_id" = ${row.tenantId} AND "idempotency_key" = ${row.idempotencyKey}`;
    if (!existing[0]) throw new Error('AI_INVESTIGATION_ENQUEUE_RACE');
    return { row: existing[0], created: false };
  }

  /**
   * Barre los leases vencidos que ya no se reclaman (cancelados o en cuarentena) y luego reclama
   * un trabajo: prioridad P1→P4, después antigüedad.
   */
  public async claim(
    at: Date,
    leaseMs: number,
    maxAttempts: number,
  ): Promise<AiInvestigationJobRow | undefined> {
    const leaseUntil = new Date(at.getTime() + Math.max(leaseMs, 1_000));
    return this.client.$transaction(async (tx) => {
      await tx.$executeRaw`
        WITH swept AS (
          UPDATE "ai_investigation_jobs" AS j
             SET "status" = CASE
                   WHEN j."cancel_requested" THEN 'cancelled'
                   WHEN EXISTS (
                     SELECT 1 FROM "ai_investigation_invocations" AS i
                      WHERE i."job_id" = j."id" AND i."state" IN ('dispatching', 'usage_unknown')
                   ) THEN 'usage_unreconciled'
                   ELSE 'failed' END,
                 "stage" = NULL,
                 "lease_until" = NULL,
                 "planned_status" = NULL,
                 "last_error_code" = CASE WHEN j."cancel_requested" THEN j."last_error_code"
                                          ELSE 'LEASE_EXPIRED_MAX_ATTEMPTS' END,
                 "finished_at" = ${at},
                 "updated_at" = ${at},
                 "revision" = j."revision" + 1
           WHERE j."id" IN (
             SELECT c."id" FROM "ai_investigation_jobs" AS c
              WHERE c."status" = 'running' AND c."lease_until" <= ${at}
                AND (c."cancel_requested" OR c."attempt" >= ${maxAttempts}::int)
              FOR UPDATE SKIP LOCKED
           )
          RETURNING j."id"
        )
        UPDATE "ai_investigation_invocations" AS i
           SET "state" = CASE i."state" WHEN 'dispatching' THEN 'usage_unknown' ELSE 'released' END,
               "updated_at" = ${at}
         WHERE i."job_id" IN (SELECT "id" FROM swept) AND i."state" IN ('reserved', 'dispatching')`;
      const rows = await tx.$queryRaw<AiInvestigationJobRow[]>`
        UPDATE "ai_investigation_jobs" AS target
           SET "status" = 'running',
               "stage" = NULL,
               "attempt" = target."attempt" + 1,
               "fencing_token" = target."fencing_token" + 1,
               "lease_until" = ${leaseUntil},
               "started_at" = COALESCE(target."started_at", ${at}),
               "updated_at" = ${at},
               "revision" = target."revision" + 1
         WHERE target."id" IN (
           SELECT c."id" FROM "ai_investigation_jobs" AS c
            WHERE NOT c."cancel_requested"
              AND ((c."status" = 'queued' AND c."available_at" <= ${at})
                OR (c."status" = 'running' AND c."lease_until" <= ${at}))
            ORDER BY c."priority", c."available_at", c."created_at", c."id"
            LIMIT 1
            FOR UPDATE SKIP LOCKED
         )
        RETURNING ${JOB_COLUMNS}`;
      return rows[0];
    });
  }

  /** `undefined`: el token es viejo. Si no, indica si hay cancelación pedida. */
  public async heartbeat(
    jobId: string,
    fencingToken: number,
    at: Date,
    leaseMs: number,
  ): Promise<boolean | undefined> {
    const leaseUntil = new Date(at.getTime() + Math.max(leaseMs, 1_000));
    const rows = await this.client.$queryRaw<{ cancelRequested: boolean }[]>`
      UPDATE "ai_investigation_jobs"
         SET "lease_until" = ${leaseUntil}
       WHERE "id" = ${jobId}::uuid AND "fencing_token" = ${fencingToken}::int
         AND "status" = 'running' AND "lease_until" > ${at}
      RETURNING "cancel_requested" AS "cancelRequested"`;
    return rows[0]?.cancelRequested;
  }

  private async insertEvent(
    tx: Tx,
    jobId: string,
    tenantId: string,
    sequence: number,
    event: AiInvestigationEventInput,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "ai_investigation_events" ("job_id", "sequence", "tenant_id", "at", "stage", "kind", "detail")
      VALUES (${jobId}::uuid, ${sequence}::int, ${tenantId}, ${event.at}, ${event.stage},
              ${event.kind}, ${JSON.stringify(event.detail ?? {})}::jsonb)`;
  }

  /**
   * Avance del worker: opcionalmente cambia la etapa, la inferencia y el resumen de evidencia, y
   * agrega un evento con la siguiente secuencia. `false` si el token es viejo.
   */
  public async progress(
    jobId: string,
    fencingToken: number,
    input: {
      readonly at: Date;
      readonly stage?: string;
      readonly inference?: string;
      readonly evidence?: unknown;
      readonly event?: AiInvestigationEventInput;
    },
  ): Promise<boolean> {
    return this.client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ sequence: number; tenantId: string }[]>`
        UPDATE "ai_investigation_jobs"
           SET "stage" = COALESCE(${input.stage ?? null}::text, "stage"),
               "inference" = COALESCE(${input.inference ?? null}::text, "inference"),
               "evidence" = COALESCE(${json(input.evidence)}::jsonb, "evidence"),
               "event_sequence" = "event_sequence" + ${input.event ? 1 : 0}::int,
               "updated_at" = ${input.at}
         WHERE "id" = ${jobId}::uuid AND "fencing_token" = ${fencingToken}::int
           AND "status" = 'running' AND "lease_until" > ${input.at}
        RETURNING "event_sequence" AS "sequence", "tenant_id" AS "tenantId"`;
      const row = rows[0];
      if (!row) return false;
      if (input.event) await this.insertEvent(tx, jobId, row.tenantId, row.sequence, input.event);
      return true;
    });
  }

  private async closeInvocations(tx: Tx, jobId: string, at: Date): Promise<void> {
    await tx.$executeRaw`
      UPDATE "ai_investigation_invocations"
         SET "state" = CASE "state" WHEN 'dispatching' THEN 'usage_unknown' ELSE 'released' END,
             "updated_at" = ${at}
       WHERE "job_id" = ${jobId}::uuid AND "state" IN ('reserved', 'dispatching')`;
  }

  /** Cierre monótono. Devuelve el estado escrito (`cancelled` si se pidió cancelar) o `undefined`. */
  public async finish(
    jobId: string,
    fencingToken: number,
    input: {
      readonly at: Date;
      readonly status: string;
      readonly result: unknown;
      readonly inference: string;
      readonly evidence?: unknown;
      readonly errorCode: string | null;
      readonly event?: AiInvestigationEventInput;
    },
  ): Promise<string | undefined> {
    return this.client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string; sequence: number; tenantId: string }[]>`
        UPDATE "ai_investigation_jobs"
           SET "status" = CASE WHEN "cancel_requested" THEN 'cancelled' ELSE ${input.status}::text END,
               "result" = CASE WHEN "cancel_requested" THEN NULL ELSE ${json(input.result)}::jsonb END,
               "planned_status" = NULL,
               "stage" = NULL,
               "lease_until" = NULL,
               "inference" = ${input.inference}::text,
               "evidence" = COALESCE(${json(input.evidence)}::jsonb, "evidence"),
               "last_error_code" = ${input.errorCode}::text,
               "event_sequence" = "event_sequence" + ${input.event ? 1 : 0}::int,
               "finished_at" = ${input.at},
               "updated_at" = ${input.at},
               "revision" = "revision" + 1
         WHERE "id" = ${jobId}::uuid AND "fencing_token" = ${fencingToken}::int
           AND "status" = 'running' AND "lease_until" > ${input.at}
        RETURNING "status", "event_sequence" AS "sequence", "tenant_id" AS "tenantId"`;
      const row = rows[0];
      if (!row) return undefined;
      if (input.event) await this.insertEvent(tx, jobId, row.tenantId, row.sequence, input.event);
      await this.closeInvocations(tx, jobId, input.at);
      return row.status;
    });
  }

  /** Devuelve el estado resultante (`queued` | `failed` | `cancelled`) o `undefined` si es viejo. */
  public async releaseForRetry(
    jobId: string,
    fencingToken: number,
    input: {
      readonly at: Date;
      readonly availableAt: Date;
      readonly errorCode: string;
      readonly maxAttempts: number;
      readonly refundAttempt: boolean;
    },
  ): Promise<string | undefined> {
    const refund = input.refundAttempt;
    return this.client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string }[]>`
        WITH decided AS (
          SELECT "id",
                 CASE WHEN "cancel_requested" THEN 'cancelled'
                      WHEN NOT ${refund}::boolean AND "attempt" >= ${input.maxAttempts}::int THEN 'failed'
                      ELSE 'queued' END AS next
            FROM "ai_investigation_jobs"
           WHERE "id" = ${jobId}::uuid AND "fencing_token" = ${fencingToken}::int
             AND "status" = 'running' AND "lease_until" > ${input.at}
             FOR UPDATE
        )
        UPDATE "ai_investigation_jobs" AS j
           SET "status" = decided.next,
               "stage" = NULL,
               "lease_until" = NULL,
               "attempt" = CASE WHEN ${refund}::boolean THEN GREATEST(j."attempt" - 1, 0)
                                ELSE j."attempt" END,
               "available_at" = CASE WHEN decided.next = 'queued' THEN ${input.availableAt}
                                     ELSE j."available_at" END,
               "planned_status" = CASE WHEN decided.next = 'queued' THEN j."planned_status"
                                       ELSE NULL END,
               "last_error_code" = ${input.errorCode}::text,
               "finished_at" = CASE WHEN decided.next = 'queued' THEN NULL ELSE ${input.at} END,
               "updated_at" = ${input.at},
               "revision" = j."revision" + 1
          FROM decided
         WHERE j."id" = decided."id"
        RETURNING j."status"`;
      const row = rows[0];
      if (!row) return undefined;
      await this.closeInvocations(tx, jobId, input.at);
      return row.status;
    });
  }

  public async requestCancel(
    tenantId: string,
    jobId: string,
    expectedRevision: number,
    at: Date,
  ): Promise<AiCommandOutcome> {
    return this.client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string; revision: number }[]>`
        SELECT "status", "revision" FROM "ai_investigation_jobs"
         WHERE "id" = ${jobId}::uuid AND "tenant_id" = ${tenantId} FOR UPDATE`;
      const job = rows[0];
      if (!job) return 'not_found';
      if (!ACTIVE.includes(job.status)) return 'terminal';
      if (job.revision !== expectedRevision) return 'conflict';
      if (job.status === 'queued') {
        await tx.$executeRaw`
          UPDATE "ai_investigation_jobs"
             SET "status" = 'cancelled', "cancel_requested" = true, "planned_status" = NULL,
                 "finished_at" = ${at}, "updated_at" = ${at}, "revision" = "revision" + 1
           WHERE "id" = ${jobId}::uuid`;
        await this.closeInvocations(tx, jobId, at);
      } else {
        await tx.$executeRaw`
          UPDATE "ai_investigation_jobs"
             SET "cancel_requested" = true, "updated_at" = ${at}, "revision" = "revision" + 1
           WHERE "id" = ${jobId}::uuid`;
      }
      return 'ok';
    });
  }

  public async retry(
    tenantId: string,
    jobId: string,
    expectedRevision: number,
    at: Date,
  ): Promise<AiCommandOutcome> {
    return this.client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string; revision: number }[]>`
        SELECT "status", "revision" FROM "ai_investigation_jobs"
         WHERE "id" = ${jobId}::uuid AND "tenant_id" = ${tenantId} FOR UPDATE`;
      const job = rows[0];
      if (!job) return 'not_found';
      if (ACTIVE.includes(job.status)) return 'conflict';
      if (!RETRYABLE.includes(job.status)) return 'terminal';
      if (job.revision !== expectedRevision) return 'conflict';
      await tx.$executeRaw`
        UPDATE "ai_investigation_jobs"
           SET "status" = 'queued', "stage" = NULL, "inference" = NULL, "attempt" = 0,
               "available_at" = ${at}, "lease_until" = NULL, "cancel_requested" = false,
               "last_error_code" = NULL, "result" = NULL, "planned_status" = NULL,
               "finished_at" = NULL, "updated_at" = ${at}, "revision" = "revision" + 1
         WHERE "id" = ${jobId}::uuid`;
      return 'ok';
    });
  }

  public async byId(tenantId: string, jobId: string): Promise<AiInvestigationJobRow | undefined> {
    const rows = await this.client.$queryRaw<AiInvestigationJobRow[]>`
      SELECT ${JOB_COLUMNS} FROM "ai_investigation_jobs"
       WHERE "id" = ${jobId}::uuid AND "tenant_id" = ${tenantId}`;
    return rows[0];
  }

  /** Más recientes primero; `after` es la última fila de la página anterior. */
  public async list(
    tenantId: string,
    limit: number,
    status?: string,
    after?: { readonly createdAt: Date; readonly id: string },
  ): Promise<readonly AiInvestigationJobRow[]> {
    const byStatus = status === undefined ? Prisma.empty : Prisma.sql`AND "status" = ${status}`;
    const byCursor =
      after === undefined
        ? Prisma.empty
        : Prisma.sql`AND ("created_at", "id") < (${after.createdAt}, ${after.id}::uuid)`;
    return this.client.$queryRaw<AiInvestigationJobRow[]>`
      SELECT ${JOB_COLUMNS} FROM "ai_investigation_jobs"
       WHERE "tenant_id" = ${tenantId} ${byStatus} ${byCursor}
       ORDER BY "created_at" DESC, "id" DESC
       LIMIT ${Math.min(Math.max(limit, 1), 101)}::int`;
  }

  public async events(
    tenantId: string,
    jobId: string,
  ): Promise<readonly AiInvestigationEventRow[]> {
    return this.client.$queryRaw<AiInvestigationEventRow[]>`
      SELECT "job_id" AS "jobId", "sequence", "at", "stage", "kind", "detail"
        FROM "ai_investigation_events"
       WHERE "job_id" = ${jobId}::uuid AND "tenant_id" = ${tenantId}
       ORDER BY "sequence"`;
  }

  public async invocations(
    tenantId: string,
    jobId: string,
  ): Promise<readonly AiInvestigationInvocationRow[]> {
    const rows = await this.client.$queryRaw<RawInvocation[]>`
      SELECT ${INVOCATION_COLUMNS} FROM "ai_investigation_invocations"
       WHERE "job_id" = ${jobId}::uuid AND "tenant_id" = ${tenantId}
       ORDER BY "created_at", "id"`;
    return rows.map(invocationOf);
  }

  public async findPriorInference(
    tenantId: string,
    fingerprint: string,
    excludeJobId: string,
  ): Promise<AiInvestigationJobRow | undefined> {
    const rows = await this.client.$queryRaw<AiInvestigationJobRow[]>`
      SELECT ${JOB_COLUMNS} FROM "ai_investigation_jobs"
       WHERE "id" = (
         SELECT i."job_id" FROM "ai_investigation_invocations" AS i
          WHERE i."tenant_id" = ${tenantId} AND i."fingerprint" = ${fingerprint}
            AND i."state" = 'settled' AND i."job_id" <> ${excludeJobId}::uuid
          ORDER BY i."settled_at" DESC
          LIMIT 1
       )`;
    return rows[0];
  }

  /**
   * Reserva atómica del peor caso. Bloquea la fila del trabajo (fencing y cancelación), serializa
   * el tenant con un advisory lock y cuenta contra el techo del día UTC: `reserved`,
   * `dispatching` y `usage_unknown` al peor caso; `settled` a su estimación.
   */
  public async reserveInvocation(
    jobId: string,
    fencingToken: number,
    input: AiInvocationReservationInput,
  ): Promise<AiInvocationReservationResult> {
    return this.client.$transaction(async (tx) => {
      const jobs = await tx.$queryRaw<{ tenantId: string; cancelRequested: boolean }[]>`
        SELECT "tenant_id" AS "tenantId", "cancel_requested" AS "cancelRequested"
          FROM "ai_investigation_jobs"
         WHERE "id" = ${jobId}::uuid AND "fencing_token" = ${fencingToken}::int
           AND "status" = 'running' AND "lease_until" > ${input.at}
           FOR UPDATE`;
      const job = jobs[0];
      if (!job) return { ok: false, reason: 'STALE_LEASE' } as const;
      if (job.cancelRequested) return { ok: false, reason: 'CANCELLED' } as const;
      // executeRaw: Prisma no deserializa el `void` de las funciones de advisory lock.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`ai-investigation-budget:${job.tenantId}`}, 0))`;

      const rows = (
        await tx.$queryRaw<RawInvocation[]>`
          SELECT ${INVOCATION_COLUMNS} FROM "ai_investigation_invocations"
           WHERE "job_id" = ${jobId}::uuid
           ORDER BY "created_at", "id"`
      ).map(invocationOf);
      const sameKey = (row: AiInvestigationInvocationRow): boolean =>
        row.phase === input.phase && row.fingerprint === input.fingerprint;
      const committed = rows.filter((row) =>
        ['dispatching', 'usage_unknown', 'settled'].includes(row.state),
      );
      // Misma huella ya enviada, o un envío ambiguo de cualquier huella: nunca se reenvía.
      const prior = committed.find(sameKey) ?? committed.find((row) => row.state !== 'settled');
      if (prior) return { ok: true, invocation: prior, reused: true } as const;
      if (committed.length >= input.maxCallsPerRun)
        return { ok: false, reason: 'RUN_CAP' } as const;
      const reserved = rows.find((row) => row.state === 'reserved' && sameKey(row));
      if (reserved) return { ok: true, invocation: reserved, reused: true } as const;
      // Reservas de otra huella: el dueño anterior perdió el lease antes de enviar.
      await tx.$executeRaw`
        UPDATE "ai_investigation_invocations" SET "state" = 'released', "updated_at" = ${input.at}
         WHERE "job_id" = ${jobId}::uuid AND "state" = 'reserved'`;

      const dayStart = new Date(
        Date.UTC(input.at.getUTCFullYear(), input.at.getUTCMonth(), input.at.getUTCDate()),
      );
      const totals = await tx.$queryRaw<{ committed: bigint | number | null }[]>`
        SELECT COALESCE(SUM(CASE "state"
                 WHEN 'released' THEN 0
                 WHEN 'settled' THEN COALESCE("estimated_micro_usd", 0)
                 ELSE "reserved_micro_usd" END), 0)::bigint AS "committed"
          FROM "ai_investigation_invocations"
         WHERE "tenant_id" = ${job.tenantId}
           AND "created_at" >= ${dayStart}
           AND "created_at" < ${new Date(dayStart.getTime() + DAY_MS)}`;
      if (Number(totals[0]?.committed ?? 0) + input.reservedMicroUsd > input.dailyCeilingMicroUsd) {
        return { ok: false, reason: 'DAILY_CAP' } as const;
      }

      const inserted = await tx.$queryRaw<RawInvocation[]>`
        INSERT INTO "ai_investigation_invocations" (
          "id", "job_id", "tenant_id", "phase", "fingerprint", "tier", "model", "state",
          "reserved_input_tokens", "reserved_output_tokens", "reserved_micro_usd",
          "rate_card_version", "created_at", "updated_at"
        ) VALUES (
          ${randomUUID()}::uuid, ${jobId}::uuid, ${job.tenantId}, ${input.phase},
          ${input.fingerprint}, ${input.tier}, ${input.model}, 'reserved',
          ${input.reservedInputTokens}::int, ${input.reservedOutputTokens}::int,
          ${input.reservedMicroUsd}::bigint, ${input.rateCardVersion}, ${input.at}, ${input.at}
        )
        ON CONFLICT ("job_id", "phase", "fingerprint") DO UPDATE
          SET "state" = 'reserved', "tier" = EXCLUDED."tier", "model" = EXCLUDED."model",
              "reserved_input_tokens" = EXCLUDED."reserved_input_tokens",
              "reserved_output_tokens" = EXCLUDED."reserved_output_tokens",
              "reserved_micro_usd" = EXCLUDED."reserved_micro_usd",
              "rate_card_version" = EXCLUDED."rate_card_version",
              "created_at" = EXCLUDED."created_at", "updated_at" = EXCLUDED."updated_at"
        WHERE "ai_investigation_invocations"."state" = 'released'
        RETURNING ${INVOCATION_COLUMNS}`;
      if (!inserted[0]) throw new Error('AI_INVESTIGATION_RESERVATION_RACE');
      return { ok: true, invocation: invocationOf(inserted[0]), reused: false } as const;
    });
  }

  /** Transición de una invocación, exigiendo el lease vigente del trabajo. */
  private async transition(
    jobId: string,
    fencingToken: number,
    invocationId: string,
    from: readonly string[],
    to: string,
    at: Date,
    requireNotCancelled = false,
  ): Promise<boolean> {
    const count = await this.client.$executeRaw`
      UPDATE "ai_investigation_invocations" AS i
         SET "state" = ${to}::text, "updated_at" = ${at}
        FROM "ai_investigation_jobs" AS j
       WHERE i."id" = ${invocationId}::uuid AND i."job_id" = ${jobId}::uuid
         AND i."state" = ANY(${[...from]}::text[])
         AND j."id" = i."job_id" AND j."fencing_token" = ${fencingToken}::int
         AND j."status" = 'running' AND j."lease_until" > ${at}
         AND (NOT ${requireNotCancelled}::boolean OR NOT j."cancel_requested")`;
    return count === 1;
  }

  public async markDispatching(
    jobId: string,
    fencingToken: number,
    invocationId: string,
    at: Date,
  ): Promise<'ok' | 'cancelled' | 'stale'> {
    if (
      await this.transition(
        jobId,
        fencingToken,
        invocationId,
        ['reserved'],
        'dispatching',
        at,
        true,
      )
    ) {
      return 'ok';
    }
    const rows = await this.client.$queryRaw<{ cancelRequested: boolean }[]>`
      SELECT j."cancel_requested" AS "cancelRequested"
        FROM "ai_investigation_jobs" AS j
        JOIN "ai_investigation_invocations" AS i ON i."job_id" = j."id"
       WHERE j."id" = ${jobId}::uuid AND j."fencing_token" = ${fencingToken}::int
         AND j."status" = 'running' AND j."lease_until" > ${at} AND i."id" = ${invocationId}::uuid AND i."state" = 'reserved'`;
    return rows[0]?.cancelRequested === true ? 'cancelled' : 'stale';
  }

  public async settleInvocation(
    jobId: string,
    fencingToken: number,
    invocationId: string,
    input: {
      readonly at: Date;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens: number;
      readonly cacheWriteTokens: number;
      readonly estimatedMicroUsd: number;
    },
  ): Promise<boolean> {
    const count = await this.client.$executeRaw`
      UPDATE "ai_investigation_invocations" AS i
         SET "state" = 'settled',
             "input_tokens" = ${input.inputTokens}::int,
             "output_tokens" = ${input.outputTokens}::int,
             "cache_read_tokens" = ${input.cacheReadTokens}::int,
             "cache_write_tokens" = ${input.cacheWriteTokens}::int,
             "estimated_micro_usd" = ${input.estimatedMicroUsd}::bigint,
             "settled_at" = ${input.at},
             "updated_at" = ${input.at}
        FROM "ai_investigation_jobs" AS j
       WHERE i."id" = ${invocationId}::uuid AND i."job_id" = ${jobId}::uuid
         AND i."state" = 'dispatching'
         AND j."id" = i."job_id" AND j."fencing_token" = ${fencingToken}::int
         AND j."status" = 'running' AND j."lease_until" > ${input.at}`;
    return count === 1;
  }

  public releaseInvocation(
    jobId: string,
    fencingToken: number,
    invocationId: string,
    at: Date,
  ): Promise<boolean> {
    return this.transition(
      jobId,
      fencingToken,
      invocationId,
      ['reserved', 'dispatching'],
      'released',
      at,
    );
  }

  public markUsageUnknown(
    jobId: string,
    fencingToken: number,
    invocationId: string,
    at: Date,
  ): Promise<boolean> {
    return this.transition(jobId, fencingToken, invocationId, ['dispatching'], 'usage_unknown', at);
  }

  /**
   * Guarda el resultado decidido y registra las acciones. Una acción `executed` o `planned` se
   * conserva; una `failed`/`skipped` vuelve a `planned`. `undefined` si el token es viejo.
   */
  public async planActions(
    jobId: string,
    fencingToken: number,
    input: {
      readonly at: Date;
      readonly status: string;
      readonly result: unknown;
      readonly inference: string;
      readonly evidence?: unknown;
      readonly errorCode: string | null;
      readonly actions: readonly AiPlannedActionInput[];
    },
  ): Promise<readonly AiInvestigationActionRow[] | undefined> {
    return this.client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ tenantId: string }[]>`
        UPDATE "ai_investigation_jobs"
           SET "planned_status" = ${input.status}::text,
               "result" = ${json(input.result)}::jsonb,
               "inference" = ${input.inference}::text,
               "evidence" = COALESCE(${json(input.evidence)}::jsonb, "evidence"),
               "last_error_code" = ${input.errorCode}::text,
               "updated_at" = ${input.at}
         WHERE "id" = ${jobId}::uuid AND "fencing_token" = ${fencingToken}::int
           AND "status" = 'running' AND "lease_until" > ${input.at}
        RETURNING "tenant_id" AS "tenantId"`;
      const job = rows[0];
      if (!job) return undefined;
      for (const action of input.actions) {
        await tx.$executeRaw`
          INSERT INTO "ai_investigation_actions" (
            "id", "job_id", "tenant_id", "kind", "state", "reason", "urgency", "group_key", "at"
          ) VALUES (
            ${randomUUID()}::uuid, ${jobId}::uuid, ${job.tenantId}, ${action.kind}, 'planned',
            ${action.reason}, ${action.urgency}, ${action.groupKey}, ${input.at}
          )
          ON CONFLICT ("job_id", "kind") DO UPDATE
            SET "state" = 'planned', "reason" = EXCLUDED."reason", "urgency" = EXCLUDED."urgency",
                "group_key" = EXCLUDED."group_key", "at" = EXCLUDED."at", "executed_at" = NULL,
                "ref_kind" = NULL, "ref_id" = NULL, "error_code" = NULL
          WHERE "ai_investigation_actions"."state" IN ('failed', 'skipped')`;
      }
      return tx.$queryRaw<AiInvestigationActionRow[]>`
        SELECT ${ACTION_COLUMNS} FROM "ai_investigation_actions"
         WHERE "job_id" = ${jobId}::uuid ORDER BY "at", "kind"`;
    });
  }

  public async markAction(
    jobId: string,
    fencingToken: number,
    kind: string,
    input: {
      readonly at: Date;
      readonly state: string;
      readonly refKind: string | null;
      readonly refId: string | null;
      readonly errorCode: string | null;
    },
  ): Promise<boolean> {
    const executedAt = input.state === 'executed' ? input.at : null;
    const count = await this.client.$executeRaw`
      UPDATE "ai_investigation_actions" AS a
         SET "state" = ${input.state}::text, "executed_at" = ${executedAt}::timestamptz,
             "ref_kind" = ${input.refKind}::text, "ref_id" = ${input.refId}::text,
             "error_code" = ${input.errorCode}::text
        FROM "ai_investigation_jobs" AS j
       WHERE a."job_id" = ${jobId}::uuid AND a."kind" = ${kind} AND a."state" = 'planned'
         AND j."id" = a."job_id" AND j."fencing_token" = ${fencingToken}::int
         AND j."status" = 'running' AND j."lease_until" > ${input.at}`;
    return count === 1;
  }

  public async actions(
    tenantId: string,
    jobId: string,
  ): Promise<readonly AiInvestigationActionRow[]> {
    return this.client.$queryRaw<AiInvestigationActionRow[]>`
      SELECT ${ACTION_COLUMNS} FROM "ai_investigation_actions"
       WHERE "job_id" = ${jobId}::uuid AND "tenant_id" = ${tenantId}
       ORDER BY "at", "kind"`;
  }

  public async actionsBetween(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<readonly AiInvestigationActionRow[]> {
    return this.client.$queryRaw<AiInvestigationActionRow[]>`
      SELECT ${ACTION_COLUMNS} FROM "ai_investigation_actions"
       WHERE "tenant_id" = ${tenantId} AND "at" >= ${from} AND "at" < ${to}
       ORDER BY "at", "id"
       LIMIT 5000`;
  }

  public async countImmediateReviews(tenantId: string, since: Date): Promise<number> {
    const rows = await this.client.$queryRaw<{ total: bigint | number }[]>`
      SELECT COUNT(*)::bigint AS "total" FROM "ai_investigation_actions"
       WHERE "tenant_id" = ${tenantId} AND "kind" = 'request_review'
         AND "urgency" = 'immediate' AND "state" <> 'skipped' AND "at" >= ${since}`;
    return Number(rows[0]?.total ?? 0);
  }

  /** Totales del día UTC que contiene `at`. */
  public async budgetTotals(tenantId: string, at: Date): Promise<AiBudgetTotalsRow> {
    const from = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    const to = new Date(from.getTime() + DAY_MS);
    type Sums = Record<
      | 'reservedMicroUsd'
      | 'settledMicroUsd'
      | 'unknownCount'
      | 'unknownMicroUsd'
      | 'inputTokens'
      | 'outputTokens'
      | 'cacheReadTokens'
      | 'cacheWriteTokens',
      bigint | number | null
    >;
    const [sums] = await this.client.$queryRaw<Sums[]>`
      SELECT
        COALESCE(SUM("reserved_micro_usd") FILTER (WHERE "state" IN ('reserved', 'dispatching')), 0)::bigint AS "reservedMicroUsd",
        COALESCE(SUM("estimated_micro_usd") FILTER (WHERE "state" = 'settled'), 0)::bigint AS "settledMicroUsd",
        COUNT(*) FILTER (WHERE "state" = 'usage_unknown')::bigint AS "unknownCount",
        COALESCE(SUM("reserved_micro_usd") FILTER (WHERE "state" = 'usage_unknown'), 0)::bigint AS "unknownMicroUsd",
        COALESCE(SUM("input_tokens") FILTER (WHERE "state" = 'settled'), 0)::bigint AS "inputTokens",
        COALESCE(SUM("output_tokens") FILTER (WHERE "state" = 'settled'), 0)::bigint AS "outputTokens",
        COALESCE(SUM("cache_read_tokens") FILTER (WHERE "state" = 'settled'), 0)::bigint AS "cacheReadTokens",
        COALESCE(SUM("cache_write_tokens") FILTER (WHERE "state" = 'settled'), 0)::bigint AS "cacheWriteTokens"
        FROM "ai_investigation_invocations"
       WHERE "tenant_id" = ${tenantId} AND "created_at" >= ${from} AND "created_at" < ${to}`;
    const runs = await this.client.$queryRaw<{ inference: string; total: bigint | number }[]>`
      SELECT "inference", COUNT(*)::bigint AS "total" FROM "ai_investigation_jobs"
       WHERE "tenant_id" = ${tenantId} AND "finished_at" >= ${from} AND "finished_at" < ${to}
         AND "inference" IS NOT NULL
       GROUP BY "inference"`;
    const run = (tier: string): number =>
      Number(runs.find((row) => row.inference === tier)?.total ?? 0);
    return {
      reservedMicroUsd: Number(sums?.reservedMicroUsd ?? 0),
      settledMicroUsd: Number(sums?.settledMicroUsd ?? 0),
      unknownCount: Number(sums?.unknownCount ?? 0),
      unknownMicroUsd: Number(sums?.unknownMicroUsd ?? 0),
      inputTokens: Number(sums?.inputTokens ?? 0),
      outputTokens: Number(sums?.outputTokens ?? 0),
      cacheReadTokens: Number(sums?.cacheReadTokens ?? 0),
      cacheWriteTokens: Number(sums?.cacheWriteTokens ?? 0),
      runsNone: run('none'),
      runsEconomy: run('economy'),
      runsAdvanced: run('advanced'),
    };
  }

  /**
   * Panel de actividad: cola actual (índice de estado), terminados en `[from, to)` (índice
   * `tenant_finished`) y estimado de invocaciones `settled` creadas en la ventana.
   */
  public async activityCounts(tenantId: string, from: Date, to: Date): Promise<AiActivityCountsRow> {
    const queue = await this.client.$queryRaw<
      { status: string; priority: string; total: bigint | number; oldest: Date | null }[]
    >`
      SELECT "status", "priority", COUNT(*)::bigint AS "total", MIN("created_at") AS "oldest"
        FROM "ai_investigation_jobs"
       WHERE "tenant_id" = ${tenantId} AND "status" IN ('queued', 'running')
       GROUP BY "status", "priority"`;
    const finished = await this.client.$queryRaw<
      { status: string; inference: string | null; total: bigint | number }[]
    >`
      SELECT "status", "inference", COUNT(*)::bigint AS "total" FROM "ai_investigation_jobs"
       WHERE "tenant_id" = ${tenantId} AND "finished_at" >= ${from} AND "finished_at" < ${to}
       GROUP BY "status", "inference"`;
    const [settled] = await this.client.$queryRaw<{ total: bigint | number | null }[]>`
      SELECT COALESCE(SUM("estimated_micro_usd"), 0)::bigint AS "total"
        FROM "ai_investigation_invocations"
       WHERE "tenant_id" = ${tenantId} AND "state" = 'settled'
         AND "created_at" >= ${from} AND "created_at" < ${to}`;
    return {
      queue: queue.map((row) => ({
        status: row.status,
        priority: row.priority,
        total: Number(row.total),
        oldest: row.oldest,
      })),
      finished: finished.map((row) => ({
        status: row.status,
        inference: row.inference,
        total: Number(row.total),
      })),
      settledMicroUsd: Number(settled?.total ?? 0),
    };
  }

  /** `running` + terminados desde `since`, actividad más reciente primero. */
  public async recentJobs(
    tenantId: string,
    since: Date,
    limit: number,
  ): Promise<readonly AiInvestigationJobRow[]> {
    const take = Math.min(Math.max(Math.trunc(limit) || 1, 1), 100);
    return this.client.$queryRaw<AiInvestigationJobRow[]>`
      SELECT ${JOB_COLUMNS} FROM (
        (SELECT * FROM "ai_investigation_jobs"
          WHERE "tenant_id" = ${tenantId} AND "status" = 'running'
          ORDER BY "created_at" DESC LIMIT ${take}::int)
        UNION ALL
        (SELECT * FROM "ai_investigation_jobs"
          WHERE "tenant_id" = ${tenantId} AND "finished_at" >= ${since}
            AND "status" NOT IN ('queued', 'running')
          ORDER BY "finished_at" DESC LIMIT ${take}::int)
      ) AS recent
       ORDER BY COALESCE("finished_at", "started_at", "updated_at") DESC, "id" DESC
       LIMIT ${take}::int`;
  }

  /** Disposición de las escalaciones ejecutadas (bitácora `acting/completed`, índice `tenant, at`). */
  public async escalationOutcomes(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<readonly { jobId: string; at: Date; disposition: string }[]> {
    return this.client.$queryRaw<{ jobId: string; at: Date; disposition: string }[]>`
      SELECT "job_id"::text AS "jobId", "at", "detail"->>'incident' AS "disposition"
        FROM "ai_investigation_events"
       WHERE "tenant_id" = ${tenantId} AND "at" >= ${from} AND "at" < ${to}
         AND "stage" = 'acting' AND "kind" = 'completed'
         AND "detail"->>'action' = 'escalate'
         AND "detail"->>'incident' IN ('created', 'attached')
       ORDER BY "at" DESC
       LIMIT 1000`;
  }

  /** Claves de idempotencia existentes (índice único `tenant_id, idempotency_key`). */
  public async existingKeys(tenantId: string, keys: readonly string[]): Promise<readonly string[]> {
    const wanted = [...new Set(keys)].slice(0, 2_000);
    if (wanted.length === 0) return [];
    const rows = await this.client.$queryRaw<{ key: string }[]>`
      SELECT "idempotency_key" AS "key" FROM "ai_investigation_jobs"
       WHERE "tenant_id" = ${tenantId} AND "idempotency_key" = ANY(${wanted}::text[])`;
    return rows.map((row) => row.key);
  }

  public async getSettings(tenantId: string): Promise<AiAnalystSettingsRow | undefined> {
    const rows = await this.client.$queryRaw<AiAnalystSettingsRow[]>`
      SELECT "tenant_id" AS "tenantId", "document", "revision", "updated_at" AS "updatedAt",
             "updated_by" AS "updatedBy"
        FROM "ai_analyst_settings" WHERE "tenant_id" = ${tenantId}`;
    return rows[0];
  }

  /** Compare-and-set: `expectedRevision` 0 crea; si no, exige la revisión leída. */
  public async putSettings(
    tenantId: string,
    document: unknown,
    expectedRevision: number,
    by: string,
    at: Date,
  ): Promise<boolean> {
    const body = JSON.stringify(document);
    const count =
      expectedRevision === 0
        ? await this.client.$executeRaw`
            INSERT INTO "ai_analyst_settings" ("tenant_id", "document", "revision", "updated_at", "updated_by")
            VALUES (${tenantId}, ${body}::jsonb, 1, ${at}, ${by})
            ON CONFLICT ("tenant_id") DO NOTHING`
        : await this.client.$executeRaw`
            UPDATE "ai_analyst_settings"
               SET "document" = ${body}::jsonb, "revision" = "revision" + 1,
                   "updated_at" = ${at}, "updated_by" = ${by}
             WHERE "tenant_id" = ${tenantId} AND "revision" = ${expectedRevision}::int`;
    return count === 1;
  }
}
