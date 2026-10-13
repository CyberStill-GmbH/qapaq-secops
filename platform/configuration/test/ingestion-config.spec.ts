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

  it('wazuh sin gateway o sin scope no arranca', () => {
    // `production` no trae URL de gateway por defecto (dev y test apuntan al local).
    const { QAPAQ_WAZUH_GATEWAY_BASE_URL: _url, ...rest } = WAZUH;
    const withoutUrl = { ...rest, QAPAQ_PROFILE: 'production' };
    const { QAPAQ_INGESTION_GATEWAY_SCOPE: _scope, ...withoutScope } = WAZUH;
    expect(rejectedPath(() => loadIngestionConfig(withoutUrl))).toBe(
      'QAPAQ_WAZUH_GATEWAY_BASE_URL',
    );
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
