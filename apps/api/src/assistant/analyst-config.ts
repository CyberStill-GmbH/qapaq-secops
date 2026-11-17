/**
 * Configuración de despliegue del Analista IA (docs/27). Apagado por defecto.
 *
 * - `QAPAQ_ANALYST_ENABLED=true` arranca el bucle dentro del API. Sin él, la API sigue sirviendo la
 *   lista, el presupuesto y los ajustes (la administración ve que está apagado) y no corre nada.
 * - Proveedor y credenciales se REUTILIZAN de Qapaqzito (`QAPAQ_QAPAQZITO_PROVIDER`, `QAPAQ_QAPAQZITO_API_KEY`,
 *   `QAPAQ_AWS_REGION`/`AWS_REGION`, `QAPAQ_QAPAQZITO_TIMEOUT_MS`); no hay secretos propios. En Bedrock se
 *   aplica la misma regla de prefijo `anthropic.` que `assistant-config.ts`.
 * - `QAPAQ_ANALYST_DAILY_CEILING_USD` es el techo duro del despliegue: los ajustes de la consola solo
 *   pueden bajarlo. Sin techo no hay inferencia (todo se resuelve con reglas deterministas).
 * - La tarifa es una ESTIMACIÓN versionada (nunca facturación): la de fábrica o
 *   `QAPAQ_ANALYST_RATE_CARD`.
 *
 * Las mismas reglas se validan al arrancar en `platform/configuration` (assistant.schema.ts).
 */

import { parseAnalystCeilingUsd, parseAnalystRateCard } from '@qapaq/configuration';
import type { RateCard } from '@qapaq/assistant';

import { AssistantConfigError, QAPAQZITO_PROVIDERS, DEFAULT_QAPAQZITO_TIMEOUT_MS, type QapaqzitoProvider } from './assistant-config.js';

export const DEFAULT_ANALYST_ECONOMY_MODEL = 'claude-haiku-5-5';
export const DEFAULT_ANALYST_ADVANCED_MODEL = 'claude-sonnet-5-5';

/**
 * Tarifa de fábrica: precios públicos de lista de la API de Anthropic consultados el 2026-11-03
 * (Haiku 5.5: 0,10/0,50 USD por MTok para prompts ≤100K; Sonnet 5.5: 2/10 USD, lectura de caché
 * 0,10). Lectura y escritura de caché de Haiku y escritura de Sonnet se estiman con los factores
 * habituales (0,1× y 1,25× de la entrada). Bedrock factura con su propia lista: es una ESTIMACIÓN.
 */
export const BUILT_IN_ANALYST_RATE_CARD: RateCard = Object.freeze({
  version: 'anthropic-list-2026-11-03-estimate',
  tiers: Object.freeze({
    economy: Object.freeze({
      inputMicroUsdPerMTok: 100_000,
      outputMicroUsdPerMTok: 500_000,
      cacheReadMicroUsdPerMTok: 10_000,
      cacheWriteMicroUsdPerMTok: 125_000,
    }),
    advanced: Object.freeze({
      inputMicroUsdPerMTok: 2_000_000,
      outputMicroUsdPerMTok: 10_000_000,
      cacheReadMicroUsdPerMTok: 100_000,
      cacheWriteMicroUsdPerMTok: 2_500_000,
    }),
  }),
});

export interface AnalystProviderConfig {
  readonly provider: QapaqzitoProvider;
  readonly apiKey?: string;
  readonly awsRegion?: string;
  /** Tiempo máximo del intento único (sin reintentos del SDK). */
  readonly timeoutMs: number;
}

export interface AnalystConfig {
  /** Bucle activo en este proceso. */
  readonly enabled: boolean;
  /** Proveedor (solo si `enabled`; sin él no hay modelos y todo queda determinista). */
  readonly provider: AnalystProviderConfig | undefined;
  /** IDs tal como los espera el proveedor (en Bedrock con prefijo `anthropic.`). */
  readonly models: { readonly economy: string; readonly advanced: string };
  /** Techo diario del despliegue en micro-USD estimados; `null` = sin inferencia. */
  readonly dailyCeilingMicroUsd: number | null;
  readonly rateCard: RateCard;
  /** Trabajos simultáneos en este proceso (1–4). */
  readonly concurrency: number;
  /** Barrido periódico de alertas abiertas sin investigación (P1 primero). */
  readonly backlogSweep: boolean;
}

type Environment = Readonly<Record<string, string | undefined>>;

function present(environment: Environment, name: string): string | undefined {
  const value = environment[name];
  return value === undefined || value === '' ? undefined : value;
}

function flag(environment: Environment, name: string, fallback: boolean): boolean {
  const value = present(environment, name);
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new AssistantConfigError(name);
}

function modelId(environment: Environment, name: string, fallback: string, provider: QapaqzitoProvider) {
  const value = present(environment, name) ?? fallback;
  if (!/^[A-Za-z0-9._:-]{3,100}$/u.test(value)) throw new AssistantConfigError(name);
  return provider === 'bedrock' && !value.startsWith('anthropic.') ? `anthropic.${value}` : value;
}

export function loadAnalystConfig(environment: Environment): AnalystConfig {
  const enabled = flag(environment, 'QAPAQ_ANALYST_ENABLED', false);
  const provider = (present(environment, 'QAPAQ_QAPAQZITO_PROVIDER') ?? 'bedrock') as QapaqzitoProvider;
  if (!QAPAQZITO_PROVIDERS.includes(provider)) throw new AssistantConfigError('QAPAQ_QAPAQZITO_PROVIDER');
  const ceilingRaw = present(environment, 'QAPAQ_ANALYST_DAILY_CEILING_USD');
  const dailyCeilingMicroUsd = ceilingRaw === undefined ? null : parseAnalystCeilingUsd(ceilingRaw);
  if (dailyCeilingMicroUsd === undefined) {
    throw new AssistantConfigError('QAPAQ_ANALYST_DAILY_CEILING_USD');
  }
  const cardRaw = present(environment, 'QAPAQ_ANALYST_RATE_CARD');
  const rateCard = cardRaw === undefined ? BUILT_IN_ANALYST_RATE_CARD : parseAnalystRateCard(cardRaw);
  if (!rateCard) throw new AssistantConfigError('QAPAQ_ANALYST_RATE_CARD');
  const concurrencyRaw = present(environment, 'QAPAQ_ANALYST_CONCURRENCY') ?? '1';
  const concurrency = /^[1-4]$/u.test(concurrencyRaw) ? Number(concurrencyRaw) : Number.NaN;
  if (!Number.isInteger(concurrency)) throw new AssistantConfigError('QAPAQ_ANALYST_CONCURRENCY');
  const backlogSweep = flag(environment, 'QAPAQ_ANALYST_BACKLOG_SWEEP', true);
  const models = {
    economy: modelId(environment, 'QAPAQ_ANALYST_ECONOMY_MODEL', DEFAULT_ANALYST_ECONOMY_MODEL, provider),
    advanced: modelId(environment, 'QAPAQ_ANALYST_ADVANCED_MODEL', DEFAULT_ANALYST_ADVANCED_MODEL, provider),
  };

  let providerConfig: AnalystProviderConfig | undefined;
  if (enabled) {
    const apiKey = present(environment, 'QAPAQ_QAPAQZITO_API_KEY');
    if (provider === 'anthropic' && !apiKey) throw new AssistantConfigError('QAPAQ_QAPAQZITO_API_KEY');
    const awsRegion = present(environment, 'QAPAQ_AWS_REGION') ?? present(environment, 'AWS_REGION');
    if (provider === 'bedrock' && !awsRegion) throw new AssistantConfigError('AWS_REGION');
    const timeoutRaw = present(environment, 'QAPAQ_QAPAQZITO_TIMEOUT_MS');
    const timeoutMs = timeoutRaw ? Number(timeoutRaw) : DEFAULT_QAPAQZITO_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
      throw new AssistantConfigError('QAPAQ_QAPAQZITO_TIMEOUT_MS');
    }
    providerConfig = {
      provider,
      ...(apiKey ? { apiKey } : {}),
      ...(awsRegion ? { awsRegion } : {}),
      // El analista no reintenta: un intento algo más largo que el de Qapaqzito (30 s mínimo).
      timeoutMs: Math.max(timeoutMs, 30_000),
    };
  }
  return {
    enabled,
    provider: providerConfig,
    models,
    dailyCeilingMicroUsd,
    rateCard,
    concurrency,
    backlogSweep,
  };
}
