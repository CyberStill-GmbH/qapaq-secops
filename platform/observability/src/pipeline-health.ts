/**
 * C-15 — señales del pipeline y estado de salud.
 *
 * El criterio del plan es que `healthy`, `degraded` y `failed` se puedan **provocar y
 * observar**, no que exista un endpoint que casi siempre diga "ok". Por eso el estado se
 * deriva de umbrales explícitos sobre señales medibles, y cada estado llega acompañado de
 * las razones que lo produjeron: un `degraded` sin motivo legible no es accionable.
 */

export const HEALTH_STATES = ['healthy', 'degraded', 'failed'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export const HEALTH_REASONS = [
  'DEPENDENCY_DOWN',
  'NO_RECENT_SUCCESS',
  'INGESTION_LAG',
  'QUARANTINE_RATE',
  'ERROR_RATE',
] as const;
export type HealthReason = (typeof HEALTH_REASONS)[number];

export interface PipelineSignals {
  /** Dependencias duras caídas (base, índice, cola). Una sola basta para `failed`. */
  readonly dependenciesDown: readonly string[];
  /** Antigüedad del último ciclo exitoso. */
  readonly lastSuccessAgeSeconds: number;
  /** Retraso entre la ocurrencia del evento y su admisión. */
  readonly ingestionLagSeconds: number;
  /** Proporción de registros enviados a cuarentena en la ventana. */
  readonly quarantineRate: number;
  /** Proporción de ciclos con error en la ventana. */
  readonly errorRate: number;
}

export interface HealthThresholds {
  readonly lagDegradedSeconds: number;
  readonly lagFailedSeconds: number;
  readonly quarantineDegradedRate: number;
  readonly quarantineFailedRate: number;
  readonly errorDegradedRate: number;
  readonly errorFailedRate: number;
  readonly staleSuccessDegradedSeconds: number;
  readonly staleSuccessFailedSeconds: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = Object.freeze({
  lagDegradedSeconds: 300,
  lagFailedSeconds: 1_800,
  quarantineDegradedRate: 0.05,
  quarantineFailedRate: 0.25,
  errorDegradedRate: 0.1,
  errorFailedRate: 0.5,
  staleSuccessDegradedSeconds: 900,
  staleSuccessFailedSeconds: 3_600,
});

export interface HealthAssessment {
  readonly state: HealthState;
  readonly reasons: readonly HealthReason[];
}

/**
 * Evalúa todas las condiciones y se queda con la más grave. Las razones se acumulan: si
 * algo está caído y además hay retraso, el informe dice ambas cosas.
 */
export function evaluateHealth(
  signals: PipelineSignals,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): HealthAssessment {
  const reasons: HealthReason[] = [];
  let state: HealthState = 'healthy';

  const escalate = (candidate: HealthState, reason: HealthReason) => {
    reasons.push(reason);
    if (candidate === 'failed' || (candidate === 'degraded' && state === 'healthy')) {
      state = candidate;
    }
  };

  if (signals.dependenciesDown.length > 0) escalate('failed', 'DEPENDENCY_DOWN');

  if (signals.lastSuccessAgeSeconds >= thresholds.staleSuccessFailedSeconds) {
    escalate('failed', 'NO_RECENT_SUCCESS');
  } else if (signals.lastSuccessAgeSeconds >= thresholds.staleSuccessDegradedSeconds) {
    escalate('degraded', 'NO_RECENT_SUCCESS');
  }

  if (signals.ingestionLagSeconds >= thresholds.lagFailedSeconds) {
    escalate('failed', 'INGESTION_LAG');
  } else if (signals.ingestionLagSeconds >= thresholds.lagDegradedSeconds) {
    escalate('degraded', 'INGESTION_LAG');
  }

  if (signals.quarantineRate >= thresholds.quarantineFailedRate) {
    escalate('failed', 'QUARANTINE_RATE');
  } else if (signals.quarantineRate >= thresholds.quarantineDegradedRate) {
    escalate('degraded', 'QUARANTINE_RATE');
  }

  if (signals.errorRate >= thresholds.errorFailedRate) {
    escalate('failed', 'ERROR_RATE');
  } else if (signals.errorRate >= thresholds.errorDegradedRate) {
    escalate('degraded', 'ERROR_RATE');
  }

  return { state, reasons: Object.freeze(reasons) };
}

export interface PipelineCounters {
  readonly received: number;
  readonly normalized: number;
  readonly quarantined: number;
  readonly duplicates: number;
}

export interface PipelineRates {
  readonly coverage: number;
  readonly quarantineRate: number;
  readonly duplicateRate: number;
  readonly lossless: boolean;
}

/**
 * Series derivadas del recorrido: cobertura, tasa de cuarentena y duplicados. `lossless`
 * es la invariante que importa de verdad: todo lo recibido salió por alguna puerta.
 */
export function deriveRates(counters: PipelineCounters): PipelineRates {
  const { received, normalized, quarantined, duplicates } = counters;
  if (received === 0) {
    return { coverage: 1, quarantineRate: 0, duplicateRate: 0, lossless: true };
  }
  return {
    coverage: normalized / received,
    quarantineRate: quarantined / received,
    duplicateRate: duplicates / received,
    lossless: normalized + quarantined + duplicates === received,
  };
}
