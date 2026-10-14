import { describe, expect, it, vi } from 'vitest';

import {
  CONFIGURATION_LIMITS,
  ConfigurationError,
  REDACTED_VALUE,
  SecretProviderError,
  loadApiConfig,
  loadControlPlaneSecretConfig,
  loadConfigurationAndStart,
  loadLocalWorkerConfig,
  loadInjectedWorkerConfig,
  loadRuntimeConfig,
  loadWorkerConfig,
  parseSecretReference,
  redactSecrets,
  type SecretProvider,
  type SecretReference,
} from '../src/index.js';

class TestSecretProvider implements SecretProvider {
  public readonly calls: string[] = [];
  public constructor(
    private readonly values: Readonly<Record<string, string>>,
    private readonly failure?: unknown,
  ) {}
  public async resolve(reference: SecretReference): Promise<string> {
    this.calls.push(reference);
    if (this.failure !== undefined) throw this.failure;
    const value = this.values[reference];
    if (value === undefined) throw new SecretProviderError('SECRET_NOT_FOUND');
    return value;
  }
}

const references = {
  postgres: 'secret://test/postgres-password',
  minioAccess: 'secret://test/minio-access',
  minioSecret: 'secret://test/minio-secret',
  wazuhGatewayToken: 'secret://test/wazuh-gateway-token',
  wazuhCursor: 'secret://test/wazuh-cursor-key',
  c24Fingerprint: 'secret://test/c24-fingerprint-key',
} as const;

function validEnvironment(profile = 'test'): Record<string, string> {
  return {
    QAPAQ_PROFILE: profile,
    QAPAQ_POSTGRES_DATABASE: 'qapaq_test',
    QAPAQ_POSTGRES_USERNAME: 'qapaq_app',
    QAPAQ_POSTGRES_PASSWORD_REF: references.postgres,
    QAPAQ_MINIO_RAW_BUCKET: 'qapaq-raw-test',
    QAPAQ_MINIO_ACCESS_KEY_REF: references.minioAccess,
    QAPAQ_MINIO_SECRET_KEY_REF: references.minioSecret,
    QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN_REF: references.wazuhGatewayToken,
    QAPAQ_WAZUH_CURSOR_SECRET_REF: references.wazuhCursor,
    QAPAQ_SECRET_FINGERPRINT_KEY_REF: references.c24Fingerprint,
  };
}

function productionEnvironment(): Record<string, string> {
  return {
    ...validEnvironment('production'),
    QAPAQ_POSTGRES_HOST: 'postgres.example.test',
    QAPAQ_POSTGRES_PORT: '5432',
    QAPAQ_POSTGRES_TLS: 'true',
    QAPAQ_REDIS_HOST: 'redis.example.test',
    QAPAQ_REDIS_PORT: '6379',
    QAPAQ_REDIS_TLS: 'true',
    QAPAQ_REDIS_PASSWORD_REF: 'secret://test/redis-password',
    QAPAQ_MINIO_ENDPOINT: 'objects.example.test',
    QAPAQ_MINIO_PORT: '443',
    QAPAQ_MINIO_TLS: 'true',
    QAPAQ_WAZUH_GATEWAY_BASE_URL: 'https://gateway.example.test',
  };
}

function provider(failure?: unknown): TestSecretProvider {
  return new TestSecretProvider(
    {
      [references.postgres]: 'postgres-secret-value',
      [references.minioAccess]: 'minio-access-value',
      [references.minioSecret]: 'minio-secret-value',
      [references.wazuhGatewayToken]: 'synthetic-gateway-token',
      [references.wazuhCursor]: '0123456789abcdef0123456789abcdef-cursor-key',
      [references.c24Fingerprint]: '0123456789abcdef0123456789abcdef-fingerprint-key',
      'secret://test/redis-password': 'redis-secret-value',
    },
    failure,
  );
}

function expectConfigurationError(action: () => unknown, code: string, path: string): void {
  try {
    action();
    throw new Error('Expected ConfigurationError');
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({ code, path });
  }
}

describe('profiles and structural validation', () => {
  it.each([
    ['development', 3000],
    ['test', 3100],
    ['production', 3000],
  ])('loads the minimal API configuration for %s', (profile, port) => {
    expect(loadApiConfig({ QAPAQ_PROFILE: profile })).toEqual({
      profile,
      host: profile === 'production' ? '0.0.0.0' : '127.0.0.1',
      port,
    });
  });

  it('requires an explicit known profile', () => {
    expectConfigurationError(() => loadApiConfig({}), 'CONFIG_PROFILE_INVALID', 'QAPAQ_PROFILE');
    expectConfigurationError(
      () => loadApiConfig({ QAPAQ_PROFILE: 'staging' }),
      'CONFIG_PROFILE_INVALID',
      'QAPAQ_PROFILE',
    );
  });

  it.each([
    ['QAPAQ_REDIS_TLS', 'yes', 'CONFIG_VALUE_INVALID'],
    ['QAPAQ_REDIS_CONNECTION_TIMEOUT', '5000', 'CONFIG_DURATION_INVALID'],
    ['QAPAQ_REDIS_CONNECTION_TIMEOUT', '-1s', 'CONFIG_DURATION_INVALID'],
    ['QAPAQ_REDIS_RETRY_LIMIT', '-1', 'CONFIG_LIMIT_INVALID'],
    ['QAPAQ_REDIS_DATABASE', '16', 'CONFIG_LIMIT_INVALID'],
  ])('rejects %s=%s', async (name, value, code) => {
    await expect(
      loadWorkerConfig({ ...validEnvironment(), [name]: value }, provider()),
    ).rejects.toMatchObject({ code, path: name });
  });

  it.each(['1x', '70000'])('rejects invalid API port %s', (port) => {
    expectConfigurationError(
      () => loadApiConfig({ QAPAQ_PROFILE: 'test', QAPAQ_API_PORT: port }),
      'CONFIG_LIMIT_INVALID',
      'QAPAQ_API_PORT',
    );
  });

  it('rejects unknown controlled variables but permits OS variables', () => {
    expect(loadApiConfig({ QAPAQ_PROFILE: 'test', PATH: 'synthetic' })).toMatchObject({
      profile: 'test',
    });
    expectConfigurationError(
      () => loadApiConfig({ QAPAQ_PROFILE: 'test', QAPAQ_UNKNOWN: 'x' }),
      'CONFIG_VALUE_INVALID',
      'QAPAQ_UNKNOWN',
    );
  });

  it.each(['QAPAQ_DEMO_MFA_EXCEPTION_UNTIL', 'QAPAQ_ADMIN_GROUP_IDS'])(
    'acepta la variable de admisión del demo %s en la allowlist',
    (name) => {
      // Regresión: una variable del runtime ausente de la allowlist hace crashear la tarea con
      // CONFIG_VALUE_INVALID y ECS revierte, dejando el despliegue sin efecto.
      expect(loadApiConfig({ QAPAQ_PROFILE: 'test', [name]: 'x' })).toMatchObject({
        profile: 'test',
      });
    },
  );

  it.each([
    'QAPAQ_WAZUH_INDEXER_URL',
    'QAPAQ_WAZUH_INDEXER_HOST',
    'QAPAQ_WAZUH_INDEXER_USERNAME',
    'QAPAQ_WAZUH_INDEXER_PASSWORD',
    'QAPAQ_OPENSEARCH_URL',
  ])('fails startup when legacy direct-backend variable %s is configured', async (name) => {
    await expect(
      loadRuntimeConfig({ ...validEnvironment(), [name]: 'forbidden' }, provider()),
    ).rejects.toMatchObject({ code: 'CONFIG_VALUE_INVALID', path: name });
  });

  it('does not mutate input and deeply freezes output', async () => {
    const environment = validEnvironment();
    const before = structuredClone(environment);
    const config = await loadRuntimeConfig(environment, provider());
    expect(environment).toEqual(before);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.postgres.pool)).toBe(true);
    expect(() => Object.assign(config.postgres.pool, { maximum: 99 })).toThrow();
  });
});

describe('secret references and resolution', () => {
  it('materializa la referencia Redis que ECS inyecta sin dejarla serializable', () => {
    const config = loadInjectedWorkerConfig({
      QAPAQ_PROFILE: 'production',
      QAPAQ_REDIS_HOST: 'valkey.example.test',
      QAPAQ_REDIS_PORT: '6379',
      QAPAQ_REDIS_TLS: 'true',
      QAPAQ_REDIS_PASSWORD_REF: 'secret://aws-secretsmanager/qapaq/demo/valkey',
      QAPAQ_REDIS_PASSWORD: 'synthetic-not-a-real-secret',
    });
    expect(config.redis).toMatchObject({
      host: 'valkey.example.test',
      port: 6379,
      tls: true,
    });
    expect(config.redis.password?.value.toJSON()).toBe(REDACTED_VALUE);
    expect(JSON.stringify(config)).not.toContain('synthetic-not-a-real-secret');
  });

  it('rechaza una referencia Redis inyectada sin valor materializado', () => {
    expectConfigurationError(
      () =>
        loadInjectedWorkerConfig({
          QAPAQ_PROFILE: 'production',
          QAPAQ_REDIS_HOST: 'valkey.example.test',
          QAPAQ_REDIS_PORT: '6379',
          QAPAQ_REDIS_TLS: 'true',
          QAPAQ_REDIS_PASSWORD_REF: 'secret://aws-secretsmanager/qapaq/demo/valkey',
        }),
      'CONFIG_REQUIRED_VALUE_MISSING',
      'QAPAQ_REDIS_PASSWORD',
    );
  });

  it('accepts neutral references and rejects malformed or literal values', () => {
    expect(parseSecretReference('secret://namespace/name')).toBe('secret://namespace/name');
    for (const value of [
      '',
      'literal-password',
      'secret://namespace',
      'secret://namespace/name?version=1',
      'secret://namespace/../name',
    ]) {
      expect(() => parseSecretReference(value)).toThrow(ConfigurationError);
    }
  });

  it.each([
    'SECRET_NOT_FOUND',
    'SECRET_ACCESS_DENIED',
    'SECRET_PROVIDER_UNAVAILABLE',
    'SECRET_RESOLUTION_FAILED',
  ] as const)('normalizes provider error %s', async (code) => {
    await expect(
      loadRuntimeConfig(validEnvironment(), provider(new SecretProviderError(code))),
    ).rejects.toMatchObject({ code });
  });

  it('sanitizes unknown provider exceptions containing a secret', async () => {
    const secret = 'provider-secret-that-must-not-leak';
    let caught: unknown;
    try {
      await loadRuntimeConfig(validEnvironment(), provider(new Error(secret)));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect(JSON.stringify(caught)).not.toContain(secret);
  });

  it('resolves a repeated reference once during one startup', async () => {
    const secrets = provider();
    await loadRuntimeConfig(
      { ...validEnvironment(), QAPAQ_MINIO_SECRET_KEY_REF: references.minioAccess },
      secrets,
    );
    expect(secrets.calls.filter((reference) => reference === references.minioAccess)).toHaveLength(
      1,
    );
  });

  it('reports a missing MinIO secret without exposing another resolved value', async () => {
    let caught: unknown;
    try {
      await loadRuntimeConfig(
        { ...validEnvironment(), QAPAQ_MINIO_SECRET_KEY_REF: 'secret://test/missing' },
        provider(),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'SECRET_NOT_FOUND', path: 'minio.secretKey' });
    expect(JSON.stringify(caught)).not.toContain('minio-access-value');
  });
});

describe('service contracts and transport policy', () => {
  it('loads separate C-24 lifecycle-provider configuration with a redacted HMAC key', async () => {
    const config = await loadControlPlaneSecretConfig(validEnvironment(), provider());
    expect(config).toMatchObject({
      profile: 'test',
      providerType: 'test-only',
      providerTimeoutMs: 5_000,
    });
    expect(config.fingerprintKey.value.toJSON()).toBe('[REDACTED]');
    expect(JSON.stringify(config)).not.toContain(
      '0123456789abcdef0123456789abcdef-fingerprint-key',
    );
  });

  it('rejects a test-only lifecycle provider in production', async () => {
    await expect(
      loadControlPlaneSecretConfig(
        { ...productionEnvironment(), QAPAQ_SECRET_PROVIDER_TYPE: 'test-only' },
        provider(),
      ),
    ).rejects.toMatchObject({
      code: 'CONFIG_VALUE_INVALID',
      path: 'QAPAQ_SECRET_PROVIDER_TYPE',
    });
  });

  it('builds PostgreSQL, Redis, MinIO and Wazuh contracts', async () => {
    const config = await loadRuntimeConfig(validEnvironment(), provider());
    expect(config.postgres).toMatchObject({
      port: 5432,
      tls: false,
      pool: { minimum: 1, maximum: 10 },
    });
    expect(config.redis).toMatchObject({ port: 6379, database: 0, retryLimit: 5 });
    expect(config.minio).toMatchObject({ port: 9000, rawBucket: 'qapaq-raw-test', retryLimit: 5 });
    expect(config.wazuh.gateway).toMatchObject({
      baseUrl: 'http://127.0.0.1:18080/',
      allowInsecureLocalhost: true,
      pageSize: 50,
      maximumPageSize: 200,
    });
    expect(config.wazuh.gateway.cursorSigningKey.value.toJSON()).toBe('[REDACTED]');
    expect(JSON.stringify(config)).not.toContain('postgres-secret-value');
  });

  it.each([
    ['QAPAQ_POSTGRES_TLS', 'false', 'CONFIG_TLS_REQUIRED'],
    ['QAPAQ_REDIS_TLS', 'false', 'CONFIG_TLS_REQUIRED'],
    ['QAPAQ_MINIO_TLS', 'false', 'CONFIG_TLS_REQUIRED'],
    ['QAPAQ_WAZUH_GATEWAY_BASE_URL', 'http://gateway.example.test', 'CONFIG_INSECURE_TRANSPORT'],
  ])('production rejects insecure %s', async (name, value, code) => {
    await expect(
      loadRuntimeConfig({ ...productionEnvironment(), [name]: value }, provider()),
    ).rejects.toMatchObject({ code, path: name });
  });

  it('permits local insecure transports only in development or test', async () => {
    await expect(
      loadRuntimeConfig(validEnvironment('development'), provider()),
    ).resolves.toMatchObject({ profile: 'development' });
    await expect(
      loadRuntimeConfig(
        { ...validEnvironment(), QAPAQ_REDIS_HOST: 'redis.example.test' },
        provider(),
      ),
    ).rejects.toMatchObject({ code: 'CONFIG_INSECURE_TRANSPORT' });
  });

  it.each([
    ['QAPAQ_POSTGRES_POOL_MIN', '11', 'postgres.pool'],
    ['QAPAQ_MINIO_RAW_BUCKET', 'INVALID_BUCKET', 'QAPAQ_MINIO_RAW_BUCKET'],
    ['QAPAQ_WAZUH_PAGE_SIZE', '0', 'QAPAQ_WAZUH_PAGE_SIZE'],
    ['QAPAQ_WAZUH_PAGE_SIZE', '201', 'QAPAQ_WAZUH_PAGE_SIZE'],
    ['QAPAQ_WAZUH_DATASET', 'arbitrary', 'QAPAQ_WAZUH_DATASET'],
  ])('rejects invalid service limit %s', async (name, value, path) => {
    await expect(
      loadRuntimeConfig({ ...validEnvironment(), [name]: value }, provider()),
    ).rejects.toMatchObject({ path });
  });

  it('rejects page size above configured maximum', async () => {
    await expect(
      loadRuntimeConfig(
        { ...validEnvironment(), QAPAQ_WAZUH_PAGE_SIZE: '100', QAPAQ_WAZUH_MAX_PAGE_SIZE: '50' },
        provider(),
      ),
    ).rejects.toMatchObject({ code: 'CONFIG_LIMIT_INVALID', path: 'wazuh.gateway.pageSize' });
  });

  it.each([
    ['QAPAQ_WAZUH_GATEWAY_BASE_URL', 'not-a-url', 'CONFIG_URL_INVALID'],
    [
      'QAPAQ_WAZUH_GATEWAY_BASE_URL',
      'https://user:password@gateway.example.test',
      'CONFIG_URL_INVALID',
    ],
    ['QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN_REF', '', 'CONFIG_REQUIRED_VALUE_MISSING'],
    ['QAPAQ_WAZUH_REQUEST_TIMEOUT', '0s', 'CONFIG_DURATION_INVALID'],
    ['QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN_REF', 'literal-token', 'SECRET_REFERENCE_INVALID'],
    ['QAPAQ_POSTGRES_CONNECTION_TIMEOUT', '999m', 'CONFIG_DURATION_INVALID'],
  ])('rejects invalid Wazuh setting %s', async (name, value, code) => {
    await expect(
      loadRuntimeConfig({ ...validEnvironment(), [name]: value }, provider()),
    ).rejects.toMatchObject({ code, path: name });
  });
});

describe('redaction and fail-safe startup', () => {
  it('redacts sensitive keys, arrays, URLs and resolved values without mutation', () => {
    const secret = 'resolved-secret-value';
    const input = {
      Password: secret,
      nested: [{ API_KEY: 'key-value' }, { url: `https://user:${secret}@example.test/path` }],
      safe: 'preserved',
    };
    const before = structuredClone(input);
    const output = redactSecrets(input, [secret]);
    expect(input).toEqual(before);
    expect(JSON.stringify(output)).not.toContain(secret);
    expect(JSON.stringify(output)).not.toContain('key-value');
    expect(output).toMatchObject({ Password: REDACTED_VALUE, safe: 'preserved' });
  });

  it('handles cycles and accessors without executing them', () => {
    const input: Record<string, unknown> = {};
    input.self = input;
    Object.defineProperty(input, 'password', {
      enumerable: true,
      get: () => {
        throw new Error('must not execute');
      },
    });
    expect(JSON.stringify(redactSecrets(input))).toContain('[CIRCULAR]');
    expect(JSON.stringify(redactSecrets(input))).not.toContain('must not execute');
  });

  it('does not invoke startup after a mandatory configuration failure', async () => {
    const start = vi.fn(async () => 'started');
    await expect(
      loadConfigurationAndStart({ QAPAQ_PROFILE: 'test' }, provider(), start),
    ).rejects.toMatchObject({ code: 'CONFIG_REQUIRED_VALUE_MISSING' });
    expect(start).not.toHaveBeenCalled();
  });

  it('rejects the environment secret adapter in production', async () => {
    await expect(loadLocalWorkerConfig(productionEnvironment())).rejects.toMatchObject({
      code: 'SECRET_PROVIDER_UNAVAILABLE',
      path: 'secretProvider',
      profile: 'production',
    });
  });

  it('keeps documented conservative maxima executable', () => {
    expect(CONFIGURATION_LIMITS).toMatchObject({
      retryMaximum: 5,
      pageSizeDefault: 50,
      pageSizeMaximum: 200,
    });
  });
});
