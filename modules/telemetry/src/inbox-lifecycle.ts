/**
 * C-13 — ciclo de vida de la bandeja de entrada, idempotencia y replay.
 *
 * Dominio puro: no conoce PostgreSQL, Redis ni reloj del sistema. Decide; no ejecuta.
 * El adaptador que persista estas decisiones debe satisfacer la suite de conformidad en
 * `testing/event-inbox-store.contract.ts`.
 *
 * La unicidad real vive en la base (`event_inbox_source_idempotency_key`): este módulo
 * decide, la base impide. Ninguna de las dos capas se confía a la otra.
 */

export const INBOX_STATUSES = [
  'admitted',
  'processing',
  'processed',
  'quarantined',
  'failed',
] as const;

export type InboxStatus = (typeof INBOX_STATUSES)[number];

/** Presupuesto de reintentos y backoff. Determinista: la misma entrada da la misma espera. */
export interface RetryPolicy {
  readonly maximumAttempts: number;
  readonly baseDelayMs: number;
  readonly maximumDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maximumAttempts: 5,
  baseDelayMs: 1_000,
  maximumDelayMs: 300_000,
});

/**
 * Un fallo `poison` no se reintenta nunca: reintentarlo solo repite el mismo rechazo y
 * bloquea la fuente. Un fallo `transient` sí, dentro del presupuesto.
 */
export type ProcessingFailure =
  | { readonly kind: 'poison'; readonly code: string; readonly path?: string }
  | { readonly kind: 'transient'; readonly code: string };

export interface InboxEntry {
  readonly sourceId: string;
  readonly idempotencyKey: string;
  readonly recordId: string;
  readonly status: InboxStatus;
  readonly attemptCount: number;
}

export type InboxCommand =
  | { readonly type: 'lease'; readonly at: Date; readonly leaseMs: number }
  | { readonly type: 'complete'; readonly at: Date }
  | { readonly type: 'fail'; readonly at: Date; readonly failure: ProcessingFailure }
  | { readonly type: 'reprocess'; readonly at: Date };

export type InboxDecision =
  | {
      readonly effect: 'transition';
      readonly to: InboxStatus;
      readonly attemptCount: number;
      readonly availableAt: Date;
      readonly lastErrorCode?: string;
    }
  | { readonly effect: 'noop'; readonly reason: InboxNoopReason }
  | { readonly effect: 'quarantine'; readonly code: string; readonly path?: string }
  | { readonly effect: 'reject'; readonly reason: InboxRejectReason };

export type InboxNoopReason = 'ALREADY_PROCESSED' | 'LEASE_STILL_HELD';
export type InboxRejectReason =
  'NOT_LEASED' | 'TERMINAL_STATUS' | 'NOT_QUARANTINED' | 'INVALID_LEASE';

function backoffMs(attempt: number, policy: RetryPolicy): number {
  // 2^(intento-1) sobre la base, acotado. Sin jitter: el reintento debe ser reproducible
  // en una spec, y la dispersión se obtiene del lease, no del cálculo.
  const exponent = Math.max(0, attempt - 1);
  const raw = policy.baseDelayMs * 2 ** Math.min(exponent, 30);
  return Math.min(raw, policy.maximumDelayMs);
}

/**
 * Decide la transición de una entrada de la bandeja. Nunca lanza: todo resultado es una
 * decisión explícita, incluido el rechazo.
 */
export function decideInboxTransition(
  entry: InboxEntry,
  command: InboxCommand,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): InboxDecision {
  // Un registro ya procesado es terminal: volver a entregarlo es un replay legítimo y no
  // debe producir efecto alguno. Ésta es la garantía de "al menos una vez" sin duplicar.
  if (entry.status === 'processed') {
    return command.type === 'complete' || command.type === 'lease'
      ? { effect: 'noop', reason: 'ALREADY_PROCESSED' }
      : { effect: 'reject', reason: 'TERMINAL_STATUS' };
  }

  switch (command.type) {
    case 'lease': {
      if (command.leaseMs <= 0) return { effect: 'reject', reason: 'INVALID_LEASE' };
      if (entry.status === 'processing') {
        return { effect: 'noop', reason: 'LEASE_STILL_HELD' };
      }
      if (entry.status === 'quarantined') {
        return { effect: 'reject', reason: 'TERMINAL_STATUS' };
      }
      return {
        effect: 'transition',
        to: 'processing',
        attemptCount: entry.attemptCount + 1,
        availableAt: new Date(command.at.getTime() + command.leaseMs),
      };
    }

    case 'complete': {
      if (entry.status !== 'processing') return { effect: 'reject', reason: 'NOT_LEASED' };
      return {
        effect: 'transition',
        to: 'processed',
        attemptCount: entry.attemptCount,
        availableAt: command.at,
      };
    }

    case 'fail': {
      if (entry.status !== 'processing') return { effect: 'reject', reason: 'NOT_LEASED' };

      if (command.failure.kind === 'poison') {
        return {
          effect: 'quarantine',
          code: command.failure.code,
          ...(command.failure.path === undefined ? {} : { path: command.failure.path }),
        };
      }

      // Agotado el presupuesto, el registro queda `failed` y visible, no reintentándose en
      // silencio para siempre.
      if (entry.attemptCount >= policy.maximumAttempts) {
        return {
          effect: 'transition',
          to: 'failed',
          attemptCount: entry.attemptCount,
          availableAt: command.at,
          lastErrorCode: command.failure.code,
        };
      }

      return {
        effect: 'transition',
        to: 'admitted',
        attemptCount: entry.attemptCount,
        availableAt: new Date(command.at.getTime() + backoffMs(entry.attemptCount, policy)),
        lastErrorCode: command.failure.code,
      };
    }

    case 'reprocess': {
      if (entry.status !== 'quarantined' && entry.status !== 'failed') {
        return { effect: 'reject', reason: 'NOT_QUARANTINED' };
      }
      // El reproceso reabre el registro sin borrar su historia: el contador de intentos
      // se conserva para que un poison en bucle siga siendo visible.
      return {
        effect: 'transition',
        to: 'admitted',
        attemptCount: entry.attemptCount,
        availableAt: command.at,
      };
    }
  }
}

export interface ReplayCandidate {
  readonly idempotencyKey: string;
  readonly recordId: string;
}

export interface ReplayPlan {
  readonly admit: readonly ReplayCandidate[];
  readonly duplicates: readonly ReplayCandidate[];
  readonly counts: {
    readonly received: number;
    readonly admit: number;
    readonly duplicates: number;
  };
}

/**
 * Separa lo nuevo de lo ya visto en una página que se vuelve a entregar. Reprocesar una
 * ventana completa debe admitir solo lo que falta, y los duplicados dentro de la propia
 * página se colapsan a uno.
 */
export function planReplay(
  candidates: readonly ReplayCandidate[],
  knownKeys: ReadonlySet<string>,
): ReplayPlan {
  const admit: ReplayCandidate[] = [];
  const duplicates: ReplayCandidate[] = [];
  const seenInPage = new Set<string>();

  for (const candidate of candidates) {
    if (knownKeys.has(candidate.idempotencyKey) || seenInPage.has(candidate.idempotencyKey)) {
      duplicates.push(candidate);
      continue;
    }
    seenInPage.add(candidate.idempotencyKey);
    admit.push(candidate);
  }

  return {
    admit: Object.freeze(admit),
    duplicates: Object.freeze(duplicates),
    counts: { received: candidates.length, admit: admit.length, duplicates: duplicates.length },
  };
}
