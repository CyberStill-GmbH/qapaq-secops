/** Durable receipt of minimized Wazuh push hints. Raw alert bodies are never stored here. */

export interface WazuhPushHint {
  readonly managerName: string;
  readonly alertId: string;
  /** Original RFC 3339 timestamp from the Wazuh alert, retained for exact Indexer lookup. */
  readonly occurredAt: string;
  /** Stable digest of the source identity, computed by the trusted API boundary. */
  readonly idempotencyKey: string;
}

// Wazuh's `timestamp` commonly uses ISO-8601 offsets without a colon (`+0000`).
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

/** Validates the minimized hint before it can be durably accepted. */
export function assertWazuhPushHint(hint: WazuhPushHint): void {
  const validName =
    typeof hint.managerName === 'string' &&
    hint.managerName.trim().length > 0 &&
    hint.managerName.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(hint.managerName);
  const validId =
    typeof hint.alertId === 'string' &&
    hint.alertId.trim().length > 0 &&
    hint.alertId.length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(hint.alertId);
  const validTime =
    typeof hint.occurredAt === 'string' &&
    hint.occurredAt.length <= 64 &&
    isValidTimestamp(hint.occurredAt);
  const validIdempotencyKey =
    typeof hint.idempotencyKey === 'string' && SHA256_HEX.test(hint.idempotencyKey);
  if (!validName || !validId || !validTime || !validIdempotencyKey) {
    throw new Error('WAZUH_PUSH_HINT_INVALID');
  }
}

export type WazuhPushHintStatus = 'pending' | 'processing' | 'processed' | 'failed-terminal';

export interface ClaimedWazuhPushHint extends WazuhPushHint {
  readonly id: string;
  readonly receivedAt: Date;
  readonly availableAt: Date;
  readonly attemptCount: number;
  readonly leaseUntil: Date;
  /** Fencing token; stale workers cannot complete or reschedule this hint. */
  readonly claimId: string;
}

export interface WazuhPushInboxMetrics {
  readonly counts: Readonly<Record<WazuhPushHintStatus, number>>;
  readonly oldestPendingAt: Date | null;
  readonly oldestProcessingAt: Date | null;
  readonly oldestUnresolvedAt: Date | null;
  readonly oldestTerminalAt: Date | null;
  readonly lastProcessedAt: Date | null;
  readonly expiredProcessing: number;
  readonly terminalFailuresRecent: number;
  readonly terminalWindowHours: 24;
  /** Original Wazuh event timestamp to the first durable API receipt; clock-skew samples excluded. */
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

export interface WazuhPushInboxStore {
  /** Durable unique insert; an exact duplicate may reopen a terminal receipt, never a processed one. */
  enqueue(hint: WazuhPushHint): Promise<'inserted' | 'duplicate' | 'reopened-terminal'>;
  /** Claims ready or lease-expired hints atomically; claims are fenced by `claimId`. */
  claimBatch(at: Date, limit: number, leaseMs: number): Promise<readonly ClaimedWazuhPushHint[]>;
  /** Returns false when the claim has expired or has been replaced. */
  complete(claim: ClaimedWazuhPushHint): Promise<boolean>;
  /** Schedules a retry and records only a safe catalog-style error code. */
  scheduleRetry(claim: ClaimedWazuhPushHint, availableAt: Date, safeCode: string): Promise<boolean>;
  /** Permanently closes a poison hint; its receipt remains for dedupe and auditability. */
  failTerminal(claim: ClaimedWazuhPushHint, safeCode: string): Promise<boolean>;
  /** Queue counts and age of oldest pending/processing receipt for operational health. */
  metrics(at?: Date): Promise<WazuhPushInboxMetrics>;
}
