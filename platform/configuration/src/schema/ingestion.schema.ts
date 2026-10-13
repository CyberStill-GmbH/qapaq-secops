/**
 * Sprint 5 · fase 0 — configuración de la ingesta de fuentes hacia el SOC (S5-D1, S5-D2).
 *
 * `QAPAQ_INGESTION_SOURCE` decide si el API lee una fuente:
 * - `disabled` (por defecto): el SOC solo recibe lo que entra por la ruta local del E2E. La
 *   salud por fuente lo informa como deshabilitado, sin datos inventados.
 * - `wazuh`: el API lee el Indexer a través del gateway C-28 con un token de workload de
 *   Entra. Exige la URL del gateway y el scope del token; sin ellos no arranca.
 *
 * No hay secretos aquí: el token se obtiene con el client secret de Entra que el API ya
 * tiene, y la clave de los cursores del proveedor se genera en memoria por proceso (los
 * cursores viven menos de un minuto y nunca salen de la pasada que los creó).
 */

import { configurationError } from '../configuration.errors.js';
import type { EnvironmentInput } from '../configuration.types.js';
import type { ConfigurationProfile } from '../profiles/index.js';
import { optionalString, parseDuration, parseInteger } from './environment.schema.js';

export const INGESTION_SOURCES = ['disabled', 'wazuh'] as const;
export type IngestionSource = (typeof INGESTION_SOURCES)[number];

export type IngestionConfig =
  | { readonly source: 'disabled' }
  | {
      readonly source: 'wazuh';
      readonly sourceId: string;
      readonly gatewayBaseUrl: string;
      /** Scope de client credentials, p. ej. `api://<client-id>/.default`. */
      readonly gatewayScope: string;
      readonly intervalMs: number;
      readonly initialLookbackMs: number;
    };

const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/u;
const SCOPE_PATTERN = /^[A-Za-z0-9:/._-]{3,256}\/\.default$/u;

function durationOr(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
  name: string,
  fallback: number,
): number {
  return optionalString(environment, profile, name) === undefined
    ? fallback
    : parseDuration(environment, profile, name);
}

export function parseIngestionConfig(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
): IngestionConfig {
  const source = optionalString(environment, profile, 'QAPAQ_INGESTION_SOURCE') ?? 'disabled';
  if (!(INGESTION_SOURCES as readonly string[]).includes(source)) {
    throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_INGESTION_SOURCE', profile.name);
  }
  if (source === 'disabled') return { source: 'disabled' };

  const sourceId =
    optionalString(environment, profile, 'QAPAQ_INGESTION_SOURCE_ID') ?? 'wazuh-indexer';
  if (!SOURCE_ID_PATTERN.test(sourceId)) {
    throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_INGESTION_SOURCE_ID', profile.name);
  }
  const gatewayBaseUrl = optionalString(environment, profile, 'QAPAQ_WAZUH_GATEWAY_BASE_URL');
  if (!gatewayBaseUrl) {
    throw configurationError(
      'CONFIG_REQUIRED_VALUE_MISSING',
      'QAPAQ_WAZUH_GATEWAY_BASE_URL',
      profile.name,
    );
  }
  const gatewayScope = optionalString(environment, profile, 'QAPAQ_INGESTION_GATEWAY_SCOPE');
  if (!gatewayScope) {
    throw configurationError(
      'CONFIG_REQUIRED_VALUE_MISSING',
      'QAPAQ_INGESTION_GATEWAY_SCOPE',
      profile.name,
    );
  }
  if (!SCOPE_PATTERN.test(gatewayScope)) {
    throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_INGESTION_GATEWAY_SCOPE', profile.name);
  }
  return {
    source: 'wazuh',
    sourceId,
    gatewayBaseUrl,
    gatewayScope,
    intervalMs: durationOr(environment, profile, 'QAPAQ_INGESTION_INTERVAL', 60_000),
    // Minutos enteros: la ventana inicial supera el tope global de duraciones (120 s).
    initialLookbackMs:
      (optionalString(environment, profile, 'QAPAQ_INGESTION_INITIAL_LOOKBACK_MINUTES') ===
      undefined
        ? 60
        : parseInteger(
            environment,
            profile,
            'QAPAQ_INGESTION_INITIAL_LOOKBACK_MINUTES',
            1,
            1_440,
          )) * 60_000,
  };
}
