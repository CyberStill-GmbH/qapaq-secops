import {
  loadAccessConfig,
  loadApiConfig,
  loadDetectionContextConfig,
  loadEntityRefKey,
  loadSocPersistenceConfig,
  type DetectionContextConfig,
  type EnvironmentInput,
  type SocPersistenceConfig,
} from '@qapaq/configuration';
import type { PrioritizationContext } from '@qapaq/detection';
import type { SessionStore } from '@qapaq/access';
import type { AttemptStore } from '@qapaq/soar';
import type { SocPersistence } from '@qapaq/soc';
import { composeApi } from './composition-root.js';
import { ApiLifecycle, type ApiEvent } from './lifecycle.js';
import { entityRefFactory } from './runtime/entity-refs.js';
import type { ProcessInfo } from './soc/operations-health.js';
import { SecOpsRuntime } from './runtime/secops-runtime.js';

/** Límite de cierre de C-02: 5 segundos, incluidos el despacho en curso y los pools. */
export const API_SHUTDOWN_TIMEOUT_MS = 5_000;

/** Traduce la configuración validada al contexto que consume la priorización de C-16. */
export function detectionContextFrom(config: DetectionContextConfig): PrioritizationContext {
  return {
    privilegedIdentities: new Set(config.privilegedIdentities),
    breakGlassIdentities: new Set(config.breakGlassIdentities),
    criticalAssets: new Set(config.criticalAssets),
    internetFacingAssets: new Set(config.internetFacingAssets),
    knownBenignRuleIds: new Set(config.knownBenignRules.map((rule) => rule.ruleId)),
  };
}

type PostgresPersistenceConfig = Extract<SocPersistenceConfig, { mode: 'postgres' }>;

/** URL de conexión armada solo en memoria del proceso; nunca se registra. */
function connectionStringFor({ postgres }: PostgresPersistenceConfig): string {
  const url = new URL('postgresql://placeholder');
  url.hostname = postgres.host;
  url.port = String(postgres.port);
  url.pathname = `/${encodeURIComponent(postgres.database)}`;
  url.username = encodeURIComponent(postgres.username);
  url.password = encodeURIComponent(postgres.password.reveal());
  // `verify-full`: cifrado y verificación de certificado y nombre. El CA del proveedor
  // (p. ej. el bundle de RDS) se entrega al proceso con NODE_EXTRA_CA_CERTS.
  if (postgres.tls) url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

interface DurableStores {
  readonly soc: SocPersistence;
  readonly notifications: AttemptStore & { close(): Promise<void> };
  readonly sessions: SessionStore & { close(): Promise<void> };
}

/**
 * Crea los adapters durables: estado SOC (con la cola del outbox) y, en el mismo modo, los
 * intentos de notificación de C-20. Van juntos a propósito: una cola durable con intentos en
 * memoria podría reenviar un crítico ya entregado después de un reinicio.
 *
 * Se importan de forma diferida: un runtime en memoria (specs, desarrollo) no carga Prisma
 * ni el driver de PostgreSQL.
 */
async function durableStoresFor(config: SocPersistenceConfig): Promise<DurableStores | undefined> {
  if (config.mode === 'memory') return undefined;
  const [
    { PostgresSocPersistence },
    { PostgresNotificationAttemptStore },
    { PostgresSessionStore },
  ] = await Promise.all([
    import('@qapaq/soc/postgres'),
    import('@qapaq/soar/postgres'),
    import('@qapaq/access/postgres'),
  ]);
  const { postgres } = config;
  const connectionString = connectionStringFor(config);
  const soc = PostgresSocPersistence.connect({
    connectionString,
    connectionTimeoutMs: postgres.connectionTimeoutMs,
    statementTimeoutMs: postgres.statementTimeoutMs,
    maxConnections: postgres.poolMaximum,
  });
  // Pool chico: el despacho hace pocas escrituras por pasada.
  const notifications = PostgresNotificationAttemptStore.connect({
    connectionString,
    connectionTimeoutMs: postgres.connectionTimeoutMs,
    statementTimeoutMs: postgres.statementTimeoutMs,
    maxConnections: 2,
  });
  // Sesiones: una lectura por request autenticada; pool propio para no competir con el SOC.
  const sessions = PostgresSessionStore.connect({
    connectionString,
    connectionTimeoutMs: postgres.connectionTimeoutMs,
    statementTimeoutMs: postgres.statementTimeoutMs,
    maxConnections: 4,
  });
  try {
    // Falla al arrancar, no en la primera alerta: sin base o con esquema viejo no se sirve.
    await soc.ready();
  } catch (error) {
    await Promise.allSettled([soc.close(), notifications.close(), sessions.close()]);
    throw error;
  }
  return { soc, notifications, sessions };
}

export async function buildApi(
  environment: EnvironmentInput,
  emit: ApiEvent,
  /** Fallos del bucle de despacho; el entrypoint los registra sin datos del mensaje. */
  onDispatchError?: (error: unknown) => void,
  /** Métricas del proceso; solo el entrypoint puede leer `process`. */
  processInfo?: () => ProcessInfo,
) {
  const config = loadApiConfig(environment);
  const access = loadAccessConfig(environment);
  const detection = loadDetectionContextConfig(environment);
  const persistenceConfig = loadSocPersistenceConfig(environment);
  const entityRefKey = loadEntityRefKey(environment);
  const clientSecret = environment['QAPAQ_ENTRA_CLIENT_SECRET'];
  const lifecycle = new ApiLifecycle(emit);
  emit('starting');
  const durable = await durableStoresFor(persistenceConfig);
  // La URL del Teams Workflow es un secreto y se resuelve por `SecretProvider`, no por
  // entorno. Mientras ese provider no esté disponible, el transporte queda sin destino
  // alcanzable y el crítico sale por el fallback de C-20, que es el comportamiento
  // declarado para esta condición.
  const runtime = new SecOpsRuntime({
    access,
    profile: config.profile,
    detectionContext: detectionContextFrom(detection),
    ...(entityRefKey ? { entityRefs: entityRefFactory(entityRefKey.reveal()) } : {}),
    ...(durable
      ? { soc: durable.soc, notifications: durable.notifications, sessions: durable.sessions }
      : {}),
    ...(onDispatchError ? { onDispatchError } : {}),
    ...(processInfo ? { processInfo } : {}),
    ...(clientSecret !== undefined ? { clientSecret } : {}),
  });
  const application = await composeApi(config, lifecycle, runtime);
  let listening: Promise<unknown> | undefined;
  const stop = () =>
    lifecycle.shutdown(async () => {
      // Si llega una señal durante el arranque, esperar antes de cerrar evita dejar un servidor abierto.
      if (listening) await Promise.allSettled([listening]);
      // Primero se detiene el despacho: espera la pasada en curso para no dejar leases
      // tomados por un proceso que ya no existe.
      await runtime.stopDispatcher();
      await application.close();
      await runtime.soc.close();
      await durable?.notifications.close();
      await durable?.sessions.close();
    }, API_SHUTDOWN_TIMEOUT_MS);
  return {
    application,
    lifecycle,
    runtime,
    stop,
    /** Modo efectivo del estado SOC, para que el arranque lo registre sin datos de conexión. */
    persistence: runtime.soc.kind,
    async start() {
      try {
        if (lifecycle.state !== 'starting') throw new Error('STARTUP_CANCELLED');
        listening = application.listen(config.port, config.host);
        await listening;
        if (lifecycle.state === 'starting') {
          lifecycle.markReady();
          // El despacho arranca con el servidor listo; las specs que no llaman `start` no lo
          // activan y despachan con `POST /api/notifications/drain`.
          runtime.startDispatcher();
        }
      } catch (error) {
        lifecycle.fail();
        await stop();
        throw error;
      }
    },
  };
}
