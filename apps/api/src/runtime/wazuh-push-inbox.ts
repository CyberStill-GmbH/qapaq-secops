import type {
  ProviderRecord,
  WazuhAlertHintLookup,
  WazuhAlertHintLookupProvider,
} from '@qapaq/connectors';
import type { SecurityEvent } from '@qapaq/contracts';
import type { ClaimedWazuhPushHint, WazuhPushInboxStore } from '@qapaq/soc';
import { wazuhRecordToEvent } from './wazuh-ingestion.js';

export const WAZUH_PUSH_INBOX_POLICY = Object.freeze({
  batchSize: 8,
  maximumConcurrency: 8,
  leaseMs: 120_000,
  intervalMs: 250,
  retryBaseMs: 250,
  retryMaximumMs: 60_000,
  retryJitterRatio: 0.2,
});

export interface WazuhPushInboxPassOptions {
  readonly store: WazuhPushInboxStore;
  readonly provider: WazuhAlertHintLookupProvider;
  readonly tenantId: string;
  readonly sourceId: string;
  readonly now: () => Date;
  readonly promote: (
    event: SecurityEvent,
  ) => Promise<'promoted' | 'duplicate' | 'not_promoted' | 'below_threshold' | 'suppressed'>;
}

function safeErrorCode(error: unknown): string {
  const candidate = error as { code?: unknown } | null;
  return typeof candidate?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(candidate.code)
    ? candidate.code
    : 'WAZUH_PUSH_PROCESSING_FAILED';
}

function retryable(error: unknown): boolean {
  return (error as { retryable?: unknown } | null)?.retryable !== false;
}

function deterministicJitter(hint: ClaimedWazuhPushHint): number {
  const seed = Number.parseInt(hint.idempotencyKey.slice(0, 8), 16) >>> 0;
  const unit = seed / 0xffff_ffff;
  const ratio = WAZUH_PUSH_INBOX_POLICY.retryJitterRatio;
  return 1 - ratio + unit * ratio * 2;
}

export function wazuhPushRetryDelayMs(hint: ClaimedWazuhPushHint): number {
  const exponent = Math.min(Math.max(0, hint.attemptCount - 1), 16);
  const base = Math.min(
    WAZUH_PUSH_INBOX_POLICY.retryMaximumMs,
    WAZUH_PUSH_INBOX_POLICY.retryBaseMs * 2 ** exponent,
  );
  return Math.min(
    WAZUH_PUSH_INBOX_POLICY.retryMaximumMs,
    Math.max(1, Math.round(base * deterministicJitter(hint))),
  );
}

function scheduleRetry(
  options: WazuhPushInboxPassOptions,
  hint: ClaimedWazuhPushHint,
  code: string,
): Promise<boolean> {
  const delay = wazuhPushRetryDelayMs(hint);
  return options.store.scheduleRetry(hint, new Date(options.now().getTime() + delay), code);
}

async function processHint(
  options: WazuhPushInboxPassOptions,
  hint: ClaimedWazuhPushHint,
): Promise<void> {
  let lookup: WazuhAlertHintLookup;
  try {
    lookup = await options.provider.findByAlertHint({
      managerName: hint.managerName,
      alertId: hint.alertId,
      occurredAt: hint.occurredAt,
    });
  } catch (error) {
    if (retryable(error)) await scheduleRetry(options, hint, safeErrorCode(error));
    else await options.store.failTerminal(hint, safeErrorCode(error));
    return;
  }

  if (lookup.status === 'missing') {
    // Indexer refresh/replication lag is not a poisoned hint. Keep the durable receipt pending
    // with bounded deterministic jitter until the document becomes visible or Wazuh redelivers
    // the same signed hint after a terminal validation failure.
    await scheduleRetry(options, hint, 'INDEXER_HINT_NOT_VISIBLE');
    return;
  }
  if (lookup.status === 'ambiguous') {
    await options.store.failTerminal(hint, 'INDEXER_HINT_AMBIGUOUS');
    return;
  }
  if (lookup.status !== 'found') return;

  try {
    const converted = toEvent(lookup.record, options.tenantId, options.sourceId, options.now());
    if (converted.status === 'quarantined') {
      await options.store.failTerminal(hint, 'INDEXER_ALERT_QUARANTINED');
      return;
    }

    // This uses the same Indexer document and converter as pull, so event record identity matches.
    // If the process stops after promotion but before complete(), promoteEvent is idempotent.
    await options.promote(converted.event);
    await options.store.complete(hint);
  } catch (error) {
    if (retryable(error)) await scheduleRetry(options, hint, safeErrorCode(error));
    else await options.store.failTerminal(hint, safeErrorCode(error));
  }
}

function toEvent(record: ProviderRecord, tenantId: string, sourceId: string, receivedAt: Date) {
  return wazuhRecordToEvent(record, tenantId, sourceId, receivedAt);
}

/** One durable inbox pass; the dispatcher supplies quick wake-ups and periodic recovery scans. */
export function createWazuhPushInboxPass(
  options: WazuhPushInboxPassOptions,
): () => Promise<number> {
  return async () => {
    const claims = await options.store.claimBatch(
      options.now(),
      WAZUH_PUSH_INBOX_POLICY.batchSize,
      WAZUH_PUSH_INBOX_POLICY.leaseMs,
    );
    // The Indexer connector is I/O-bound. Bounded parallel lookups reduce event latency while
    // keeping work per lease predictable; SKIP LOCKED lets other API replicas claim other rows.
    const outcomes = await Promise.allSettled(
      claims
        .slice(0, WAZUH_PUSH_INBOX_POLICY.maximumConcurrency)
        .map((claim) => processHint(options, claim)),
    );
    if (outcomes.some((outcome) => outcome.status === 'rejected')) {
      throw Object.assign(new Error('WAZUH_PUSH_INBOX_PASS_FAILED'), {
        code: 'WAZUH_PUSH_INBOX_PASS_FAILED',
      });
    }
    return claims.length;
  };
}
