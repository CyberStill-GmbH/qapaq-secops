import { configurationError } from '../configuration.errors.js';
import type { EnvironmentInput } from '../configuration.types.js';
import { CONFIGURATION_LIMITS } from '../limits.js';
import type { ConfigurationProfile } from '../profiles/index.js';
import { parseSecretReference, type SecretReference } from '../secrets/index.js';
import {
  optionalString,
  parseBoolean,
  parseDuration,
  parseInteger,
  parsePort,
  requireString,
} from './environment.schema.js';

export interface ParsedRedisConfig {
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly passwordReference?: SecretReference;
  readonly database: number;
  readonly tls: boolean;
  readonly connectionTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly retryLimit: number;
}

function requireHost(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
  name: string,
): string {
  const value = requireString(environment, profile, name);
  if (value.includes('://') || value.includes('@') || value.includes('/') || value.includes('\\')) {
    throw configurationError('CONFIG_URL_INVALID', name, profile.name);
  }
  return value;
}

function isLocalHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/gu, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function enforceTls(profile: ConfigurationProfile, tls: boolean, host: string, path: string): void {
  if (profile.requireTls && !tls)
    throw configurationError('CONFIG_TLS_REQUIRED', path, profile.name);
  if (!tls && (!profile.allowLocalInsecureTransport || !isLocalHost(host))) {
    throw configurationError('CONFIG_INSECURE_TRANSPORT', path, profile.name);
  }
}

function parseUrl(environment: EnvironmentInput, profile: ConfigurationProfile, name: string): URL {
  const value = requireString(environment, profile, name);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError('CONFIG_URL_INVALID', name, profile.name);
  }
  if (url.username !== '' || url.password !== '')
    throw configurationError('CONFIG_URL_INVALID', name, profile.name);
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw configurationError('CONFIG_URL_INVALID', name, profile.name);
  if (
    url.protocol === 'http:' &&
    (!profile.allowLocalInsecureTransport || !isLocalHost(url.hostname))
  ) {
    throw configurationError('CONFIG_INSECURE_TRANSPORT', name, profile.name);
  }
  if (profile.requireTls && url.protocol !== 'https:')
    throw configurationError('CONFIG_TLS_REQUIRED', name, profile.name);
  return url;
}

export function parseApi(environment: EnvironmentInput, profile: ConfigurationProfile) {
  return {
    profile: profile.name,
    host: requireHost(environment, profile, 'QAPAQ_API_HOST'),
    // El puerto cero solicita una asignación atómica al sistema operativo; solo se permite en el perfil test.
    port:
      profile.name === 'test' && environment['QAPAQ_API_PORT'] === '0'
        ? 0
        : parsePort(environment, profile, 'QAPAQ_API_PORT'),
  } as const;
}

export function parseRedis(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
): ParsedRedisConfig {
  const host = requireHost(environment, profile, 'QAPAQ_REDIS_HOST');
  const tls = parseBoolean(environment, profile, 'QAPAQ_REDIS_TLS');
  enforceTls(profile, tls, host, 'QAPAQ_REDIS_TLS');
  const reference = optionalString(environment, profile, 'QAPAQ_REDIS_PASSWORD_REF');
  const username = optionalString(environment, profile, 'QAPAQ_REDIS_USERNAME');
  if (profile.name === 'production' && reference === undefined)
    throw configurationError(
      'CONFIG_REQUIRED_VALUE_MISSING',
      'QAPAQ_REDIS_PASSWORD_REF',
      profile.name,
    );
  return {
    host,
    port: parsePort(environment, profile, 'QAPAQ_REDIS_PORT'),
    ...(username === undefined ? {} : { username }),
    ...(reference
      ? { passwordReference: parseSecretReference(reference, 'QAPAQ_REDIS_PASSWORD_REF') }
      : {}),
    database: parseInteger(
      environment,
      profile,
      'QAPAQ_REDIS_DATABASE',
      CONFIGURATION_LIMITS.redisDatabaseMinimum,
      CONFIGURATION_LIMITS.redisDatabaseMaximum,
    ),
    tls,
    connectionTimeoutMs: parseDuration(environment, profile, 'QAPAQ_REDIS_CONNECTION_TIMEOUT'),
    commandTimeoutMs: parseDuration(environment, profile, 'QAPAQ_REDIS_COMMAND_TIMEOUT'),
    retryLimit: parseInteger(
      environment,
      profile,
      'QAPAQ_REDIS_RETRY_LIMIT',
      0,
      CONFIGURATION_LIMITS.retryMaximum,
    ),
  };
}

export function parseFullEnvironment(environment: EnvironmentInput, profile: ConfigurationProfile) {
  const postgresHost = requireHost(environment, profile, 'QAPAQ_POSTGRES_HOST');
  const postgresTls = parseBoolean(environment, profile, 'QAPAQ_POSTGRES_TLS');
  enforceTls(profile, postgresTls, postgresHost, 'QAPAQ_POSTGRES_TLS');
  const poolMinimum = parseInteger(
    environment,
    profile,
    'QAPAQ_POSTGRES_POOL_MIN',
    CONFIGURATION_LIMITS.poolMinimum,
    CONFIGURATION_LIMITS.poolMaximum,
  );
  const poolMaximum = parseInteger(
    environment,
    profile,
    'QAPAQ_POSTGRES_POOL_MAX',
    1,
    CONFIGURATION_LIMITS.poolMaximum,
  );
  if (poolMinimum > poolMaximum)
    throw configurationError('CONFIG_LIMIT_INVALID', 'postgres.pool', profile.name);

  const minioHost = requireHost(environment, profile, 'QAPAQ_MINIO_ENDPOINT');
  const minioTls = parseBoolean(environment, profile, 'QAPAQ_MINIO_TLS');
  enforceTls(profile, minioTls, minioHost, 'QAPAQ_MINIO_TLS');
  const bucket = requireString(environment, profile, 'QAPAQ_MINIO_RAW_BUCKET');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) || bucket.includes('..'))
    throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_MINIO_RAW_BUCKET', profile.name);

  const wazuhUrl = parseUrl(environment, profile, 'QAPAQ_WAZUH_INDEXER_URL');
  const wazuhManagerUrl = parseUrl(environment, profile, 'QAPAQ_WAZUH_MANAGER_API_URL');
  const rejectUnauthorized = parseBoolean(
    environment,
    profile,
    'QAPAQ_WAZUH_TLS_REJECT_UNAUTHORIZED',
  );

  if (!rejectUnauthorized && profile.name === 'production') {
    throw configurationError(
      'CONFIG_TLS_REQUIRED',
      'QAPAQ_WAZUH_TLS_REJECT_UNAUTHORIZED',
      profile.name,
    );
  }
  const pageSize = parseInteger(
    environment,
    profile,
    'QAPAQ_WAZUH_PAGE_SIZE',
    1,
    CONFIGURATION_LIMITS.pageSizeMaximum,
  );
  const maximumPageSize = parseInteger(
    environment,
    profile,
    'QAPAQ_WAZUH_MAX_PAGE_SIZE',
    1,
    CONFIGURATION_LIMITS.pageSizeMaximum,
  );
  if (pageSize > maximumPageSize)
    throw configurationError('CONFIG_LIMIT_INVALID', 'wazuh.indexer.pageSize', profile.name);
  const allowedWazuhIndex = requireString(environment, profile, 'QAPAQ_WAZUH_ALLOWED_INDEX');
  const wazuhDataset = requireString(environment, profile, 'QAPAQ_WAZUH_DATASET');
  if (
    !/^wazuh-alerts-[a-z0-9.*_-]+$/u.test(allowedWazuhIndex) ||
    allowedWazuhIndex.includes('..') ||
    wazuhDataset !== 'wazuh-alerts'
  ) {
    throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_WAZUH_ALLOWED_INDEX', profile.name);
  }

  return {
    api: parseApi(environment, profile),
    postgres: {
      host: postgresHost,
      port: parsePort(environment, profile, 'QAPAQ_POSTGRES_PORT'),
      database: requireString(environment, profile, 'QAPAQ_POSTGRES_DATABASE'),
      username: requireString(environment, profile, 'QAPAQ_POSTGRES_USERNAME'),
      passwordReference: parseSecretReference(
        requireString(environment, profile, 'QAPAQ_POSTGRES_PASSWORD_REF'),
        'QAPAQ_POSTGRES_PASSWORD_REF',
      ),
      tls: postgresTls,
      connectionTimeoutMs: parseDuration(environment, profile, 'QAPAQ_POSTGRES_CONNECTION_TIMEOUT'),
      statementTimeoutMs: parseDuration(environment, profile, 'QAPAQ_POSTGRES_STATEMENT_TIMEOUT'),
      pool: { minimum: poolMinimum, maximum: poolMaximum },
    },
    redis: parseRedis(environment, profile),
    minio: {
      endpoint: minioHost,
      port: parsePort(environment, profile, 'QAPAQ_MINIO_PORT'),
      region: requireString(environment, profile, 'QAPAQ_MINIO_REGION'),
      rawBucket: bucket,
      accessKeyReference: parseSecretReference(
        requireString(environment, profile, 'QAPAQ_MINIO_ACCESS_KEY_REF'),
        'QAPAQ_MINIO_ACCESS_KEY_REF',
      ),
      secretKeyReference: parseSecretReference(
        requireString(environment, profile, 'QAPAQ_MINIO_SECRET_KEY_REF'),
        'QAPAQ_MINIO_SECRET_KEY_REF',
      ),
      tls: minioTls,
      connectionTimeoutMs: parseDuration(environment, profile, 'QAPAQ_MINIO_CONNECTION_TIMEOUT'),
      requestTimeoutMs: parseDuration(environment, profile, 'QAPAQ_MINIO_REQUEST_TIMEOUT'),
      retryLimit: parseInteger(
        environment,
        profile,
        'QAPAQ_MINIO_RETRY_LIMIT',
        0,
        CONFIGURATION_LIMITS.retryMaximum,
      ),
    },
    wazuh: {
      manager: {
        baseUrl: wazuhManagerUrl.toString(),
        usernameReference: parseSecretReference(
          requireString(environment, profile, 'QAPAQ_WAZUH_MANAGER_USERNAME_REF'),
          'QAPAQ_WAZUH_MANAGER_USERNAME_REF',
        ),
        passwordReference: parseSecretReference(
          requireString(environment, profile, 'QAPAQ_WAZUH_MANAGER_PASSWORD_REF'),
          'QAPAQ_WAZUH_MANAGER_PASSWORD_REF',
        ),
        caReference: parseSecretReference(
          requireString(environment, profile, 'QAPAQ_WAZUH_MANAGER_CA_REF'),
          'QAPAQ_WAZUH_MANAGER_CA_REF',
        ),
        connectTimeoutMs: parseDuration(environment, profile, 'QAPAQ_WAZUH_CONNECT_TIMEOUT'),
        requestTimeoutMs: parseDuration(environment, profile, 'QAPAQ_WAZUH_REQUEST_TIMEOUT'),
        maximumResponseBytes: parseInteger(
          environment,
          profile,
          'QAPAQ_WAZUH_MAX_RESPONSE_BYTES',
          1_024,
          100_000_000,
        ),
      },
      indexer: {
        baseUrl: wazuhUrl.toString(),
        usernameReference: parseSecretReference(
          requireString(environment, profile, 'QAPAQ_WAZUH_USERNAME_REF'),
          'QAPAQ_WAZUH_USERNAME_REF',
        ),
        passwordReference: parseSecretReference(
          requireString(environment, profile, 'QAPAQ_WAZUH_PASSWORD_REF'),
          'QAPAQ_WAZUH_PASSWORD_REF',
        ),
        caReference: parseSecretReference(
          requireString(environment, profile, 'QAPAQ_WAZUH_CA_REF'),
          'QAPAQ_WAZUH_CA_REF',
        ),
        rejectUnauthorized,
        connectTimeoutMs: parseDuration(environment, profile, 'QAPAQ_WAZUH_CONNECT_TIMEOUT'),
        requestTimeoutMs: parseDuration(environment, profile, 'QAPAQ_WAZUH_REQUEST_TIMEOUT'),
        retryLimit: parseInteger(
          environment,
          profile,
          'QAPAQ_WAZUH_RETRY_LIMIT',
          0,
          CONFIGURATION_LIMITS.retryMaximum,
        ),
        pageSize,
        maximumPageSize,
        allowedIndex: allowedWazuhIndex,
        dataset: wazuhDataset,
        cursorSigningKeyReference: parseSecretReference(
          requireString(environment, profile, 'QAPAQ_WAZUH_CURSOR_SECRET_REF'),
          'QAPAQ_WAZUH_CURSOR_SECRET_REF',
        ),
        cursorTtlMs: parseDuration(environment, profile, 'QAPAQ_WAZUH_CURSOR_TTL'),
        maximumResponseBytes: parseInteger(
          environment,
          profile,
          'QAPAQ_WAZUH_MAX_RESPONSE_BYTES',
          1_024,
          100_000_000,
        ),
      },
    },
  } as const;
}
