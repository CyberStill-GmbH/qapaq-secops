/**
 * C-25 — Smart Lockout y limitación de tasa en el borde QAPAQ.
 *
 * Entra aplica su propio Smart Lockout sobre la contraseña; esto protege lo que Entra no
 * ve: los intentos contra el BFF (callback, refresco, enumeración de identificadores).
 *
 * Dos propiedades deliberadas:
 *
 * - **No enumeración**: el resultado observable es el mismo para un sujeto existente y
 *   uno inexistente. El bloqueo cuenta por (sujeto, origen), nunca confirma la cuenta.
 * - **Familiaridad**: un origen ya visto con éxito para ese sujeto tolera más intentos
 *   que uno desconocido, igual que el Smart Lockout de Entra, para que un atacante
 *   remoto no pueda bloquear a una persona legítima desde su propia oficina.
 */

export const LOCKOUT_POLICY = Object.freeze({
  /** Intentos fallidos desde un origen desconocido antes de bloquear. */
  unfamiliarThreshold: 5,
  /** Intentos desde un origen ya familiar para ese sujeto. */
  familiarThreshold: 10,
  windowMs: 15 * 60 * 1000,
  baseLockoutMs: 60 * 1000,
  maximumLockoutMs: 30 * 60 * 1000,
});

export const RATE_LIMIT_POLICY = Object.freeze({
  /** Peticiones por origen y ventana sobre los endpoints de autenticación. */
  maxRequests: 30,
  windowMs: 60 * 1000,
});

export interface AttemptCounter {
  readonly subjectKey: string;
  readonly originKey: string;
  readonly failures: number;
  readonly windowStartedAt: Date;
  readonly lockoutLevel: number;
  /** `undefined` es "sin bloqueo vigente"; se escribe explícitamente al limpiarlo. */
  readonly lockedUntil?: Date | undefined;
  readonly familiar: boolean;
}

export type LockoutDecision =
  | { readonly allowed: true; readonly remainingAttempts: number }
  | { readonly allowed: false; readonly retryAfterMs: number };

export function emptyCounter(
  subjectKey: string,
  originKey: string,
  now: Date,
  familiar = false,
): AttemptCounter {
  return {
    subjectKey,
    originKey,
    failures: 0,
    windowStartedAt: now,
    lockoutLevel: 0,
    familiar,
  };
}

function threshold(counter: AttemptCounter): number {
  return counter.familiar ? LOCKOUT_POLICY.familiarThreshold : LOCKOUT_POLICY.unfamiliarThreshold;
}

function expireWindow(counter: AttemptCounter, now: Date): AttemptCounter {
  if (now.getTime() - counter.windowStartedAt.getTime() < LOCKOUT_POLICY.windowMs) return counter;
  return { ...counter, failures: 0, windowStartedAt: now };
}

export function evaluateLockout(counter: AttemptCounter, now: Date): LockoutDecision {
  if (counter.lockedUntil && counter.lockedUntil.getTime() > now.getTime()) {
    return { allowed: false, retryAfterMs: counter.lockedUntil.getTime() - now.getTime() };
  }
  const current = expireWindow(counter, now);
  return { allowed: true, remainingAttempts: Math.max(0, threshold(current) - current.failures) };
}

/** Registra un fallo. El bloqueo crece exponencialmente hasta el tope de la política. */
export function registerFailure(counter: AttemptCounter, now: Date): AttemptCounter {
  const current = expireWindow(counter, now);
  const failures = current.failures + 1;
  if (failures < threshold(current)) return { ...current, failures };
  const level = current.lockoutLevel + 1;
  const duration = Math.min(
    LOCKOUT_POLICY.baseLockoutMs * 2 ** (level - 1),
    LOCKOUT_POLICY.maximumLockoutMs,
  );
  return {
    ...current,
    failures: 0,
    windowStartedAt: now,
    lockoutLevel: level,
    lockedUntil: new Date(now.getTime() + duration),
  };
}

/** Un éxito limpia los fallos y marca el origen como familiar para ese sujeto. */
export function registerSuccess(counter: AttemptCounter, now: Date): AttemptCounter {
  return {
    ...counter,
    failures: 0,
    windowStartedAt: now,
    lockoutLevel: 0,
    familiar: true,
    lockedUntil: undefined,
  };
}

export interface RateLimitState {
  readonly key: string;
  readonly count: number;
  readonly windowStartedAt: Date;
}

export type RateLimitDecision =
  | { readonly allowed: true; readonly state: RateLimitState; readonly remaining: number }
  | { readonly allowed: false; readonly state: RateLimitState; readonly retryAfterMs: number };

export function consumeRateLimit(
  state: RateLimitState | undefined,
  key: string,
  now: Date,
): RateLimitDecision {
  const current =
    !state || now.getTime() - state.windowStartedAt.getTime() >= RATE_LIMIT_POLICY.windowMs
      ? { key, count: 0, windowStartedAt: now }
      : state;
  if (current.count >= RATE_LIMIT_POLICY.maxRequests) {
    return {
      allowed: false,
      state: current,
      retryAfterMs: current.windowStartedAt.getTime() + RATE_LIMIT_POLICY.windowMs - now.getTime(),
    };
  }
  const next = { ...current, count: current.count + 1 };
  return { allowed: true, state: next, remaining: RATE_LIMIT_POLICY.maxRequests - next.count };
}
