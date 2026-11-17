import { configurationError } from '../configuration.errors.js';
import type { EnvironmentInput } from '../configuration.types.js';
import type { ConfigurationProfile } from '../profiles/index.js';

/**
 * Variables de Qapaqzito (asistente IA). La configuración efectiva la construye
 * `apps/api/src/assistant/assistant-config.ts`; aquí se valida al arrancar para que un valor
 * inválido falle con `CONFIG_VALUE_INVALID` (sin exponer el valor) antes de servir tráfico.
 */
export const ASSISTANT_VARIABLES = [
  'QAPAQ_QAPAQZITO_ENABLED',
  'QAPAQ_QAPAQZITO_PROVIDER',
  'QAPAQ_QAPAQZITO_MODEL',
  'QAPAQ_QAPAQZITO_EFFORT',
  'QAPAQ_QAPAQZITO_REDACT_PII',
  'QAPAQ_QAPAQZITO_API_KEY',
  'QAPAQ_QAPAQZITO_TIMEOUT_MS',
  'QAPAQ_QAPAQZITO_RATE_LIMIT',
  'QAPAQ_QAPAQZITO_HISTORY_ENABLED',
  'QAPAQ_QAPAQZITO_RETENTION_DAYS',
  'QAPAQ_REPORTS_URL',
  'QAPAQ_REPORTS_TOKEN',
] as const;

/**
 * Variables del Analista IA (docs/27). Proveedor y credenciales se reutilizan de Qapaqzito
 * (`QAPAQ_QAPAQZITO_PROVIDER`, `QAPAQ_QAPAQZITO_API_KEY`, región AWS): no hay secretos nuevos. La
 * configuración efectiva la arma `apps/api/src/assistant/analyst-config.ts`.
 */
export const ANALYST_VARIABLES = [
  'QAPAQ_ANALYST_ENABLED',
  'QAPAQ_ANALYST_ECONOMY_MODEL',
  'QAPAQ_ANALYST_ADVANCED_MODEL',
  'QAPAQ_ANALYST_DAILY_CEILING_USD',
  'QAPAQ_ANALYST_RATE_CARD',
  'QAPAQ_ANALYST_CONCURRENCY',
  'QAPAQ_ANALYST_BACKLOG_SWEEP',
] as const;

/** Tarifa por nivel en micro-USD por millón de tokens (cuentas disjuntas). */
export interface AnalystTierRates {
  readonly inputMicroUsdPerMTok: number;
  readonly outputMicroUsdPerMTok: number;
  readonly cacheReadMicroUsdPerMTok: number;
  readonly cacheWriteMicroUsdPerMTok: number;
}

export interface AnalystRateCardInput {
  readonly version: string;
  readonly tiers: { readonly economy: AnalystTierRates; readonly advanced: AnalystTierRates };
}

const RATE_FIELDS = [
  'inputMicroUsdPerMTok',
  'outputMicroUsdPerMTok',
  'cacheReadMicroUsdPerMTok',
  'cacheWriteMicroUsdPerMTok',
] as const;

/**
 * `QAPAQ_ANALYST_RATE_CARD`: JSON cerrado `{ version, tiers: { economy, advanced } }` con enteros
 * micro-USD/MTok. `undefined` si el texto no es una tarifa válida (sin decir por qué: el valor no
 * se refleja en errores).
 */
export function parseAnalystRateCard(raw: string): AnalystRateCardInput | undefined {
  if (raw.length > 4096) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const record = (input: unknown): Record<string, unknown> | undefined =>
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const root = record(value);
  const tiers = record(root?.['tiers']);
  if (!root || !tiers || Object.keys(root).sort().join(',') !== 'tiers,version') return undefined;
  const version = root['version'];
  if (typeof version !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/u.test(version)) return undefined;
  if (Object.keys(tiers).sort().join(',') !== 'advanced,economy') return undefined;
  const tier = (input: unknown): AnalystTierRates | undefined => {
    const rates = record(input);
    if (!rates || Object.keys(rates).sort().join(',') !== [...RATE_FIELDS].sort().join(',')) {
      return undefined;
    }
    for (const field of RATE_FIELDS) {
      const rate = rates[field];
      if (typeof rate !== 'number' || !Number.isInteger(rate) || rate < 0 || rate > 1_000_000_000) {
        return undefined;
      }
    }
    return rates as unknown as AnalystTierRates;
  };
  const economy = tier(tiers['economy']);
  const advanced = tier(tiers['advanced']);
  return economy && advanced ? { version, tiers: { economy, advanced } } : undefined;
}

/** `QAPAQ_ANALYST_DAILY_CEILING_USD` en micro-USD (0 < x ≤ 1000 USD); `undefined` si no es válido. */
export function parseAnalystCeilingUsd(raw: string): number | undefined {
  if (!/^\d{1,4}(?:\.\d{1,6})?$/u.test(raw)) return undefined;
  const micro = Math.round(Number(raw) * 1_000_000);
  return Number.isSafeInteger(micro) && micro > 0 && micro <= 1_000_000_000 ? micro : undefined;
}

export const ASSISTANT_PROVIDERS = ['bedrock', 'anthropic'] as const;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const FLAGS = ['true', 'false'];

function integerIn(raw: string, min: number, max: number): boolean {
  if (!/^\d{1,6}$/u.test(raw)) return false;
  const value = Number(raw);
  return value >= min && value <= max;
}

export function validateAssistantEnvironment(
  environment: EnvironmentInput,
  profile?: ConfigurationProfile,
): void {
  const fail = (name: string): never => {
    throw configurationError('CONFIG_VALUE_INVALID', name, profile?.name);
  };
  const value = (name: string): string | undefined => {
    const raw = environment[name];
    return raw === undefined || raw === '' ? undefined : raw;
  };
  for (const name of ['QAPAQ_QAPAQZITO_ENABLED', 'QAPAQ_QAPAQZITO_REDACT_PII', 'QAPAQ_QAPAQZITO_HISTORY_ENABLED']) {
    const raw = value(name);
    if (raw !== undefined && !FLAGS.includes(raw)) fail(name);
  }
  const provider = value('QAPAQ_QAPAQZITO_PROVIDER');
  if (provider !== undefined && !(ASSISTANT_PROVIDERS as readonly string[]).includes(provider)) {
    fail('QAPAQ_QAPAQZITO_PROVIDER');
  }
  const effort = value('QAPAQ_QAPAQZITO_EFFORT');
  if (effort !== undefined && !EFFORTS.includes(effort)) fail('QAPAQ_QAPAQZITO_EFFORT');
  const model = value('QAPAQ_QAPAQZITO_MODEL');
  if (model !== undefined && !/^[A-Za-z0-9._:-]{3,100}$/u.test(model)) fail('QAPAQ_QAPAQZITO_MODEL');
  const rate = value('QAPAQ_QAPAQZITO_RATE_LIMIT');
  if (rate !== undefined && !integerIn(rate, 1, 600)) fail('QAPAQ_QAPAQZITO_RATE_LIMIT');
  const retention = value('QAPAQ_QAPAQZITO_RETENTION_DAYS');
  if (retention !== undefined && !integerIn(retention, 1, 365)) fail('QAPAQ_QAPAQZITO_RETENTION_DAYS');
  const timeout = value('QAPAQ_QAPAQZITO_TIMEOUT_MS');
  if (timeout !== undefined && !integerIn(timeout, 1000, 120_000)) fail('QAPAQ_QAPAQZITO_TIMEOUT_MS');
  const apiKey = value('QAPAQ_QAPAQZITO_API_KEY');
  if (apiKey !== undefined && (apiKey.length > 512 || !/^[\x21-\x7e]+$/u.test(apiKey))) {
    fail('QAPAQ_QAPAQZITO_API_KEY');
  }
  // Informes (servicio qapaq-reports): ambos o ninguno; sin ellos la herramienta responde `unavailable`.
  const reportsUrl = value('QAPAQ_REPORTS_URL');
  if (reportsUrl !== undefined) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(reportsUrl);
    } catch {
      parsed = undefined;
    }
    if (
      !parsed ||
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      reportsUrl.length > 512
    ) {
      fail('QAPAQ_REPORTS_URL');
    }
  }
  const reportsToken = value('QAPAQ_REPORTS_TOKEN');
  if (
    reportsToken !== undefined &&
    (reportsToken.length < 16 || reportsToken.length > 512 || !/^[!-~]+$/u.test(reportsToken))
  ) {
    fail('QAPAQ_REPORTS_TOKEN');
  }
  if (reportsUrl !== undefined && reportsToken === undefined) {
    throw configurationError('CONFIG_REQUIRED_VALUE_MISSING', 'QAPAQ_REPORTS_TOKEN', profile?.name);
  }
  if (value('QAPAQ_QAPAQZITO_ENABLED') === 'true' && provider === 'anthropic' && apiKey === undefined) {
    throw configurationError('CONFIG_REQUIRED_VALUE_MISSING', 'QAPAQ_QAPAQZITO_API_KEY', profile?.name);
  }
  // Analista IA: apagado por defecto; reutiliza proveedor y credenciales de Qapaqzito.
  for (const name of ['QAPAQ_ANALYST_ENABLED', 'QAPAQ_ANALYST_BACKLOG_SWEEP']) {
    const raw = value(name);
    if (raw !== undefined && !FLAGS.includes(raw)) fail(name);
  }
  for (const name of ['QAPAQ_ANALYST_ECONOMY_MODEL', 'QAPAQ_ANALYST_ADVANCED_MODEL']) {
    const raw = value(name);
    if (raw !== undefined && !/^[A-Za-z0-9._:-]{3,100}$/u.test(raw)) fail(name);
  }
  const ceiling = value('QAPAQ_ANALYST_DAILY_CEILING_USD');
  if (ceiling !== undefined && parseAnalystCeilingUsd(ceiling) === undefined) {
    fail('QAPAQ_ANALYST_DAILY_CEILING_USD');
  }
  const rateCard = value('QAPAQ_ANALYST_RATE_CARD');
  if (rateCard !== undefined && parseAnalystRateCard(rateCard) === undefined) {
    fail('QAPAQ_ANALYST_RATE_CARD');
  }
  const concurrency = value('QAPAQ_ANALYST_CONCURRENCY');
  if (concurrency !== undefined && !integerIn(concurrency, 1, 4)) fail('QAPAQ_ANALYST_CONCURRENCY');
  if (value('QAPAQ_ANALYST_ENABLED') === 'true' && provider === 'anthropic' && apiKey === undefined) {
    throw configurationError('CONFIG_REQUIRED_VALUE_MISSING', 'QAPAQ_QAPAQZITO_API_KEY', profile?.name);
  }
}
