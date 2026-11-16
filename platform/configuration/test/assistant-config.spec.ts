import { describe, expect, it } from 'vitest';

import {
  ANALYST_VARIABLES,
  ASSISTANT_VARIABLES,
  parseAnalystCeilingUsd,
  parseAnalystRateCard,
  ConfigurationError,
  KNOWN_QAPAQ_VARIABLES,
  loadApiConfig,
} from '../src/index.js';

function expectInvalid(environment: Record<string, string>, code: string, path: string): void {
  try {
    loadApiConfig({ QAPAQ_PROFILE: 'test', ...environment });
    throw new Error('Expected ConfigurationError');
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({ code, path });
    // El valor (posible secreto) nunca aparece en el error.
    for (const value of Object.values(environment)) {
      if (value.length > 6) expect(String((error as Error).message)).not.toContain(value);
    }
  }
}

describe('variables de Qapaqzito en platform/configuration', () => {
  it('todas las variables del asistente son conocidas (el API arranca con Qapaqzito activo)', () => {
    for (const name of ASSISTANT_VARIABLES) expect(KNOWN_QAPAQ_VARIABLES.has(name)).toBe(true);
    expect(() =>
      loadApiConfig({
        QAPAQ_PROFILE: 'production',
        QAPAQ_QAPAQZITO_ENABLED: 'true',
        QAPAQ_QAPAQZITO_PROVIDER: 'anthropic',
        QAPAQ_QAPAQZITO_MODEL: 'claude-sonnet-5-5',
        QAPAQ_QAPAQZITO_EFFORT: 'medium',
        QAPAQ_QAPAQZITO_REDACT_PII: 'true',
        QAPAQ_QAPAQZITO_API_KEY: 'sk-ant-api03-test-value',
        QAPAQ_QAPAQZITO_TIMEOUT_MS: '20000',
        QAPAQ_QAPAQZITO_RATE_LIMIT: '20',
        QAPAQ_QAPAQZITO_HISTORY_ENABLED: 'true',
        QAPAQ_QAPAQZITO_RETENTION_DAYS: '90',
      }),
    ).not.toThrow();
  });

  it('Qapaqzito apagado o sin variables no exige nada', () => {
    expect(() => loadApiConfig({ QAPAQ_PROFILE: 'test' })).not.toThrow();
    expect(() => loadApiConfig({ QAPAQ_PROFILE: 'test', QAPAQ_QAPAQZITO_ENABLED: 'false' })).not.toThrow();
  });

  it('rechaza valores inválidos sin exponerlos', () => {
    expectInvalid({ QAPAQ_QAPAQZITO_ENABLED: 'si' }, 'CONFIG_VALUE_INVALID', 'QAPAQ_QAPAQZITO_ENABLED');
    expectInvalid({ QAPAQ_QAPAQZITO_PROVIDER: 'deepseek' }, 'CONFIG_VALUE_INVALID', 'QAPAQ_QAPAQZITO_PROVIDER');
    expectInvalid({ QAPAQ_QAPAQZITO_EFFORT: 'enorme' }, 'CONFIG_VALUE_INVALID', 'QAPAQ_QAPAQZITO_EFFORT');
    expectInvalid({ QAPAQ_QAPAQZITO_MODEL: 'a b' }, 'CONFIG_VALUE_INVALID', 'QAPAQ_QAPAQZITO_MODEL');
    expectInvalid({ QAPAQ_QAPAQZITO_RATE_LIMIT: '0' }, 'CONFIG_VALUE_INVALID', 'QAPAQ_QAPAQZITO_RATE_LIMIT');
    expectInvalid(
      { QAPAQ_QAPAQZITO_RETENTION_DAYS: '366' },
      'CONFIG_VALUE_INVALID',
      'QAPAQ_QAPAQZITO_RETENTION_DAYS',
    );
    expectInvalid({ QAPAQ_QAPAQZITO_TIMEOUT_MS: '10' }, 'CONFIG_VALUE_INVALID', 'QAPAQ_QAPAQZITO_TIMEOUT_MS');
    expectInvalid(
      { QAPAQ_QAPAQZITO_API_KEY: 'clave con espacios' },
      'CONFIG_VALUE_INVALID',
      'QAPAQ_QAPAQZITO_API_KEY',
    );
  });

  it('anthropic activo exige QAPAQ_QAPAQZITO_API_KEY', () => {
    expectInvalid(
      { QAPAQ_QAPAQZITO_ENABLED: 'true', QAPAQ_QAPAQZITO_PROVIDER: 'anthropic' },
      'CONFIG_REQUIRED_VALUE_MISSING',
      'QAPAQ_QAPAQZITO_API_KEY',
    );
  });
});

describe('variables de informes de Qapaqzito (QAPAQ_REPORTS_*)', () => {
  const token = 'tok-' + 'a'.repeat(40);

  it('son conocidas y el API arranca con ellas (o sin ellas: función apagada)', () => {
    expect(KNOWN_QAPAQ_VARIABLES.has('QAPAQ_REPORTS_URL')).toBe(true);
    expect(KNOWN_QAPAQ_VARIABLES.has('QAPAQ_REPORTS_TOKEN')).toBe(true);
    for (const name of ['QAPAQ_REPORTS_URL', 'QAPAQ_REPORTS_TOKEN']) {
      expect((ASSISTANT_VARIABLES as readonly string[]).includes(name)).toBe(true);
    }
    expect(() =>
      loadApiConfig({
        QAPAQ_PROFILE: 'production',
        QAPAQ_REPORTS_URL: 'http://reports:8090',
        QAPAQ_REPORTS_TOKEN: token,
      }),
    ).not.toThrow();
    expect(() => loadApiConfig({ QAPAQ_PROFILE: 'test' })).not.toThrow();
  });

  it('rechaza URL o token inválidos sin exponer el valor', () => {
    expectInvalid({ QAPAQ_REPORTS_URL: 'no-es-url', QAPAQ_REPORTS_TOKEN: token }, 'CONFIG_VALUE_INVALID', 'QAPAQ_REPORTS_URL');
    expectInvalid({ QAPAQ_REPORTS_URL: 'ftp://reports:8090', QAPAQ_REPORTS_TOKEN: token }, 'CONFIG_VALUE_INVALID', 'QAPAQ_REPORTS_URL');
    expectInvalid(
      { QAPAQ_REPORTS_URL: 'http://user:pass@reports:8090', QAPAQ_REPORTS_TOKEN: token },
      'CONFIG_VALUE_INVALID',
      'QAPAQ_REPORTS_URL',
    );
    expectInvalid({ QAPAQ_REPORTS_URL: 'http://reports:8090', QAPAQ_REPORTS_TOKEN: 'corto' }, 'CONFIG_VALUE_INVALID', 'QAPAQ_REPORTS_TOKEN');
    expectInvalid(
      { QAPAQ_REPORTS_URL: 'http://reports:8090', QAPAQ_REPORTS_TOKEN: 'con espacios ' + 'x'.repeat(20) },
      'CONFIG_VALUE_INVALID',
      'QAPAQ_REPORTS_TOKEN',
    );
  });

  it('una URL sin token es un error de configuración (nunca un servicio sin autenticar)', () => {
    expectInvalid(
      { QAPAQ_REPORTS_URL: 'http://reports:8090' },
      'CONFIG_REQUIRED_VALUE_MISSING',
      'QAPAQ_REPORTS_TOKEN',
    );
  });
});

const RATE_CARD = JSON.stringify({
  version: 'test-2026-11',
  tiers: {
    economy: {
      inputMicroUsdPerMTok: 100_000,
      outputMicroUsdPerMTok: 500_000,
      cacheReadMicroUsdPerMTok: 10_000,
      cacheWriteMicroUsdPerMTok: 125_000,
    },
    advanced: {
      inputMicroUsdPerMTok: 2_000_000,
      outputMicroUsdPerMTok: 10_000_000,
      cacheReadMicroUsdPerMTok: 100_000,
      cacheWriteMicroUsdPerMTok: 2_500_000,
    },
  },
});

describe('variables del Analista IA en platform/configuration', () => {
  it('todas son conocidas y un despliegue completo arranca', () => {
    for (const name of ANALYST_VARIABLES) expect(KNOWN_QAPAQ_VARIABLES.has(name)).toBe(true);
    expect(() =>
      loadApiConfig({
        QAPAQ_PROFILE: 'production',
        QAPAQ_QAPAQZITO_PROVIDER: 'anthropic',
        QAPAQ_QAPAQZITO_API_KEY: 'sk-ant-api03-test-value',
        QAPAQ_ANALYST_ENABLED: 'true',
        QAPAQ_ANALYST_ECONOMY_MODEL: 'claude-haiku-5-5',
        QAPAQ_ANALYST_ADVANCED_MODEL: 'claude-sonnet-5-5',
        QAPAQ_ANALYST_DAILY_CEILING_USD: '2.50',
        QAPAQ_ANALYST_RATE_CARD: RATE_CARD,
        QAPAQ_ANALYST_CONCURRENCY: '2',
        QAPAQ_ANALYST_BACKLOG_SWEEP: 'false',
      }),
    ).not.toThrow();
  });

  it('apagado por defecto no exige nada', () => {
    expect(() => loadApiConfig({ QAPAQ_PROFILE: 'test', QAPAQ_ANALYST_ENABLED: 'false' })).not.toThrow();
  });

  it('rechaza valores inválidos sin exponerlos', () => {
    expectInvalid({ QAPAQ_ANALYST_ENABLED: 'yes' }, 'CONFIG_VALUE_INVALID', 'QAPAQ_ANALYST_ENABLED');
    expectInvalid({ QAPAQ_ANALYST_BACKLOG_SWEEP: '1' }, 'CONFIG_VALUE_INVALID', 'QAPAQ_ANALYST_BACKLOG_SWEEP');
    expectInvalid({ QAPAQ_ANALYST_ECONOMY_MODEL: 'a b' }, 'CONFIG_VALUE_INVALID', 'QAPAQ_ANALYST_ECONOMY_MODEL');
    expectInvalid({ QAPAQ_ANALYST_CONCURRENCY: '5' }, 'CONFIG_VALUE_INVALID', 'QAPAQ_ANALYST_CONCURRENCY');
    expectInvalid({ QAPAQ_ANALYST_CONCURRENCY: '0' }, 'CONFIG_VALUE_INVALID', 'QAPAQ_ANALYST_CONCURRENCY');
    expectInvalid({ QAPAQ_ANALYST_DAILY_CEILING_USD: '0' }, 'CONFIG_VALUE_INVALID', 'QAPAQ_ANALYST_DAILY_CEILING_USD');
    expectInvalid({ QAPAQ_ANALYST_DAILY_CEILING_USD: '-1' }, 'CONFIG_VALUE_INVALID', 'QAPAQ_ANALYST_DAILY_CEILING_USD');
    expectInvalid({ QAPAQ_ANALYST_DAILY_CEILING_USD: '1001' }, 'CONFIG_VALUE_INVALID', 'QAPAQ_ANALYST_DAILY_CEILING_USD');
    expectInvalid({ QAPAQ_ANALYST_RATE_CARD: '{"version":"x"}' }, 'CONFIG_VALUE_INVALID', 'QAPAQ_ANALYST_RATE_CARD');
  });

  it('activo con anthropic exige la clave de Qapaqzito (no hay secreto propio)', () => {
    expectInvalid(
      { QAPAQ_ANALYST_ENABLED: 'true', QAPAQ_QAPAQZITO_PROVIDER: 'anthropic' },
      'CONFIG_REQUIRED_VALUE_MISSING',
      'QAPAQ_QAPAQZITO_API_KEY',
    );
  });

  it('techo y tarifa se interpretan sin ambigüedad', () => {
    expect(parseAnalystCeilingUsd('2.5')).toBe(2_500_000);
    expect(parseAnalystCeilingUsd('0.000001')).toBe(1);
    expect(parseAnalystCeilingUsd('1,5')).toBeUndefined();
    expect(parseAnalystRateCard(RATE_CARD)?.tiers.economy.outputMicroUsdPerMTok).toBe(500_000);
    const extra = JSON.parse(RATE_CARD) as Record<string, unknown>;
    expect(parseAnalystRateCard(JSON.stringify({ ...extra, billing: true }))).toBeUndefined();
    expect(parseAnalystRateCard('no-json')).toBeUndefined();
  });
});
