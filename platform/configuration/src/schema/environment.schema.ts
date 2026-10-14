import { configurationError } from '../configuration.errors.js';
import type { EnvironmentInput } from '../configuration.types.js';
import { CONFIGURATION_LIMITS } from '../limits.js';
import type { ConfigurationProfile } from '../profiles/index.js';

export const KNOWN_QAPAQ_VARIABLES = new Set([
  'QAPAQ_PROFILE',
  'QAPAQ_API_HOST',
  'QAPAQ_API_PORT',
  'QAPAQ_POSTGRES_HOST',
  'QAPAQ_POSTGRES_PORT',
  'QAPAQ_POSTGRES_DATABASE',
  'QAPAQ_POSTGRES_USERNAME',
  'QAPAQ_POSTGRES_PASSWORD_REF',
  'QAPAQ_POSTGRES_TLS',
  'QAPAQ_POSTGRES_CONNECTION_TIMEOUT',
  'QAPAQ_POSTGRES_STATEMENT_TIMEOUT',
  'QAPAQ_POSTGRES_POOL_MIN',
  'QAPAQ_POSTGRES_POOL_MAX',
  'QAPAQ_REDIS_HOST',
  'QAPAQ_REDIS_PORT',
  'QAPAQ_REDIS_USERNAME',
  'QAPAQ_REDIS_PASSWORD_REF',
  // El orquestador inyecta el valor referenciado al iniciar la tarea; nunca se registra.
  'QAPAQ_REDIS_PASSWORD',
  'QAPAQ_REDIS_DATABASE',
  'QAPAQ_REDIS_TLS',
  'QAPAQ_REDIS_CONNECTION_TIMEOUT',
  'QAPAQ_REDIS_COMMAND_TIMEOUT',
  'QAPAQ_REDIS_RETRY_LIMIT',
  'QAPAQ_MINIO_ENDPOINT',
  'QAPAQ_MINIO_PORT',
  'QAPAQ_MINIO_REGION',
  'QAPAQ_MINIO_RAW_BUCKET',
  'QAPAQ_MINIO_ACCESS_KEY_REF',
  'QAPAQ_MINIO_SECRET_KEY_REF',
  'QAPAQ_MINIO_TLS',
  'QAPAQ_MINIO_CONNECTION_TIMEOUT',
  'QAPAQ_MINIO_REQUEST_TIMEOUT',
  'QAPAQ_MINIO_RETRY_LIMIT',
  'QAPAQ_WAZUH_GATEWAY_BASE_URL',
  'QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN_REF',
  'QAPAQ_WAZUH_REQUEST_TIMEOUT',
  'QAPAQ_WAZUH_RETRY_LIMIT',
  'QAPAQ_WAZUH_PAGE_SIZE',
  'QAPAQ_WAZUH_MAX_PAGE_SIZE',
  'QAPAQ_WAZUH_DATASET',
  'QAPAQ_WAZUH_CURSOR_SECRET_REF',
  'QAPAQ_WAZUH_CURSOR_TTL',
  'QAPAQ_WAZUH_MAX_RESPONSE_BYTES',
  'QAPAQ_SECRET_PROVIDER_TYPE',
  'QAPAQ_SECRET_PROVIDER_TIMEOUT',
  'QAPAQ_SECRET_FINGERPRINT_KEY_REF',
  'QAPAQ_ACCESS_IDENTITY_MODE',
  'QAPAQ_ACCESS_ALLOWED_CIDRS',
  'QAPAQ_ACCESS_TRUSTED_PROXY_CIDRS',
  'QAPAQ_ENTRA_TENANT_ID',
  'QAPAQ_ENTRA_CLIENT_ID',
  'QAPAQ_ENTRA_CLIENT_SECRET',
  'QAPAQ_ENTRA_CLIENT_SECRET_REF',
  'QAPAQ_ENTRA_AUTHORITY',
  'QAPAQ_ENTRA_REDIRECT_URI',
  'QAPAQ_ENTRA_ALLOWED_REDIRECT_URIS',
  'QAPAQ_ENTRA_SCOPES',
  'QAPAQ_MVP_ROLE_BINDING_OID',
  'QAPAQ_MVP_ROLE_BINDING_ROLE',
  'QAPAQ_MVP_ROLE_BINDING_EXPIRES_AT',
  'QAPAQ_DEMO_MFA_EXCEPTION_UNTIL',
  'QAPAQ_CONSOLE_BASE_URL',
  'QAPAQ_TEAMS_WORKFLOW_URL_REF',
  'QAPAQ_DETECTION_PRIVILEGED_IDENTITIES',
  'QAPAQ_DETECTION_BREAK_GLASS_IDENTITIES',
  'QAPAQ_DETECTION_CRITICAL_ASSETS',
  'QAPAQ_DETECTION_INTERNET_FACING_ASSETS',
  'QAPAQ_DETECTION_KNOWN_BENIGN_RULES',
  'QAPAQ_SOC_PERSISTENCE',
  'QAPAQ_POSTGRES_PASSWORD',
  'QAPAQ_ENTITY_REF_KEY',
  'QAPAQ_INGESTION_SOURCE',
  'QAPAQ_INGESTION_SOURCE_ID',
  'QAPAQ_INGESTION_GATEWAY_SCOPE',
  'QAPAQ_INGESTION_INTERVAL',
  'QAPAQ_INGESTION_INITIAL_LOOKBACK_MINUTES',
  'QAPAQ_ROLE_BINDINGS',
  'QAPAQ_GROUP_OWNER_OIDS',
  'QAPAQ_ADMIN_GROUP_IDS',
  'QAPAQ_DIRECTORY_SYNC',
  'QAPAQ_DIRECTORY_GROUP_ID',
  'QAPAQ_DIRECTORY_GROUP_NAME',
  'QAPAQ_DIRECTORY_SYNC_INTERVAL_MINUTES',
  'QAPAQ_TEAMS_WORKFLOW_URL',
  'QAPAQ_ALERT_MAIL_SENDER',
  'QAPAQ_VAPID_PRIVATE_KEY',
]);

export function rejectUnknownQapaqVariables(
  environment: EnvironmentInput,
  profile?: ConfigurationProfile,
): void {
  const unknown = Object.keys(environment)
    .filter((key) => key.startsWith('QAPAQ_') && !KNOWN_QAPAQ_VARIABLES.has(key))
    .sort();
  if (unknown[0]) throw configurationError('CONFIG_VALUE_INVALID', unknown[0], profile?.name);
}

export function readValue(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
  name: string,
): string | undefined {
  const value = environment[name] ?? profile.defaults[name];
  return value === undefined ? undefined : value;
}

export function requireString(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
  name: string,
): string {
  const value = readValue(environment, profile, name);
  if (value === undefined || value.trim() === '')
    throw configurationError('CONFIG_REQUIRED_VALUE_MISSING', name, profile.name);
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
  if (value !== value.trim() || hasControlCharacter)
    throw configurationError('CONFIG_VALUE_INVALID', name, profile.name);
  return value;
}

export function optionalString(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
  name: string,
): string | undefined {
  const value = readValue(environment, profile, name);
  if (value === undefined || value === '') return undefined;
  return requireString(environment, profile, name);
}

export function parseBoolean(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
  name: string,
): boolean {
  const value = requireString(environment, profile, name);
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw configurationError('CONFIG_VALUE_INVALID', name, profile.name);
}

export function parseInteger(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = requireString(environment, profile, name);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value))
    throw configurationError('CONFIG_LIMIT_INVALID', name, profile.name);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw configurationError('CONFIG_LIMIT_INVALID', name, profile.name, { minimum, maximum });
  }
  return parsed;
}

export function parsePort(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
  name: string,
): number {
  return parseInteger(
    environment,
    profile,
    name,
    CONFIGURATION_LIMITS.portMinimum,
    CONFIGURATION_LIMITS.portMaximum,
  );
}

export function parseDuration(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
  name: string,
): number {
  const value = requireString(environment, profile, name);
  const match = /^([1-9][0-9]*)(ms|s|m)$/u.exec(value);
  if (!match) throw configurationError('CONFIG_DURATION_INVALID', name, profile.name);
  const amount = Number(match[1]);
  const multiplier = match[2] === 'm' ? 60_000 : match[2] === 's' ? 1_000 : 1;
  const milliseconds = amount * multiplier;
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < CONFIGURATION_LIMITS.durationMinimumMs ||
    milliseconds > CONFIGURATION_LIMITS.durationMaximumMs
  ) {
    throw configurationError('CONFIG_DURATION_INVALID', name, profile.name, {
      minimumMs: CONFIGURATION_LIMITS.durationMinimumMs,
      maximumMs: CONFIGURATION_LIMITS.durationMaximumMs,
    });
  }
  return milliseconds;
}
