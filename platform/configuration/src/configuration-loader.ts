import { configurationError } from './configuration.errors.js';
import {
  SecretValue,
  type ApiConfig,
  type EnvironmentInput,
  type RedisConfig,
  type RuntimeConfig,
  type SecretCredential,
  type WorkerConfig,
} from './configuration.types.js';
import { selectProfile } from './profiles/index.js';
import { rejectUnknownQapaqVariables } from './schema/environment.schema.js';
import { parseApi, parseFullEnvironment, parseRedis } from './schema/runtime-config.schema.js';
import { normalizeSecretError, SecretProviderError } from './secrets/secret-errors.js';
import {
  secretReferenceNamespace,
  type SecretProvider,
  type SecretReference,
} from './secrets/index.js';

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function profileFrom(environment: EnvironmentInput) {
  rejectUnknownQapaqVariables(environment);
  return selectProfile(environment['QAPAQ_PROFILE']);
}

function createResolver(provider: SecretProvider, profile: ReturnType<typeof selectProfile>) {
  const cache = new Map<SecretReference, Promise<SecretCredential>>();
  return (reference: SecretReference, path: string): Promise<SecretCredential> => {
    const cached = cache.get(reference);
    if (cached) return cached;
    const resolution = provider.resolve(reference).then(
      (value) => {
        if (value === '') throw configurationError('SECRET_RESOLUTION_FAILED', path, profile.name);
        return deepFreeze({ reference, value: new SecretValue(value) });
      },
      (error: unknown) => {
        throw normalizeSecretError(error, path, profile.name);
      },
    );
    cache.set(reference, resolution);
    return resolution;
  };
}

async function materializeRedis(
  parsed: ReturnType<typeof parseRedis>,
  resolve: ReturnType<typeof createResolver>,
): Promise<RedisConfig> {
  const password = parsed.passwordReference
    ? await resolve(parsed.passwordReference, 'redis.password')
    : undefined;
  return deepFreeze({
    host: parsed.host,
    port: parsed.port,
    ...(parsed.username ? { username: parsed.username } : {}),
    ...(password ? { password } : {}),
    database: parsed.database,
    tls: parsed.tls,
    connectionTimeoutMs: parsed.connectionTimeoutMs,
    commandTimeoutMs: parsed.commandTimeoutMs,
    retryLimit: parsed.retryLimit,
  });
}

export function loadApiConfig(environment: EnvironmentInput): ApiConfig {
  const profile = profileFrom(environment);
  return deepFreeze(parseApi(environment, profile));
}

/** El worker inactivo de C-02 no necesita resolver secretos de dependencias. */
export function loadWorkerEntrypointConfig(environment: EnvironmentInput) {
  return deepFreeze({ profile: profileFrom(environment).name });
}

export async function loadWorkerConfig(
  environment: EnvironmentInput,
  provider: SecretProvider,
): Promise<WorkerConfig> {
  const profile = profileFrom(environment);
  const resolve = createResolver(provider, profile);
  return deepFreeze({
    profile: profile.name,
    redis: await materializeRedis(parseRedis(environment, profile), resolve),
  });
}

export async function loadRuntimeConfig(
  environment: EnvironmentInput,
  provider: SecretProvider,
): Promise<RuntimeConfig> {
  const profile = profileFrom(environment);
  const parsed = parseFullEnvironment(environment, profile);
  const resolve = createResolver(provider, profile);
  const [
    postgresPassword,
    minioAccessKey,
    minioSecretKey,
    wazuhUsername,
    wazuhPassword,
    wazuhCa,
    wazuhCursorKey,
    wazuhManagerUsername,
    wazuhManagerPassword,
    wazuhManagerCa,
  ] = await Promise.all([
    resolve(parsed.postgres.passwordReference, 'postgres.password'),
    resolve(parsed.minio.accessKeyReference, 'minio.accessKey'),
    resolve(parsed.minio.secretKeyReference, 'minio.secretKey'),
    resolve(parsed.wazuh.indexer.usernameReference, 'wazuh.indexer.username'),
    resolve(parsed.wazuh.indexer.passwordReference, 'wazuh.indexer.password'),
    resolve(parsed.wazuh.indexer.caReference, 'wazuh.indexer.certificateAuthority'),
    resolve(parsed.wazuh.indexer.cursorSigningKeyReference, 'wazuh.indexer.cursorSigningKey'),
    resolve(parsed.wazuh.manager.usernameReference, 'wazuh.manager.username'),
    resolve(parsed.wazuh.manager.passwordReference, 'wazuh.manager.password'),
    resolve(parsed.wazuh.manager.caReference, 'wazuh.manager.certificateAuthority'),
  ]);
  const { passwordReference: _postgresReference, ...postgres } = parsed.postgres;
  const {
    accessKeyReference: _accessReference,
    secretKeyReference: _secretReference,
    ...minio
  } = parsed.minio;
  const {
    usernameReference: _usernameReference,
    passwordReference: _wazuhPasswordReference,
    caReference: _caReference,
    cursorSigningKeyReference: _cursorSigningKeyReference,
    ...wazuhIndexer
  } = parsed.wazuh.indexer;
  const {
    usernameReference: _managerUsernameReference,
    passwordReference: _managerPasswordReference,
    caReference: _managerCaReference,
    ...wazuhManager
  } = parsed.wazuh.manager;
  return deepFreeze({
    profile: profile.name,
    api: parsed.api,
    postgres: { ...postgres, password: postgresPassword },
    redis: await materializeRedis(parsed.redis, resolve),
    minio: { ...minio, accessKey: minioAccessKey, secretKey: minioSecretKey },
    wazuh: {
      indexer: {
        ...wazuhIndexer,
        username: wazuhUsername,
        password: wazuhPassword,
        certificateAuthority: wazuhCa,
        cursorSigningKey: wazuhCursorKey,
      },
      manager: {
        ...wazuhManager,
        username: wazuhManagerUsername,
        password: wazuhManagerPassword,
        certificateAuthority: wazuhManagerCa,
      },
    },
  });
}

export async function loadConfigurationAndStart<T>(
  environment: EnvironmentInput,
  provider: SecretProvider,
  start: (config: RuntimeConfig) => Promise<T>,
): Promise<T> {
  const config = await loadRuntimeConfig(environment, provider);
  return start(config);
}

class LocalEnvironmentSecretProvider implements SecretProvider {
  readonly #environment: EnvironmentInput;

  public constructor(environment: EnvironmentInput) {
    this.#environment = environment;
  }

  public async resolve(reference: SecretReference): Promise<string> {
    if (secretReferenceNamespace(reference) !== 'environment')
      throw new SecretProviderError('SECRET_NOT_FOUND');
    const key = reference.slice(reference.indexOf('/', 'secret://'.length) + 1);
    const value = this.#environment[key];
    if (value === undefined || value === '') throw new SecretProviderError('SECRET_NOT_FOUND');
    return value;
  }
}

function assertLocalSecretProviderAllowed(environment: EnvironmentInput): void {
  const profile = profileFrom(environment);
  if (profile.name === 'production')
    throw configurationError('SECRET_PROVIDER_UNAVAILABLE', 'secretProvider', profile.name);
}

export async function loadLocalWorkerConfig(environment: EnvironmentInput): Promise<WorkerConfig> {
  assertLocalSecretProviderAllowed(environment);
  return loadWorkerConfig(environment, new LocalEnvironmentSecretProvider(environment));
}
