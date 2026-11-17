/** PostgreSQL persistence for minimized Wazuh push hints. */

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '../generated/client/client.js';
import {
  closeDatabaseClient,
  createDatabaseClient,
  type DatabaseConnectionOptions,
} from './client.js';

// Persistence types intentionally stay local: modules/soc owns the port and depends on this
// adapter package, so importing its runtime barrel here would create a package cycle.
interface WazuhPushHint {
  readonly managerName: string;
  readonly alertId: string;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
}

type WazuhPushHintStatus = 'pending' | 'processing' | 'processed' | 'failed-terminal';

interface ClaimedWazuhPushHint extends WazuhPushHint {
  readonly id: string;
  readonly receivedAt: Date;
  readonly availableAt: Date;
  readonly attemptCount: number;
  readonly leaseUntil: Date;
  readonly claimId: string;
}

interface WazuhPushInboxMetrics {
  readonly counts: Readonly<Record<WazuhPushHintStatus, number>>;
  readonly oldestPendingAt: Date | null;
  readonly oldestProcessingAt: Date | null;
  readonly oldestUnresolvedAt: Date | null;
  readonly oldestTerminalAt: Date | null;
  readonly lastProcessedAt: Date | null;
  readonly expiredProcessing: number;
  readonly terminalFailuresRecent: number;
  readonly terminalWindowHours: 24;
  readonly sourceToReceiptMs: {
    readonly windowHours: 24;
    readonly sampleCount: number;
    readonly clockSkewSamples: number;
    readonly sampleCapReached: boolean;
    readonly p50: number | null;
    readonly p95: number | null;
    readonly p99: number | null;
  };
  readonly receiptToHandlerMs: {
    readonly windowHours: 24;
    readonly sampleCount: number;
    readonly p50: number | null;
    readonly p95: number | null;
    readonly p99: number | null;
  };
}

interface WazuhPushHintRow {
  readonly id: string;
  readonly manager_name: string;
  readonly alert_id: string;
  readonly occurred_at: string;
  readonly idempotency_key: string;
  readonly received_at: Date;
  readonly available_at: Date;
  readonly attempt_count: number;
  readonly lease_until: Date;
  readonly claim_id: string;
}

interface WazuhPushInboxMetricsRow {
  readonly pending_count: bigint | number;
  readonly processing_count: bigint | number;
  readonly processed_count: bigint | number;
  readonly failed_terminal_count: bigint | number;
  readonly expired_processing_count: bigint | number;
  readonly terminal_failures_recent_count: bigint | number;
  readonly processed_latency_sample_count: bigint | number;
  readonly processed_latency_p50_ms: number | null;
  readonly processed_latency_p95_ms: number | null;
  readonly processed_latency_p99_ms: number | null;
  readonly source_latency_sample_count: bigint | number;
  readonly source_latency_clock_skew_count: bigint | number;
  readonly source_latency_cap_reached: boolean;
  readonly source_latency_p50_ms: number | null;
  readonly source_latency_p95_ms: number | null;
  readonly source_latency_p99_ms: number | null;
  readonly oldest_pending_at: Date | null;
  readonly oldest_processing_at: Date | null;
  readonly oldest_unresolved_at: Date | null;
  readonly oldest_terminal_at: Date | null;
  readonly last_processed_at: Date | null;
}

const MAX_CLAIM_BATCH = 500;
const SOURCE_TO_RECEIPT_SAMPLE_CAP = 10_000;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;
const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

function isValidTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/u.exec(value);
  if (!match || !RFC3339_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > days[month - 1]!) return false;
  const zone = /([+-])(\d{2}):?(\d{2})$/u.exec(value);
  return !zone || (Number(zone[2]) <= 23 && Number(zone[3]) <= 59);
}

function assertValidHint(hint: WazuhPushHint): void {
  if (
    typeof hint.managerName !== 'string' ||
    !hint.managerName.trim() ||
    hint.managerName.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(hint.managerName) ||
    typeof hint.alertId !== 'string' ||
    !hint.alertId.trim() ||
    hint.alertId.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(hint.alertId) ||
    typeof hint.occurredAt !== 'string' ||
    hint.occurredAt.length > 64 ||
    !isValidTimestamp(hint.occurredAt) ||
    typeof hint.idempotencyKey !== 'string' ||
    !SHA256_HEX.test(hint.idempotencyKey)
  ) {
    throw new Error('WAZUH_PUSH_HINT_INVALID');
  }
}

function assertClaimPolicy(at: Date, limit: number, leaseMs: number): void {
  if (!Number.isFinite(at.getTime())) throw new Error('WAZUH_PUSH_INBOX_TIME_INVALID');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CLAIM_BATCH) {
    throw new Error('WAZUH_PUSH_INBOX_LIMIT_INVALID');
  }
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 30 * 60_000) {
    throw new Error('WAZUH_PUSH_INBOX_LEASE_INVALID');
  }
}

function assertSafeCode(safeCode: string): void {
  if (!ERROR_CODE.test(safeCode)) throw new Error('WAZUH_PUSH_INBOX_ERROR_CODE_INVALID');
}

function toClaim(row: WazuhPushHintRow): ClaimedWazuhPushHint {
  return {
    id: row.id,
    managerName: row.manager_name,
    alertId: row.alert_id,
    occurredAt: row.occurred_at,
    idempotencyKey: row.idempotency_key,
    receivedAt: row.received_at,
    availableAt: row.available_at,
    attemptCount: row.attempt_count,
    leaseUntil: row.lease_until,
    claimId: row.claim_id,
  };
}

/**
 * A receipt is acknowledged only after the insert commits. Claims use SKIP LOCKED and a
 * per-row fencing token; Indexer lookup and event promotion happen outside this adapter.
 */
export class PrismaWazuhPushInboxStore {
  public constructor(
    private readonly client: PrismaClient,
    private readonly ownsClient = false,
  ) {}

  public static connect(options: DatabaseConnectionOptions): PrismaWazuhPushInboxStore {
    return new PrismaWazuhPushInboxStore(createDatabaseClient(options), true);
  }

  /** Fails fast if the inbox migration is not installed or the DB cannot be reached. */
  public async ready(): Promise<void> {
    const rows = await this.client.$queryRaw<{ table_exists: boolean }[]>`
      SELECT to_regclass('public.wazuh_push_inbox_hints') IS NOT NULL AS "table_exists"`;
    if (rows[0]?.table_exists !== true) throw new Error('WAZUH_PUSH_INBOX_SCHEMA_NOT_READY');
    await this.client.$queryRaw`
      SELECT "id", "manager_name", "alert_id", "occurred_at", "idempotency_key", "status",
             "attempt_count", "received_at", "available_at", "lease_until", "claim_id",
             "last_error_code", "processed_at", "created_at", "updated_at"
        FROM "wazuh_push_inbox_hints"
       LIMIT 0`;
  }

  public async close(): Promise<void> {
    if (this.ownsClient) await closeDatabaseClient(this.client);
  }

  public async enqueue(
    hint: WazuhPushHint,
  ): Promise<'inserted' | 'duplicate' | 'reopened-terminal'> {
    assertValidHint(hint);
    const inserted = await this.client.$queryRaw<{ id: string }[]>`
      INSERT INTO "wazuh_push_inbox_hints"
        ("id", "manager_name", "alert_id", "occurred_at", "idempotency_key")
      VALUES
        (${randomUUID()}::uuid, ${hint.managerName}, ${hint.alertId}, ${hint.occurredAt}, ${hint.idempotencyKey})
      ON CONFLICT ("idempotency_key") DO NOTHING
      RETURNING "id"`;
    if (inserted.length === 1) return 'inserted';
    const existing = await this.client.wazuhPushInboxHint.findUnique({
      where: { idempotencyKey: hint.idempotencyKey },
      select: { id: true, managerName: true, alertId: true, occurredAt: true, status: true },
    });
    if (
      !existing ||
      existing.managerName !== hint.managerName ||
      existing.alertId !== hint.alertId ||
      existing.occurredAt !== hint.occurredAt
    ) {
      throw new Error('WAZUH_PUSH_HINT_IDEMPOTENCY_CONFLICT');
    }
    if (existing.status === 'failed-terminal') {
      const reopened = await this.client.$queryRaw<{ id: string }[]>`
        UPDATE "wazuh_push_inbox_hints"
           SET "status" = 'pending',
               "attempt_count" = 0,
               "available_at" = now(),
               "lease_until" = NULL,
               "claim_id" = NULL,
               "last_error_code" = NULL,
               "processed_at" = NULL,
               "updated_at" = now()
         WHERE "id" = ${existing.id}::uuid
           AND "status" = 'failed-terminal'
           AND "idempotency_key" = ${hint.idempotencyKey}
           AND "manager_name" = ${hint.managerName}
           AND "alert_id" = ${hint.alertId}
           AND "occurred_at" = ${hint.occurredAt}
        RETURNING "id"`;
      return reopened.length === 1 ? 'reopened-terminal' : 'duplicate';
    }
    return 'duplicate';
  }

  public async claimBatch(
    at: Date,
    limit: number,
    leaseMs: number,
  ): Promise<readonly ClaimedWazuhPushHint[]> {
    assertClaimPolicy(at, limit, leaseMs);
    const leaseUntil = new Date(at.getTime() + leaseMs);
    const rows = await this.client.$queryRaw<WazuhPushHintRow[]>`
      UPDATE "wazuh_push_inbox_hints" AS target
         SET "status" = 'processing',
             "lease_until" = ${leaseUntil},
             "claim_id" = gen_random_uuid(),
             "attempt_count" = target."attempt_count" + 1,
             "updated_at" = ${at}
       WHERE target."id" IN (
         SELECT candidate."id"
           FROM "wazuh_push_inbox_hints" AS candidate
          WHERE (candidate."status" = 'pending' AND candidate."available_at" <= ${at})
             OR (candidate."status" = 'processing' AND candidate."lease_until" <= ${at})
          ORDER BY candidate."available_at", candidate."received_at", candidate."id"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING target."id", target."manager_name", target."alert_id", target."occurred_at",
                target."idempotency_key", target."received_at", target."available_at",
                target."attempt_count", target."lease_until", target."claim_id"`;
    return rows
      .map(toClaim)
      .sort(
        (left, right) =>
          left.availableAt.getTime() - right.availableAt.getTime() ||
          left.receivedAt.getTime() - right.receivedAt.getTime() ||
          left.id.localeCompare(right.id),
      );
  }

  public async complete(claim: ClaimedWazuhPushHint): Promise<boolean> {
    const rows = await this.client.$queryRaw<{ id: string }[]>`
      UPDATE "wazuh_push_inbox_hints"
         SET "status" = 'processed',
             "processed_at" = now(),
             "lease_until" = NULL,
             "claim_id" = NULL,
             "last_error_code" = NULL,
             "updated_at" = now()
       WHERE "id" = ${claim.id}::uuid
         AND "status" = 'processing'
         AND "claim_id" = ${claim.claimId}::uuid
      RETURNING "id"`;
    return rows.length === 1;
  }

  public async scheduleRetry(
    claim: ClaimedWazuhPushHint,
    availableAt: Date,
    safeCode: string,
  ): Promise<boolean> {
    if (!Number.isFinite(availableAt.getTime())) throw new Error('WAZUH_PUSH_INBOX_TIME_INVALID');
    assertSafeCode(safeCode);
    const rows = await this.client.$queryRaw<{ id: string }[]>`
      UPDATE "wazuh_push_inbox_hints"
         SET "status" = 'pending',
             "available_at" = ${availableAt},
             "lease_until" = NULL,
             "claim_id" = NULL,
             "last_error_code" = ${safeCode},
             "updated_at" = now()
       WHERE "id" = ${claim.id}::uuid
         AND "status" = 'processing'
         AND "claim_id" = ${claim.claimId}::uuid
      RETURNING "id"`;
    return rows.length === 1;
  }

  public async failTerminal(claim: ClaimedWazuhPushHint, safeCode: string): Promise<boolean> {
    assertSafeCode(safeCode);
    const rows = await this.client.$queryRaw<{ id: string }[]>`
      UPDATE "wazuh_push_inbox_hints"
         SET "status" = 'failed-terminal',
             "lease_until" = NULL,
             "claim_id" = NULL,
             "last_error_code" = ${safeCode},
             "updated_at" = now()
       WHERE "id" = ${claim.id}::uuid
         AND "status" = 'processing'
         AND "claim_id" = ${claim.claimId}::uuid
      RETURNING "id"`;
    return rows.length === 1;
  }

  public async metrics(at = new Date()): Promise<WazuhPushInboxMetrics> {
    if (!Number.isFinite(at.getTime())) throw new Error('WAZUH_PUSH_INBOX_TIME_INVALID');
    const terminalWindowStart = new Date(at.getTime() - 24 * 60 * 60_000);
    const rows = await this.client.$queryRaw<WazuhPushInboxMetricsRow[]>`
      WITH source_window AS MATERIALIZED (
        SELECT "occurred_at", "received_at", "id"
          FROM "wazuh_push_inbox_hints"
         WHERE "received_at" >= ${terminalWindowStart}
           AND "received_at" <= ${at}
         ORDER BY "received_at" DESC, "id" DESC
         LIMIT ${SOURCE_TO_RECEIPT_SAMPLE_CAP + 1}
      ), source_sample AS MATERIALIZED (
        SELECT "occurred_at", "received_at", "id"
          FROM source_window
         ORDER BY "received_at" DESC, "id" DESC
         LIMIT ${SOURCE_TO_RECEIPT_SAMPLE_CAP}
      ), source_latency AS (
        SELECT CASE
                 WHEN pg_input_is_valid("occurred_at", 'timestamptz')
                 THEN ("received_at" - "occurred_at"::timestamptz)
               END AS latency
          FROM source_sample
      )
      SELECT
        count(*) FILTER (WHERE "status" = 'pending') AS "pending_count",
        count(*) FILTER (WHERE "status" = 'processing') AS "processing_count",
        count(*) FILTER (WHERE "status" = 'processed') AS "processed_count",
        count(*) FILTER (WHERE "status" = 'failed-terminal') AS "failed_terminal_count",
        count(*) FILTER (WHERE "status" = 'processing' AND "lease_until" <= ${at}) AS "expired_processing_count",
        count(*) FILTER (WHERE "status" = 'failed-terminal' AND "updated_at" >= ${terminalWindowStart}) AS "terminal_failures_recent_count",
        count(*) FILTER (WHERE "status" = 'processed' AND "processed_at" >= ${terminalWindowStart}) AS "processed_latency_sample_count",
        percentile_cont(0.50) WITHIN GROUP (ORDER BY (EXTRACT(EPOCH FROM ("processed_at" - "received_at")) * 1000)::double precision)
          FILTER (WHERE "status" = 'processed' AND "processed_at" >= ${terminalWindowStart}) AS "processed_latency_p50_ms",
        percentile_cont(0.95) WITHIN GROUP (ORDER BY (EXTRACT(EPOCH FROM ("processed_at" - "received_at")) * 1000)::double precision)
          FILTER (WHERE "status" = 'processed' AND "processed_at" >= ${terminalWindowStart}) AS "processed_latency_p95_ms",
        percentile_cont(0.99) WITHIN GROUP (ORDER BY (EXTRACT(EPOCH FROM ("processed_at" - "received_at")) * 1000)::double precision)
          FILTER (WHERE "status" = 'processed' AND "processed_at" >= ${terminalWindowStart}) AS "processed_latency_p99_ms",
        (SELECT count(*) FILTER (WHERE latency >= interval '0 seconds') FROM source_latency) AS "source_latency_sample_count",
        (SELECT count(*) FILTER (WHERE latency < interval '0 seconds') FROM source_latency) AS "source_latency_clock_skew_count",
        (SELECT count(*) FROM source_window) > ${SOURCE_TO_RECEIPT_SAMPLE_CAP} AS "source_latency_cap_reached",
        (SELECT percentile_cont(0.50) WITHIN GROUP (ORDER BY (EXTRACT(EPOCH FROM latency) * 1000)::double precision) FROM source_latency WHERE latency >= interval '0 seconds') AS "source_latency_p50_ms",
        (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY (EXTRACT(EPOCH FROM latency) * 1000)::double precision) FROM source_latency WHERE latency >= interval '0 seconds') AS "source_latency_p95_ms",
        (SELECT percentile_cont(0.99) WITHIN GROUP (ORDER BY (EXTRACT(EPOCH FROM latency) * 1000)::double precision) FROM source_latency WHERE latency >= interval '0 seconds') AS "source_latency_p99_ms",
        min("received_at") FILTER (WHERE "status" = 'pending') AS "oldest_pending_at",
        min("received_at") FILTER (WHERE "status" = 'processing') AS "oldest_processing_at",
        min("received_at") FILTER (WHERE "status" IN ('pending', 'processing')) AS "oldest_unresolved_at",
        min("received_at") FILTER (WHERE "status" = 'failed-terminal') AS "oldest_terminal_at",
        max("processed_at") FILTER (WHERE "status" = 'processed') AS "last_processed_at"
      FROM "wazuh_push_inbox_hints"`;
    const row = rows[0];
    const count = (value: bigint | number | undefined) => Number(value ?? 0);
    return {
      counts: {
        pending: count(row?.pending_count),
        processing: count(row?.processing_count),
        processed: count(row?.processed_count),
        'failed-terminal': count(row?.failed_terminal_count),
      } satisfies Record<WazuhPushHintStatus, number>,
      oldestPendingAt: row?.oldest_pending_at ?? null,
      oldestProcessingAt: row?.oldest_processing_at ?? null,
      oldestUnresolvedAt: row?.oldest_unresolved_at ?? null,
      oldestTerminalAt: row?.oldest_terminal_at ?? null,
      lastProcessedAt: row?.last_processed_at ?? null,
      expiredProcessing: count(row?.expired_processing_count),
      terminalFailuresRecent: count(row?.terminal_failures_recent_count),
      terminalWindowHours: 24,
      sourceToReceiptMs: {
        windowHours: 24,
        sampleCount: count(row?.source_latency_sample_count),
        clockSkewSamples: count(row?.source_latency_clock_skew_count),
        sampleCapReached: row?.source_latency_cap_reached ?? false,
        p50:
          row?.source_latency_p50_ms === null ? null : Math.round(row?.source_latency_p50_ms ?? 0),
        p95:
          row?.source_latency_p95_ms === null ? null : Math.round(row?.source_latency_p95_ms ?? 0),
        p99:
          row?.source_latency_p99_ms === null ? null : Math.round(row?.source_latency_p99_ms ?? 0),
      },
      receiptToHandlerMs: {
        windowHours: 24,
        sampleCount: count(row?.processed_latency_sample_count),
        p50: row?.processed_latency_p50_ms ?? null,
        p95: row?.processed_latency_p95_ms ?? null,
        p99: row?.processed_latency_p99_ms ?? null,
      },
    };
  }
}
