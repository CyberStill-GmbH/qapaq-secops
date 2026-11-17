/**
 * Sprint 5 · fase 0 — configuración de la ingesta de fuentes hacia el SOC (S5-D1, S5-D2).
 *
 * `QAPAQ_INGESTION_SOURCE` decide si el API lee una fuente:
 * - `disabled` (por defecto): el SOC solo recibe lo que entra por la ruta local del E2E. La
 *   salud por fuente lo informa como deshabilitado, sin datos inventados.
 * - `wazuh`: el API lee el Indexer a través del gateway C-28. Exige la URL del gateway; sin
 *   ella no arranca.
 *
 * `QAPAQ_WAZUH_GATEWAY_AUTH` decide cómo se autentica el API ante el gateway:
 * - `entra` (por defecto): token de workload de Entra por client credentials; exige el scope.
 *   Sin secretos propios: usa el client secret de Entra que el API ya tiene.
 * - `static-token`: para despliegues de un solo nodo sin Entra (p. ej. la demo con login de
 *   administrador por contraseña), un bearer estático compartido con el gateway. Solo existe si
 *   se declara; exige un token largo y con variedad de caracteres, y TLS hacia el gateway salvo
 *   loopback. El token llega como `QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN` (secreto inyectado) o por
 *   `QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN_REF=secret://environment/<VARIABLE>`; vive en un
 *   `SecretValue` y nunca se serializa.
 *
 * La clave de los cursores del proveedor se genera en memoria por proceso (los cursores viven
 * menos de un minuto y nunca salen de la pasada que los creó).
 */

import { configurationError } from '../configuration.errors.js';
import { SecretValue, type EnvironmentInput } from '../configuration.types.js';
import type { ConfigurationProfile } from '../profiles/index.js';
import { optionalString, parseDuration, parseInteger } from './environment.schema.js';

export const INGESTION_SOURCES = ['disabled', 'wazuh'] as const;
export type IngestionSource = (typeof INGESTION_SOURCES)[number];

export const WAZUH_GATEWAY_AUTH_MODES = ['entra', 'static-token'] as const;
export type WazuhGatewayAuthMode = (typeof WAZUH_GATEWAY_AUTH_MODES)[number];

/** Longitud mínima del token estático (32 caracteres base64 ≈ 192 bits). */
export const STATIC_GATEWAY_TOKEN_MINIMUM_LENGTH = 32;
const STATIC_GATEWAY_TOKEN_MAXIMUM_LENGTH = 512;
/** Caracteres distintos mínimos: descarta valores repetitivos o de relleno. */
const STATIC_GATEWAY_TOKEN_MINIMUM_DISTINCT = 16;
/**
 * b64token de RFC 6750 (`=` solo al final). El gateway lo compara literal: no puede contener
 * comillas, espacios ni `$` que rompan su configuración.
 */
const STATIC_GATEWAY_TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/u;
const ENVIRONMENT_SECRET_REFERENCE = /^secret:\/\/environment\/([A-Z][A-Z0-9_]{0,127})$/u;

interface WazuhIngestionBase {
  readonly source: 'wazuh';
  readonly sourceId: string;
  readonly gatewayBaseUrl: string;
  readonly intervalMs: number;
  readonly initialLookbackMs: number;
}

export type IngestionConfig =
  | { readonly source: 'disabled' }
  | (WazuhIngestionBase & {
      readonly gatewayAuth: 'entra';
      /** Scope de client credentials, p. ej. `api://<client-id>/.default`. */
      readonly gatewayScope: string;
      /** Optional HMAC secret for durable manager push receipts; requires PostgreSQL persistence. */
      readonly pushSecret?: SecretValue;
    })
  | (WazuhIngestionBase & {
      readonly gatewayAuth: 'static-token';
      /** Bearer compartido con el gateway; `reveal()` solo al armar la cabecera. */
      readonly gatewayAccessToken: SecretValue;
      /** Optional HMAC secret for durable manager push receipts; requires PostgreSQL persistence. */
      readonly pushSecret?: SecretValue;
    });

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

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/** Con token estático el tramo al gateway exige TLS (salvo loopback): el bearer no vence. */
function requireStaticTokenTransport(gatewayBaseUrl: string, profile: ConfigurationProfile): void {
  let url: URL;
  try {
    url = new URL(gatewayBaseUrl);
  } catch {
    throw configurationError('CONFIG_URL_INVALID', 'QAPAQ_WAZUH_GATEWAY_BASE_URL', profile.name);
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw configurationError('CONFIG_URL_INVALID', 'QAPAQ_WAZUH_GATEWAY_BASE_URL', profile.name);
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw configurationError('CONFIG_TLS_REQUIRED', 'QAPAQ_WAZUH_GATEWAY_BASE_URL', profile.name, {
      reason: 'STATIC_TOKEN_REQUIRES_TLS',
    });
  }
}

/**
 * Token estático desde el entorno ya resuelto: el valor directo o una referencia
 * `secret://environment/<VARIABLE>`. Nunca de los valores por defecto del perfil. Los errores
 * nombran la variable, nunca el valor.
 */
function readStaticGatewayToken(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
): SecretValue {
  const direct = environment['QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN'];
  const reference = environment['QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN_REF'];
  const hasDirect = direct !== undefined && direct !== '';
  const hasReference = reference !== undefined && reference !== '';
  if (hasDirect && hasReference) {
    throw configurationError(
      'CONFIG_VALUE_INVALID',
      'QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN',
      profile.name,
      { reason: 'TOKEN_AND_REFERENCE_BOTH_SET' },
    );
  }
  let path = 'QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN';
  let token = direct;
  if (hasReference) {
    path = 'QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN_REF';
    const variable = ENVIRONMENT_SECRET_REFERENCE.exec(reference)?.[1];
    // Una referencia a otra variable QAPAQ_ podría apuntar a un valor que no es secreto.
    if (!variable || variable.startsWith('QAPAQ_')) {
      throw configurationError('SECRET_REFERENCE_INVALID', path, profile.name);
    }
    token = environment[variable];
  }
  if (token === undefined || token === '') {
    throw configurationError('CONFIG_REQUIRED_VALUE_MISSING', path, profile.name);
  }
  if (
    token.length < STATIC_GATEWAY_TOKEN_MINIMUM_LENGTH ||
    token.length > STATIC_GATEWAY_TOKEN_MAXIMUM_LENGTH ||
    !STATIC_GATEWAY_TOKEN_PATTERN.test(token) ||
    new Set(token).size < STATIC_GATEWAY_TOKEN_MINIMUM_DISTINCT
  ) {
    throw configurationError('CONFIG_VALUE_INVALID', path, profile.name, {
      minimumLength: STATIC_GATEWAY_TOKEN_MINIMUM_LENGTH,
    });
  }
  return new SecretValue(token);
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
  const gatewayAuth = optionalString(environment, profile, 'QAPAQ_WAZUH_GATEWAY_AUTH') ?? 'entra';
  if (!(WAZUH_GATEWAY_AUTH_MODES as readonly string[]).includes(gatewayAuth)) {
    throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_WAZUH_GATEWAY_AUTH', profile.name);
  }
  const base: WazuhIngestionBase = {
    source: 'wazuh',
    sourceId,
    gatewayBaseUrl,
    intervalMs: durationOr(environment, profile, 'QAPAQ_INGESTION_INTERVAL', 60_000),
    // Minutos enteros: la ventana inicial supera el tope global de duraciones (120 s).
    initialLookbackMs:
      (optionalString(environment, profile, 'QAPAQ_INGESTION_INITIAL_LOOKBACK_MINUTES') === undefined
        ? 60
        : parseInteger(environment, profile, 'QAPAQ_INGESTION_INITIAL_LOOKBACK_MINUTES', 1, 1_440)) *
      60_000,
  };

  if (gatewayAuth === 'static-token') {
    requireStaticTokenTransport(gatewayBaseUrl, profile);
    const pushSecret = environment['QAPAQ_WAZUH_PUSH_SECRET'];
    if (pushSecret !== undefined && (pushSecret.length < 32 || pushSecret.length > 512)) {
      throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_WAZUH_PUSH_SECRET', profile.name, {
        minimumLength: 32,
      });
    }
    return {
      ...base,
      gatewayAuth: 'static-token',
      gatewayAccessToken: readStaticGatewayToken(environment, profile),
      ...(pushSecret ? { pushSecret: new SecretValue(pushSecret) } : {}),
    };
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
  const pushSecret = environment['QAPAQ_WAZUH_PUSH_SECRET'];
  if (pushSecret !== undefined && (pushSecret.length < 32 || pushSecret.length > 512)) {
    throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_WAZUH_PUSH_SECRET', profile.name, {
      minimumLength: 32,
    });
  }
  return {
    ...base,
    gatewayAuth: 'entra',
    gatewayScope,
    ...(pushSecret ? { pushSecret: new SecretValue(pushSecret) } : {}),
  };
}
