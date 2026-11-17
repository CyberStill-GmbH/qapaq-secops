import { describe, expect, it } from 'vitest';

import { ConfigurationError } from '../src/configuration.errors.js';
import { loadIngestionConfig } from '../src/configuration-loader.js';

/** Sprint 5 · fase 0 — la ingesta es explícita: sin declararla queda deshabilitada. */
function rejectedPath(load: () => unknown): string {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigurationError) return error.path;
    throw error;
  }
  throw new Error('Se esperaba un ConfigurationError.');
}

const BASE = { QAPAQ_PROFILE: 'test' } as const;
const WAZUH = {
  ...BASE,
  QAPAQ_INGESTION_SOURCE: 'wazuh',
  QAPAQ_WAZUH_GATEWAY_BASE_URL: 'http://krakend.demo.qapaq.internal:8080',
  QAPAQ_INGESTION_GATEWAY_SCOPE: 'api://00000000-0000-0000-0000-000000000000/.default',
} as const;

describe('Sprint 5 · configuración de ingesta', () => {
  it('sin variables queda deshabilitada', () => {
    expect(loadIngestionConfig(BASE)).toEqual({ source: 'disabled' });
  });

  it('wazuh con valores por defecto de intervalo, ventana y fuente', () => {
    expect(loadIngestionConfig(WAZUH)).toEqual({
      source: 'wazuh',
      sourceId: 'wazuh-indexer',
      gatewayBaseUrl: 'http://krakend.demo.qapaq.internal:8080',
      gatewayAuth: 'entra',
      gatewayScope: 'api://00000000-0000-0000-0000-000000000000/.default',
      intervalMs: 60_000,
      initialLookbackMs: 3_600_000,
    });
  });

  it('acepta intervalo y ventana declarados', () => {
    expect(
      loadIngestionConfig({
        ...WAZUH,
        QAPAQ_INGESTION_INTERVAL: '30s',
        QAPAQ_INGESTION_INITIAL_LOOKBACK_MINUTES: '1440',
      }),
    ).toMatchObject({ intervalMs: 30_000, initialLookbackMs: 86_400_000 });
  });

  it('guarda la clave HMAC push como secreto y exige longitud suficiente', () => {
    const secret = '0123456789abcdef0123456789abcdef';
    const config = loadIngestionConfig({ ...WAZUH, QAPAQ_WAZUH_PUSH_SECRET: secret });
    expect(config.source === 'wazuh' && config.pushSecret?.reveal()).toBe(secret);
    expect(JSON.stringify(config)).not.toContain(secret);
    expect(String(config.source === 'wazuh' ? config.pushSecret : undefined)).toBe('[REDACTED]');
    for (const invalid of ['short', 'x'.repeat(513)]) {
      expect(
        rejectedPath(() => loadIngestionConfig({ ...WAZUH, QAPAQ_WAZUH_PUSH_SECRET: invalid })),
      ).toBe('QAPAQ_WAZUH_PUSH_SECRET');
    }
  });

  it('wazuh sin gateway o sin scope no arranca', () => {
    // `production` no trae URL de gateway por defecto (dev y test apuntan al local).
    const { QAPAQ_WAZUH_GATEWAY_BASE_URL: _url, ...rest } = WAZUH;
    const withoutUrl = { ...rest, QAPAQ_PROFILE: 'production' };
    const { QAPAQ_INGESTION_GATEWAY_SCOPE: _scope, ...withoutScope } = WAZUH;
    expect(rejectedPath(() => loadIngestionConfig(withoutUrl))).toBe('QAPAQ_WAZUH_GATEWAY_BASE_URL');
    expect(rejectedPath(() => loadIngestionConfig(withoutScope))).toBe(
      'QAPAQ_INGESTION_GATEWAY_SCOPE',
    );
  });

  it('rechaza fuente desconocida, scope sin /.default y ventana fuera de rango', () => {
    expect(
      rejectedPath(() => loadIngestionConfig({ ...BASE, QAPAQ_INGESTION_SOURCE: 'splunk' })),
    ).toBe('QAPAQ_INGESTION_SOURCE');
    expect(
      rejectedPath(() =>
        loadIngestionConfig({ ...WAZUH, QAPAQ_INGESTION_GATEWAY_SCOPE: 'api://algo' }),
      ),
    ).toBe('QAPAQ_INGESTION_GATEWAY_SCOPE');
    expect(
      rejectedPath(() =>
        loadIngestionConfig({ ...WAZUH, QAPAQ_INGESTION_INITIAL_LOOKBACK_MINUTES: '5000' }),
      ),
    ).toBe('QAPAQ_INGESTION_INITIAL_LOOKBACK_MINUTES');
  });
});

/** Un solo nodo sin Entra: bearer estático, solo si se declara y con TLS salvo loopback. */
describe('ingesta wazuh con token estático del gateway', () => {
  // Sintético, 44 caracteres base64 (como `openssl rand -base64 32`).
  const TOKEN = 'q3Vx9ZkL2mN8pR4tW7yB1cE5gH0jA6sD/uF+oI3eKw=';
  const STATIC = {
    QAPAQ_PROFILE: 'production',
    QAPAQ_INGESTION_SOURCE: 'wazuh',
    QAPAQ_WAZUH_GATEWAY_BASE_URL: 'https://wazuh-gateway:8443',
    QAPAQ_WAZUH_GATEWAY_AUTH: 'static-token',
    QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN: TOKEN,
  } as const;

  function load(environment: Record<string, string>) {
    const config = loadIngestionConfig(environment);
    if (config.source !== 'wazuh' || config.gatewayAuth !== 'static-token') {
      throw new Error('Se esperaba ingesta wazuh con token estático.');
    }
    return config;
  }

  it('en production arranca sin scope ni Entra y guarda el token como secreto', () => {
    const config = load(STATIC);
    expect(config.gatewayBaseUrl).toBe('https://wazuh-gateway:8443');
    expect(config.gatewayAccessToken.reveal()).toBe(TOKEN);
    expect('gatewayScope' in config).toBe(false);
    // Nunca se serializa ni se convierte a texto.
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    expect(String(config.gatewayAccessToken)).toBe('[REDACTED]');
  });

  it('resuelve una referencia secret://environment/<VARIABLE>', () => {
    const { QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN: _token, ...rest } = STATIC;
    const config = load({
      ...rest,
      QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN_REF: 'secret://environment/WAZUH_GATEWAY_ACCESS_TOKEN',
      WAZUH_GATEWAY_ACCESS_TOKEN: TOKEN,
    });
    expect(config.gatewayAccessToken.reveal()).toBe(TOKEN);
  });

  it('el modo por defecto sigue siendo entra (exige scope)', () => {
    const { QAPAQ_WAZUH_GATEWAY_AUTH: _mode, ...rest } = STATIC;
    expect(rejectedPath(() => loadIngestionConfig(rest))).toBe('QAPAQ_INGESTION_GATEWAY_SCOPE');
    expect(
      rejectedPath(() => loadIngestionConfig({ ...STATIC, QAPAQ_WAZUH_GATEWAY_AUTH: 'basic' })),
    ).toBe('QAPAQ_WAZUH_GATEWAY_AUTH');
  });

  it('sin token, o con token y referencia a la vez, no arranca', () => {
    const { QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN: _token, ...withoutToken } = STATIC;
    expect(rejectedPath(() => loadIngestionConfig(withoutToken))).toBe(
      'QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN',
    );
    expect(
      rejectedPath(() =>
        loadIngestionConfig({
          ...STATIC,
          QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN_REF: 'secret://environment/WAZUH_GATEWAY_ACCESS_TOKEN',
        }),
      ),
    ).toBe('QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN');
    // Referencia a una variable vacía o ausente.
    expect(
      rejectedPath(() =>
        loadIngestionConfig({
          ...withoutToken,
          QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN_REF: 'secret://environment/WAZUH_GATEWAY_ACCESS_TOKEN',
        }),
      ),
    ).toBe('QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN_REF');
  });

  it('rechaza referencias fuera de secret://environment o hacia variables QAPAQ_', () => {
    const { QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN: _token, ...rest } = STATIC;
    for (const reference of [
      'secret://aws-secretsmanager/qapaq/wazuh-gateway-token',
      'secret://environment/QAPAQ_ENTRA_CLIENT_ID',
      'secret://environment/lowercase',
    ]) {
      expect(
        rejectedPath(() =>
          loadIngestionConfig({ ...rest, QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN_REF: reference }),
        ),
      ).toBe('QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN_REF');
    }
  });

  it('rechaza tokens cortos, repetitivos o con caracteres fuera de b64token sin filtrar el valor', () => {
    for (const token of [
      'corto-pero-valido-123',
      'a'.repeat(64),
      'abababababababababababababababababababab',
      `${TOKEN} con espacios`,
      `${TOKEN}"$x`,
      'x'.repeat(513),
    ]) {
      let caught: unknown;
      try {
        loadIngestionConfig({ ...STATIC, QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN: token });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigurationError);
      expect((caught as ConfigurationError).path).toBe('QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN');
      expect(JSON.stringify(caught)).not.toContain(token);
      expect(String((caught as Error).message)).not.toContain(token);
    }
  });

  it('exige TLS hacia el gateway salvo loopback, también fuera de production', () => {
    for (const profile of ['production', 'development', 'test']) {
      expect(
        rejectedPath(() =>
          loadIngestionConfig({
            ...STATIC,
            QAPAQ_PROFILE: profile,
            QAPAQ_WAZUH_GATEWAY_BASE_URL: 'http://krakend.demo.qapaq.internal:8080',
          }),
        ),
      ).toBe('QAPAQ_WAZUH_GATEWAY_BASE_URL');
    }
    expect(
      load({ ...STATIC, QAPAQ_WAZUH_GATEWAY_BASE_URL: 'http://127.0.0.1:18080' }).gatewayBaseUrl,
    ).toBe('http://127.0.0.1:18080');
    for (const url of ['https://user:pw@gw:8443', 'https://gw:8443/ruta', 'ftp://gw', 'no-url']) {
      expect(
        rejectedPath(() => loadIngestionConfig({ ...STATIC, QAPAQ_WAZUH_GATEWAY_BASE_URL: url })),
      ).toBe('QAPAQ_WAZUH_GATEWAY_BASE_URL');
    }
  });
});
