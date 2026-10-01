/**
 * C-18/C-25 — configuración de identidad, red y canal crítico.
 *
 * El modo de identidad es explícito y no se infiere. `local-development` existe para
 * poder recorrer el flujo completo sin tenant —y para que el E2E no dependa de un
 * recurso externo—, y se rechaza en el perfil de producción igual que el adapter de
 * secretos por entorno: un entorno mal etiquetado debe fallar al arrancar, no admitir
 * sesiones firmadas por una clave efímera.
 */

import { configurationError } from '../configuration.errors.js';
import type { ConfigurationProfile } from '../profiles/index.js';
import type { EnvironmentInput } from '../configuration.types.js';
import { readValue, requireString } from './environment.schema.js';

export const IDENTITY_MODES = ['entra', 'local-development'] as const;
export type IdentityMode = (typeof IDENTITY_MODES)[number];

export interface AccessConfig {
  readonly identityMode: IdentityMode;
  readonly tenantId: string;
  readonly clientId: string;
  readonly authority: string;
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly redirectUri: string;
  readonly allowedRedirectUris: readonly string[];
  readonly scopes: readonly string[];
  readonly clientSecretRef: string | null;
  readonly allowedCidrs: readonly string[];
  readonly trustedProxyCidrs: readonly string[];
  readonly consoleBaseUrl: string;
  readonly teamsWorkflowUrlRef: string | null;
}

function parseList(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
  name: string,
): readonly string[] {
  const raw = readValue(environment, profile, name) ?? '';
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0)
    throw configurationError('CONFIG_REQUIRED_VALUE_MISSING', name, profile.name);
  return Object.freeze(values);
}

function requireHttpsUrl(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
  name: string,
): string {
  const value = requireString(environment, profile, name);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError('CONFIG_VALUE_INVALID', name, profile.name);
  }
  const insecure = url.protocol !== 'https:';
  const localhost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (insecure && !(profile.allowLocalInsecureTransport && localhost)) {
    throw configurationError('CONFIG_VALUE_INVALID', name, profile.name);
  }
  return value;
}

export function parseAccess(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
): AccessConfig {
  const mode = (readValue(environment, profile, 'QAPAQ_ACCESS_IDENTITY_MODE') ??
    'entra') as IdentityMode;
  if (!(IDENTITY_MODES as readonly string[]).includes(mode)) {
    throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_ACCESS_IDENTITY_MODE', profile.name);
  }
  if (mode === 'local-development' && profile.name === 'production') {
    // Fallo seguro: producción no acepta un emisor local bajo ninguna combinación.
    throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_ACCESS_IDENTITY_MODE', profile.name);
  }
  const tenantId = requireString(environment, profile, 'QAPAQ_ENTRA_TENANT_ID');
  const clientId = requireString(environment, profile, 'QAPAQ_ENTRA_CLIENT_ID');
  const authority = requireHttpsUrl(environment, profile, 'QAPAQ_ENTRA_AUTHORITY');
  const base = `${authority.replace(/\/+$/u, '')}/${tenantId}`;
  const redirectUri = requireHttpsUrl(environment, profile, 'QAPAQ_ENTRA_REDIRECT_URI');
  const allowedRedirectUris = parseList(environment, profile, 'QAPAQ_ENTRA_ALLOWED_REDIRECT_URIS');
  if (!allowedRedirectUris.includes(redirectUri)) {
    throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_ENTRA_REDIRECT_URI', profile.name);
  }
  const clientSecretRef = readValue(environment, profile, 'QAPAQ_ENTRA_CLIENT_SECRET_REF') ?? null;
  if (mode === 'entra' && !clientSecretRef) {
    throw configurationError(
      'CONFIG_REQUIRED_VALUE_MISSING',
      'QAPAQ_ENTRA_CLIENT_SECRET_REF',
      profile.name,
    );
  }
  return Object.freeze({
    identityMode: mode,
    tenantId,
    clientId,
    authority,
    issuer: `${base}/v2.0`,
    authorizationEndpoint: `${base}/oauth2/v2.0/authorize`,
    tokenEndpoint: `${base}/oauth2/v2.0/token`,
    jwksUri: `${base}/discovery/v2.0/keys`,
    redirectUri,
    allowedRedirectUris,
    scopes: parseList(environment, profile, 'QAPAQ_ENTRA_SCOPES'),
    clientSecretRef,
    allowedCidrs: parseList(environment, profile, 'QAPAQ_ACCESS_ALLOWED_CIDRS'),
    trustedProxyCidrs: parseList(environment, profile, 'QAPAQ_ACCESS_TRUSTED_PROXY_CIDRS'),
    consoleBaseUrl: requireHttpsUrl(environment, profile, 'QAPAQ_CONSOLE_BASE_URL'),
    teamsWorkflowUrlRef: readValue(environment, profile, 'QAPAQ_TEAMS_WORKFLOW_URL_REF') ?? null,
  });
}
