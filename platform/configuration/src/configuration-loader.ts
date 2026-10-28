import { configurationError } from './configuration.errors.js';
import {
  SecretValue,
  type ApiConfig,
  type ControlPlaneSecretConfig,
  type EnvironmentInput,
  type RedisConfig,
  type RuntimeConfig,
  type SecretCredential,
  type SocPersistenceConfig,
  type WorkerConfig,
} from './configuration.types.js';
import { selectProfile } from './profiles/index.js';
import { rejectUnknownQapaqVariables } from './schema/environment.schema.js';
import { parseAccess, type AccessConfig } from './schema/access.schema.js';
import { parseDetectionContext, type DetectionContextConfig } from './schema/detection.schema.js';
import { parseIngestionConfig, type IngestionConfig } from './schema/ingestion.schema.js';
import { parseRoleGrants, type RoleGrantsConfig } from './schema/role-grants.schema.js';
import { parseDirectoryConfig, type DirectoryConfig } from './schema/directory.schema.js';
import { parseAlertMailSender, parseTeamsWorkflowUrl } from './schema/notifications.schema.js';
import {
  parseApi,
  parseControlPlaneSecretConfig,
  parseFullEnvironment,
  parseRedis,
  parseSocPersistence,
} from './schema/runtime-config.schema.js';
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

/** C-18/C-25 — identidad, red confiable y canal crítico del BFF. */
export function loadAccessConfig(environment: EnvironmentInput): AccessConfig {
  const profile = profileFrom(environment);
  return deepFreeze(parseAccess(environment, profile));
}

/**
 * C-17 — persistencia del estado SOC del BFF. En modo `postgres` exige la contraseña
 * inyectada por el orquestador; nunca se acepta vacía ni se registra.
 */
export function loadSocPersistenceConfig(environment: EnvironmentInput): SocPersistenceConfig {
  const profile = profileFrom(environment);
  const parsed = parseSocPersistence(environment, profile);
  if (parsed.mode === 'memory' || !parsed.postgres) return deepFreeze({ mode: 'memory' });
  const password = environment['QAPAQ_POSTGRES_PASSWORD'];
  if (password === undefined || password === '') {
    throw configurationError(
      'CONFIG_REQUIRED_VALUE_MISSING',
      'QAPAQ_POSTGRES_PASSWORD',
      profile.name,
    );
  }
  return deepFreeze({
    mode: 'postgres',
    postgres: { ...parsed.postgres, password: new SecretValue(password) },
  });
}

/** Longitud mínima de la clave de referencias de entidad (256 bits en texto). */
const ENTITY_REF_KEY_MINIMUM_LENGTH = 32;

/**
 * D-10b — clave HMAC de las referencias opacas de entidad. Producción la recibe inyectada
 * como secreto; desarrollo y test usan un valor conocido del perfil. Rotarla invalida las
 * referencias guardadas, por eso no hay rotación automática.
 *
 * Con `QAPAQ_SOC_PERSISTENCE=postgres` es obligatoria (D-13): las alertas durables guardan
 * sus referencias y emitirlas sin clave, o con otra, rompería el pivote de forma
 * irreversible. En `memory` (primer despliegue, antes de `bootstrap-roles`) puede faltar y
 * el API arranca sin pivote por entidad. Presente pero corta, siempre falla.
 */
export function loadEntityRefKey(environment: EnvironmentInput): SecretValue | undefined {
  const profile = profileFrom(environment);
  const value = environment['QAPAQ_ENTITY_REF_KEY'] ?? profile.defaults['QAPAQ_ENTITY_REF_KEY'];
  const persistence =
    environment['QAPAQ_SOC_PERSISTENCE'] ?? profile.defaults['QAPAQ_SOC_PERSISTENCE'];
  if (value === undefined || value === '') {
    if (persistence === 'postgres') {
      throw configurationError(
        'CONFIG_REQUIRED_VALUE_MISSING',
        'QAPAQ_ENTITY_REF_KEY',
        profile.name,
      );
    }
    return undefined;
  }
  if (value.length < ENTITY_REF_KEY_MINIMUM_LENGTH) {
    throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_ENTITY_REF_KEY', profile.name);
  }
  return new SecretValue(value);
}

/** C-16 — contexto de negocio para priorizar; listas vacías si el ambiente no lo declara. */
export function loadDetectionContextConfig(environment: EnvironmentInput): DetectionContextConfig {
  const profile = profileFrom(environment);
  return deepFreeze(parseDetectionContext(environment, profile));
}

/** Sprint 5 · fase 0 — fuente de ingesta del SOC; `disabled` si el ambiente no la declara. */
export function loadIngestionConfig(environment: EnvironmentInput): IngestionConfig {
  const profile = profileFrom(environment);
  return deepFreeze(parseIngestionConfig(environment, profile));
}

/** Sprint 5 — roles concedidos por el deploy (asignaciones y dueños del grupo). */
export function loadRoleGrantsConfig(environment: EnvironmentInput): RoleGrantsConfig {
  const profile = profileFrom(environment);
  return deepFreeze(parseRoleGrants(environment, profile));
}

/** Sprint 5 · fase 3 — sincronización del padrón; `disabled` si el ambiente no la declara. */
export function loadDirectoryConfig(environment: EnvironmentInput): DirectoryConfig {
  const profile = profileFrom(environment);
  return deepFreeze(parseDirectoryConfig(environment, profile));
}

/** Sprint 5 — URL del Teams Workflow (secreto); `undefined` si el ambiente no la declara. */
export function loadTeamsWorkflowUrl(environment: EnvironmentInput): string | undefined {
  return parseTeamsWorkflowUrl(environment, profileFrom(environment));
}

/** Sprint 5 — buzón remitente del respaldo por correo; `undefined` = solo consola. */
export function loadAlertMailSender(environment: EnvironmentInput): string | undefined {
  return parseAlertMailSender(environment, profileFrom(environment));
}

/**
 * Sprint 5 — clave privada VAPID para Web Push (`QAPAQ_VAPID_PRIVATE_KEY`, PKCS#8 en base64,
 * desde Secrets Manager). `undefined` si el ambiente no la declara: el push queda deshabilitado.
 */
export function loadVapidPrivateKey(environment: EnvironmentInput): SecretValue | undefined {
  const profile = profileFrom(environment);
  const value = environment['QAPAQ_VAPID_PRIVATE_KEY'];
  if (value === undefined || value === '') return undefined;
  if (!/^[A-Za-z0-9+/=]{100,400}$/u.test(value)) {
    throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_VAPID_PRIVATE_KEY', profile.name);
  }
  return new SecretValue(value);
}

/**
 * Clave de la API pública de VirusTotal (`QAPAQ_VIRUSTOTAL_API_KEY`, resuelta desde Key Vault
 * por `QAPAQ_VIRUSTOTAL_API_KEY_REF`). Es opcional: `undefined` deja el enriquecimiento por hash
 * sin configurar y el API arranca igual. Solo admite caracteres alfanuméricos para que una
 * clave mal copiada (comillas, saltos de línea) falle aquí y no en la primera consulta.
 */
export function loadVirusTotalApiKey(environment: EnvironmentInput): SecretValue | undefined {
  const profile = profileFrom(environment);
  const value = environment['QAPAQ_VIRUSTOTAL_API_KEY']?.trim();
  if (value === undefined || value === '') return undefined;
  if (!/^[A-Za-z0-9]{32,128}$/u.test(value)) {
    throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_VIRUSTOTAL_API_KEY', profile.name);
  }
  return new SecretValue(value);
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

export async function loadControlPlaneSecretConfig(
  environment: EnvironmentInput,
  provider: SecretProvider,
): Promise<ControlPlaneSecretConfig> {
  const profile = profileFrom(environment);
  const parsed = parseControlPlaneSecretConfig(environment, profile);
  const resolve = createResolver(provider, profile);
  const fingerprintKey = await resolve(
    parsed.fingerprintKeyReference,
    'secretControlPlane.fingerprintKey',
  );
  return deepFreeze({
    profile: profile.name,
    providerType: parsed.providerType,
    providerTimeoutMs: parsed.providerTimeoutMs,
    fingerprintKey,
  });
}

export async function loadRuntimeConfig(
  environment: EnvironmentInput,
  provider: SecretProvider,
): Promise<RuntimeConfig> {
  const profile = profileFrom(environment);
  const parsed = parseFullEnvironment(environment, profile);
  const resolve = createResolver(provider, profile);
  const [postgresPassword, minioAccessKey, minioSecretKey, gatewayToken, wazuhCursorKey] =
    await Promise.all([
      resolve(parsed.postgres.passwordReference, 'postgres.password'),
      resolve(parsed.minio.accessKeyReference, 'minio.accessKey'),
      resolve(parsed.minio.secretKeyReference, 'minio.secretKey'),
      resolve(parsed.wazuh.gateway.accessTokenReference, 'wazuh.gateway.accessToken'),
      resolve(parsed.wazuh.gateway.cursorSigningKeyReference, 'wazuh.gateway.cursorSigningKey'),
    ]);
  const { passwordReference: _postgresReference, ...postgres } = parsed.postgres;
  const {
    accessKeyReference: _accessReference,
    secretKeyReference: _secretReference,
    ...minio
  } = parsed.minio;
  const {
    accessTokenReference: _accessTokenReference,
    cursorSigningKeyReference: _cursorSigningKeyReference,
    ...wazuhGateway
  } = parsed.wazuh.gateway;
  return deepFreeze({
    profile: profile.name,
    api: parsed.api,
    postgres: { ...postgres, password: postgresPassword },
    redis: await materializeRedis(parsed.redis, resolve),
    minio: { ...minio, accessKey: minioAccessKey, secretKey: minioSecretKey },
    wazuh: {
      gateway: {
        ...wazuhGateway,
        accessToken: gatewayToken,
        cursorSigningKey: wazuhCursorKey,
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
