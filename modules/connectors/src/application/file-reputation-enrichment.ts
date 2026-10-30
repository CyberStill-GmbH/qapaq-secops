/**
 * Enriquecimiento de reputación por hash con cuota y caché por tenant.
 *
 * La cuota del servicio externo es del tenant, no del proceso: se cuenta en el almacenamiento
 * compartido (PostgreSQL en despliegue) para que dos réplicas o un reinicio no la dupliquen. El
 * orden es deliberado:
 *
 * 1. Caché vigente → se responde sin consultar y sin gastar cuota.
 * 2. Se reserva un uso de forma atómica; si no cabe en la ventana de minuto o de día, no se
 *    consulta. La reserva ocurre antes de la llamada porque el servicio cuenta la petición
 *    aunque falle o responda 404.
 * 3. Se consulta y solo un resultado (`found` o `unknown`) se guarda en caché; un error no.
 */

import type { FileHash, FileReputation, FileReputationQuota } from '@qapaq/contracts';

import {
  FileReputationProviderError,
  type FileReputationErrorCode,
  type FileReputationLookup,
  type FileReputationProvider,
} from './file-reputation-provider.js';

export interface FileReputationLimits {
  readonly perMinute: number;
  readonly perDay: number;
}

/** Límites de la API pública: 4 peticiones por minuto y 500 por día. */
export const PUBLIC_FILE_REPUTATION_LIMITS: FileReputationLimits = Object.freeze({
  perMinute: 4,
  perDay: 500,
});
export const FILE_REPUTATION_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface CachedFileReputation {
  readonly tenantId: string;
  readonly providerId: string;
  readonly hash: FileHash;
  readonly lookup: FileReputationLookup;
  readonly checkedAt: Date;
  readonly expiresAt: Date;
}

/** Ventanas de cuota evaluadas en un instante: minuto móvil y día calendario UTC. */
export interface QuotaWindows {
  readonly at: Date;
  /** Usos con `at > minuteSince` cuentan para el minuto. */
  readonly minuteSince: Date;
  /** Usos con `at >= daySince` cuentan para el día. */
  readonly daySince: Date;
  readonly limits: FileReputationLimits;
}

export interface QuotaUsage {
  readonly minuteUsed: number;
  readonly dayUsed: number;
  /** Uso más antiguo dentro del minuto: cuándo se libera el siguiente cupo. */
  readonly oldestInMinute: Date | null;
}

export interface FileReputationStore {
  cached(
    tenantId: string,
    providerId: string,
    hash: FileHash,
    now: Date,
  ): Promise<CachedFileReputation | undefined>;
  remember(entry: CachedFileReputation): Promise<void>;
  /**
   * Reserva un uso si cabe en ambas ventanas. Debe ser atómico frente a otras réplicas: dos
   * reservas simultáneas no pueden ver el mismo cupo libre.
   */
  consume(
    tenantId: string,
    providerId: string,
    windows: QuotaWindows,
  ): Promise<{ readonly granted: boolean; readonly usage: QuotaUsage }>;
  usage(tenantId: string, providerId: string, windows: QuotaWindows): Promise<QuotaUsage>;
}

export type FileReputationOutcome =
  | {
      readonly kind: 'resolved';
      readonly status: 'found' | 'unknown';
      readonly reputation: FileReputation | null;
      readonly cached: boolean;
      readonly checkedAt: Date;
      readonly quota: FileReputationQuota;
    }
  | {
      readonly kind: 'quota_exhausted';
      readonly window: 'minute' | 'day';
      readonly retryAfterMs: number;
      readonly quota: FileReputationQuota;
    }
  | {
      readonly kind: 'provider_failed';
      readonly code: FileReputationErrorCode;
      readonly quota: FileReputationQuota;
    };

export interface FileReputationDependencies {
  readonly provider: FileReputationProvider;
  readonly store: FileReputationStore;
  readonly now: () => Date;
  readonly limits?: FileReputationLimits;
  readonly cacheTtlMs?: number;
}

export function quotaWindows(at: Date, limits: FileReputationLimits): QuotaWindows {
  const daySince = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  return { at, minuteSince: new Date(at.getTime() - MINUTE_MS), daySince, limits };
}

function quotaView(windows: QuotaWindows, usage: QuotaUsage): FileReputationQuota {
  return {
    minute: {
      limit: windows.limits.perMinute,
      remaining: Math.max(windows.limits.perMinute - usage.minuteUsed, 0),
    },
    day: {
      limit: windows.limits.perDay,
      remaining: Math.max(windows.limits.perDay - usage.dayUsed, 0),
      resetsAt: new Date(windows.daySince.getTime() + DAY_MS).toISOString(),
    },
  };
}

export async function enrichFileReputation(
  dependencies: FileReputationDependencies,
  input: { readonly tenantId: string; readonly hash: FileHash },
): Promise<FileReputationOutcome> {
  const { provider, store } = dependencies;
  const limits = dependencies.limits ?? PUBLIC_FILE_REPUTATION_LIMITS;
  const now = dependencies.now();
  const windows = quotaWindows(now, limits);

  const cached = await store.cached(input.tenantId, provider.providerId, input.hash, now);
  if (cached) {
    const usage = await store.usage(input.tenantId, provider.providerId, windows);
    return {
      kind: 'resolved',
      status: cached.lookup.status,
      reputation: cached.lookup.status === 'found' ? cached.lookup.reputation : null,
      cached: true,
      checkedAt: cached.checkedAt,
      quota: quotaView(windows, usage),
    };
  }

  const reservation = await store.consume(input.tenantId, provider.providerId, windows);
  if (!reservation.granted) {
    const dayExhausted = reservation.usage.dayUsed >= limits.perDay;
    const retryAt = dayExhausted
      ? windows.daySince.getTime() + DAY_MS
      : (reservation.usage.oldestInMinute?.getTime() ?? now.getTime()) + MINUTE_MS;
    return {
      kind: 'quota_exhausted',
      window: dayExhausted ? 'day' : 'minute',
      retryAfterMs: Math.max(retryAt - now.getTime(), 1_000),
      quota: quotaView(windows, reservation.usage),
    };
  }
  const quota = quotaView(windows, reservation.usage);

  let lookup: FileReputationLookup;
  try {
    lookup = await provider.lookup(input.hash);
  } catch (error) {
    return {
      kind: 'provider_failed',
      code: error instanceof FileReputationProviderError ? error.code : 'REPUTATION_UNAVAILABLE',
      quota,
    };
  }
  const checkedAt = dependencies.now();
  await store.remember({
    tenantId: input.tenantId,
    providerId: provider.providerId,
    hash: input.hash,
    lookup,
    checkedAt,
    expiresAt: new Date(
      checkedAt.getTime() + (dependencies.cacheTtlMs ?? FILE_REPUTATION_CACHE_TTL_MS),
    ),
  });
  return {
    kind: 'resolved',
    status: lookup.status,
    reputation: lookup.status === 'found' ? lookup.reputation : null,
    cached: false,
    checkedAt,
    quota,
  };
}

/**
 * Store en memoria para specs y desarrollo. Las operaciones son síncronas entre lectura y
 * escritura, así que la reserva es atómica dentro del proceso; no protege entre réplicas.
 */
export class InMemoryFileReputationStore implements FileReputationStore {
  readonly #cache = new Map<string, CachedFileReputation>();
  readonly #uses = new Map<string, Date[]>();

  public async cached(
    tenantId: string,
    providerId: string,
    hash: FileHash,
    now: Date,
  ): Promise<CachedFileReputation | undefined> {
    const entry = this.#cache.get(`${tenantId}\u0000${providerId}\u0000${hash.value}`);
    return entry && entry.expiresAt.getTime() > now.getTime() ? entry : undefined;
  }

  public async remember(entry: CachedFileReputation): Promise<void> {
    this.#cache.set(`${entry.tenantId}\u0000${entry.providerId}\u0000${entry.hash.value}`, entry);
  }

  public async consume(tenantId: string, providerId: string, windows: QuotaWindows) {
    const uses = this.#usesOf(tenantId, providerId, windows);
    const usage = this.#count(uses, windows);
    if (usage.minuteUsed >= windows.limits.perMinute || usage.dayUsed >= windows.limits.perDay) {
      return { granted: false, usage };
    }
    uses.push(windows.at);
    return { granted: true, usage: this.#count(uses, windows) };
  }

  public async usage(tenantId: string, providerId: string, windows: QuotaWindows) {
    return this.#count(this.#usesOf(tenantId, providerId, windows), windows);
  }

  #usesOf(tenantId: string, providerId: string, windows: QuotaWindows): Date[] {
    const key = `${tenantId}\u0000${providerId}`;
    // Lo que ya no cae en ninguna ventana se descarta (al cruzar la medianoche UTC, el último
    // minuto del día anterior todavía cuenta para el minuto móvil).
    const horizon = Math.min(windows.daySince.getTime(), windows.minuteSince.getTime());
    const uses = (this.#uses.get(key) ?? []).filter((at) => at.getTime() >= horizon);
    this.#uses.set(key, uses);
    return uses;
  }

  #count(uses: readonly Date[], windows: QuotaWindows): QuotaUsage {
    const inMinute = uses.filter((at) => at.getTime() > windows.minuteSince.getTime());
    return {
      minuteUsed: inMinute.length,
      dayUsed: uses.filter((at) => at.getTime() >= windows.daySince.getTime()).length,
      oldestInMinute: inMinute.reduce<Date | null>(
        (oldest, at) => (oldest === null || at < oldest ? at : oldest),
        null,
      ),
    };
  }
}
