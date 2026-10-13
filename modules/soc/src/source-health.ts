/**
 * Sprint 5 · fase 2 — salud por fuente (source-health.md).
 *
 * `evaluateSourceHealth` es una máquina de estados pura: recibe las observaciones de poll más
 * recientes, la política de la fuente y la hora, y devuelve estado y motivo. No tiene reloj ni
 * E/S propios, así que se prueba por tabla y da lo mismo evaluarla al terminar una pasada que
 * al leer la salud (que es cuando se nota una fuente que dejó de pasar).
 *
 * Reglas, en orden de precedencia:
 * 1. Fuente no habilitada → `disabled`. Es una exclusión declarada, no un `unknown`.
 * 2. Sin observaciones → `unknown`. Nunca verde por omisión.
 * 3. Última pasada con error permanente (credencial, permisos, consulta rechazada) → `failed`.
 * 4. Sin éxito durante `failAfterIntervals` intervalos → `failed`; durante
 *    `degradeAfterIntervals` → `degraded`. La edad se mide desde el último éxito o, si nunca
 *    hubo, desde el primer intento observado.
 * 5. Fallos transitorios seguidos (`degradeAfterIntervals` o más) → `degraded`.
 * 6. Nunca hubo éxito (y no venció ninguna ventana) → `unknown`.
 * 7. Si no → `healthy`.
 *
 * Un éxito con cero filas cuenta como éxito (avanza `lastSuccessAt`) y no toca `lastEventAt`:
 * «sin eventos» no es «fuente caída». La actividad de eventos es informativa y no decide el
 * estado.
 */

import type { SourcePollObservation } from './ingestion.js';

export const SOURCE_HEALTH_STATES = [
  'unknown',
  'healthy',
  'degraded',
  'failed',
  'disabled',
] as const;
export type SourceHealthState = (typeof SOURCE_HEALTH_STATES)[number];

export const SOURCE_HEALTH_REASONS = [
  'DISABLED',
  'NO_OBSERVATIONS',
  'PERMANENT_ERROR',
  'NO_RECENT_SUCCESS',
  'CONSECUTIVE_FAILURES',
  'NEVER_SUCCEEDED',
  'RECENT_SUCCESS',
] as const;
export type SourceHealthReason = (typeof SOURCE_HEALTH_REASONS)[number];

/** Política por fuente: los umbrales son datos, no constantes repartidas por el código. */
export interface SourceHealthPolicy {
  /** Intervalo esperado entre pasadas. */
  readonly intervalMs: number;
  readonly degradeAfterIntervals: number;
  readonly failAfterIntervals: number;
}

/** Punto de partida acordado en source-health.md: degradar tras 2 intervalos, fallar tras 3. */
export const DEFAULT_SOURCE_HEALTH_POLICY = Object.freeze({
  degradeAfterIntervals: 2,
  failAfterIntervals: 3,
});

export interface SourceHealthEvaluation {
  readonly state: SourceHealthState;
  readonly reason: SourceHealthReason;
  readonly lastAttemptAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly lastEventAt: Date | null;
  readonly consecutiveFailures: number;
  /** Código del último error (catálogo neutral); `null` si la última pasada fue exitosa. */
  readonly lastErrorClass: string | null;
}

/**
 * @param observations más recientes primero (como las devuelve el store).
 */
export function evaluateSourceHealth(
  observations: readonly SourcePollObservation[],
  policy: SourceHealthPolicy,
  now: Date,
  enabled: boolean,
): SourceHealthEvaluation {
  const newest = observations[0];
  const lastSuccess = observations.find((item) => item.outcome === 'success');
  const lastEventAt = observations.reduce<Date | null>(
    (latest, item) =>
      item.newestEventAt && (!latest || item.newestEventAt > latest) ? item.newestEventAt : latest,
    null,
  );
  let consecutiveFailures = 0;
  for (const item of observations) {
    if (item.outcome === 'success') break;
    consecutiveFailures += 1;
  }
  const facts = {
    lastAttemptAt: newest?.attemptedAt ?? null,
    lastSuccessAt: lastSuccess?.completedAt ?? null,
    lastEventAt,
    consecutiveFailures,
    lastErrorClass: newest && newest.outcome !== 'success' ? newest.errorClass : null,
  };
  const result = (state: SourceHealthState, reason: SourceHealthReason) => ({
    state,
    reason,
    ...facts,
  });

  if (!enabled) return result('disabled', 'DISABLED');
  if (!newest) return result('unknown', 'NO_OBSERVATIONS');
  if (newest.outcome === 'permanent_error') return result('failed', 'PERMANENT_ERROR');

  const since = (lastSuccess?.completedAt ?? observations.at(-1)!.attemptedAt).getTime();
  const age = now.getTime() - since;
  if (age > policy.failAfterIntervals * policy.intervalMs) {
    return result('failed', 'NO_RECENT_SUCCESS');
  }
  if (age > policy.degradeAfterIntervals * policy.intervalMs) {
    return result('degraded', 'NO_RECENT_SUCCESS');
  }
  if (consecutiveFailures >= policy.degradeAfterIntervals) {
    return result('degraded', 'CONSECUTIVE_FAILURES');
  }
  if (!lastSuccess) return result('unknown', 'NEVER_SUCCEEDED');
  return result('healthy', 'RECENT_SUCCESS');
}

/** Transición registrada en la bitácora append-only de la fuente. */
export interface SourceHealthTransition {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceId: string;
  readonly dataset: string;
  readonly fromState: SourceHealthState | null;
  readonly toState: SourceHealthState;
  readonly reason: SourceHealthReason;
  readonly at: Date;
}
