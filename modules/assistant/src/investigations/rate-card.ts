/**
 * Tarifa versionada. El host la entrega (configuración revisada): este módulo no afirma precios.
 * Todo importe calculado aquí es una **estimación**, nunca facturación confirmada.
 */

import type { InferenceTier, InvocationUsage } from './types.js';

export interface TierRates {
  readonly inputMicroUsdPerMTok: number;
  readonly outputMicroUsdPerMTok: number;
  readonly cacheReadMicroUsdPerMTok: number;
  readonly cacheWriteMicroUsdPerMTok: number;
}

export interface RateCard {
  /** Se guarda en cada invocación para reproducir la estimación. */
  readonly version: string;
  readonly tiers: Readonly<Record<InferenceTier, TierRates>>;
}

const PER_MTOK = 1_000_000;

/** Estimación en micro-USD del `usage` reportado (cuentas disjuntas), redondeada hacia arriba. */
export function estimateMicroUsd(
  usage: InvocationUsage,
  tier: InferenceTier,
  card: RateCard,
): number {
  const rates = card.tiers[tier];
  return Math.ceil(
    (usage.inputTokens * rates.inputMicroUsdPerMTok +
      usage.outputTokens * rates.outputMicroUsdPerMTok +
      usage.cacheReadTokens * rates.cacheReadMicroUsdPerMTok +
      usage.cacheWriteTokens * rates.cacheWriteMicroUsdPerMTok) /
      PER_MTOK,
  );
}

/**
 * Peor caso para reservar antes del envío: toda la entrada a la tarifa más cara entre entrada
 * normal y escritura de caché, y toda la salida permitida.
 */
export function worstCaseMicroUsd(
  inputTokens: number,
  outputTokens: number,
  tier: InferenceTier,
  card: RateCard,
): number {
  const rates = card.tiers[tier];
  const inputRate = Math.max(rates.inputMicroUsdPerMTok, rates.cacheWriteMicroUsdPerMTok);
  return Math.ceil(
    (inputTokens * inputRate + outputTokens * rates.outputMicroUsdPerMTok) / PER_MTOK,
  );
}
