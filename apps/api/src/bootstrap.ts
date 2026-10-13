import {
  loadAccessConfig,
  loadApiConfig,
  loadDetectionContextConfig,
  loadDirectoryConfig,
  loadEntityRefKey,
  loadIngestionConfig,
  loadRoleGrantsConfig,
  loadTeamsWorkflowUrl,
  loadAlertMailSender,
  loadVapidPrivateKey,
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
import {
  createWazuhEventProvider,
  createWazuhEventsReader,
  createWazuhIngestion,
  OFFICE365_SUBSCRIPTIONS,
  WAZUH_DATASET,
} from './runtime/wazuh-ingestion.js';
import { EntraClientCredentialsTokenSource } from './runtime/workload-token.js';
import { createRoleGrantResolver } from './runtime/role-grants.js';
import { cachedOwnerSource, createDirectorySyncPass } from './runtime/directory-sync.js';
import { GraphDirectoryReader } from './runtime/graph-directory.js';
import { directoryRecipients } from './runtime/notification-recipients.js';
import { GraphMailFallbackChannel } from './runtime/email-fallback.js';
import { ephemeralVapidKey, VapidPushSender, vapidKeyFrom } from './runtime/web-push.js';
import { InMemoryPushSubscriptionStore, type PushSubscriptionStore } from '@qapaq/soar';
import { NotificationDispatcher } from './runtime/notification-dispatcher.js';
import { DirectoryError, InMemoryDirectoryStore, type DirectoryStore } from '@qapaq/access';
import {
  measureSourceActivity,
  recordSourceHealth,
  sourceHealthMonitor,
} from './runtime/source-health.js';

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
  readonly directory: DirectoryStore & { close(): Promise<void> };
  readonly push: PushSubscriptionStore & { close(): Promise<void> };
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
    { PostgresNotificationAttemptStore, PostgresPushSubscriptionStore },
    { PostgresSessionStore, PostgresDirectoryStore },
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
  // Dispositivos Web Push: pocas escrituras (registro y resultado de cada aviso).
  const push = PostgresPushSubscriptionStore.connect({
    connectionString,
    connectionTimeoutMs: postgres.connectionTimeoutMs,
    statementTimeoutMs: postgres.statementTimeoutMs,
    maxConnections: 2,
  });
  // Padrón del grupo de admisión: un ciclo cada varios minutos, pool mínimo.
  const directory = PostgresDirectoryStore.connect({
    connectionString,
    connectionTimeoutMs: postgres.connectionTimeoutMs,
    statementTimeoutMs: postgres.statementTimeoutMs,
    maxConnections: 2,
  });
  try {
    // Falla al arrancar, no en la primera alerta: sin base o con esquema viejo no se sirve.
    await soc.ready();
  } catch (error) {
    await Promise.allSettled([
      soc.close(),
      notifications.close(),
      sessions.close(),
      directory.close(),
      push.close(),
    ]);
    throw error;
  }
  return { soc, notifications, sessions, directory, push };
}

export async function buildApi(
  environment: EnvironmentInput,
  emit: ApiEvent,
  /** Fallos del bucle de despacho; el entrypoint los registra sin datos del mensaje. */
  onDispatchError?: (error: unknown) => void,
  /** Métricas del proceso; solo el entrypoint puede leer `process`. */
  processInfo?: () => ProcessInfo,
  /** Fallos de la ingesta de fuentes; el entrypoint los registra solo con su código. */
  onIngestionError?: (error: unknown) => void,
  /** Fallos del padrón (resolución del grupo y sincronización); solo con su código. */
  onDirectoryError?: (error: unknown) => void,
) {
  const config = loadApiConfig(environment);
  const access = loadAccessConfig(environment);
  const detection = loadDetectionContextConfig(environment);
  const persistenceConfig = loadSocPersistenceConfig(environment);
  const entityRefKey = loadEntityRefKey(environment);
  const ingestionConfig = loadIngestionConfig(environment);
  const roleGrants = loadRoleGrantsConfig(environment);
  const directoryConfig = loadDirectoryConfig(environment);
  const teamsWorkflowUrl = loadTeamsWorkflowUrl(environment);
  const alertMailSender = loadAlertMailSender(environment);
  // Web Push: clave VAPID del secreto; en desarrollo y pruebas, efímera. En producción sin
  // clave, el push queda deshabilitado (la consola lo informa) y el API arranca igual.
  const vapidSecret = loadVapidPrivateKey(environment);
  const vapidKey = vapidSecret
    ? vapidKeyFrom(vapidSecret.reveal())
    : config.profile === 'production'
      ? undefined
      : ephemeralVapidKey();
  const clientSecret = environment['QAPAQ_ENTRA_CLIENT_SECRET'];
  // Sprint 5 · fase 3: el padrón usa un token de aplicación de Graph con el mismo secreto.
  if (directoryConfig.mode === 'graph' && !clientSecret) {
    throw new Error('DIRECTORY_CLIENT_SECRET_MISSING');
  }
  const lifecycle = new ApiLifecycle(emit);
  emit('starting');
  // Sprint 5 · fases 0 y 1: la ingesta necesita el client secret para el token de workload;
  // `wazuh` sin secreto es un error de despliegue y no arranca.
  if (ingestionConfig.source === 'wazuh' && !clientSecret) {
    throw new Error('INGESTION_CLIENT_SECRET_MISSING');
  }
  const eventProvider =
    ingestionConfig.source === 'wazuh' && clientSecret
      ? createWazuhEventProvider({
          sourceId: ingestionConfig.sourceId,
          gatewayBaseUrl: ingestionConfig.gatewayBaseUrl,
          accessToken: new EntraClientCredentialsTokenSource({
            tenantId: access.tenantId,
            clientId: access.clientId,
            clientSecret,
            scope: ingestionConfig.gatewayScope,
          }).token,
        })
      : undefined;
  // La fuente se declara siempre: sin ingesta aparece como `disabled`, no como hueco.
  const monitor = sourceHealthMonitor({
    key: {
      tenantId: access.tenantId,
      sourceId: ingestionConfig.source === 'wazuh' ? ingestionConfig.sourceId : 'wazuh-indexer',
      dataset: WAZUH_DATASET,
    },
    displayName: 'Wazuh Indexer · alertas',
    enabled: ingestionConfig.source === 'wazuh',
    intervalMs: ingestionConfig.source === 'wazuh' ? ingestionConfig.intervalMs : 60_000,
  });
  // Sprint 5 · fase 3: lector de Graph y grupo de admisión. Si el despliegue declara el nombre
  // del grupo en vez del ID, se resuelve una vez aquí con tiempo acotado. Si no se puede (sin
  // consentimiento, nombre ambiguo, red), el API arranca igual con el padrón deshabilitado y el
  // código queda en el log: Graph nunca impide servir el SOC.
  const directoryReader =
    directoryConfig.mode === 'graph' && clientSecret
      ? new GraphDirectoryReader({
          accessToken: new EntraClientCredentialsTokenSource({
            tenantId: access.tenantId,
            clientId: access.clientId,
            clientSecret,
            scope: 'https://graph.microsoft.com/.default',
          }).token,
        })
      : undefined;
  let directoryGroupId: string | undefined;
  if (directoryConfig.mode === 'graph' && directoryReader) {
    if (directoryConfig.groupId) {
      directoryGroupId = directoryConfig.groupId;
    } else {
      try {
        directoryGroupId = await Promise.race([
          directoryReader.resolveGroupId(directoryConfig.groupName!),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new DirectoryError('DIRECTORY_UNAVAILABLE')), 10_000).unref?.(),
          ),
        ]);
      } catch (error) {
        (onDirectoryError ?? (() => undefined))(error);
      }
    }
  }
  const durable = await durableStoresFor(persistenceConfig);
  const directoryStore: DirectoryStore = durable?.directory ?? new InMemoryDirectoryStore();
  // La URL del Teams Workflow es un secreto y se resuelve por `SecretProvider`, no por
  // entorno. Mientras ese provider no esté disponible, el transporte queda sin destino
  // alcanzable y el crítico sale por el fallback de C-20, que es el comportamiento
  // declarado para esta condición.
  const runtime: SecOpsRuntime = new SecOpsRuntime({
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
    roleGrants: createRoleGrantResolver(
      roleGrants,
      directoryGroupId
        ? cachedOwnerSource(directoryStore, access.tenantId, directoryGroupId)
        : undefined,
    ),
    roleGrantsConfig: roleGrants,
    ...(teamsWorkflowUrl ? { teamsWorkflowUrl } : {}),
    // Respaldo: si Teams no confirma, correo a los mismos destinatarios; si no, la consola.
    ...(alertMailSender && clientSecret
      ? {
          fallbackChain: (consoleFallback) =>
            new GraphMailFallbackChannel({
              sender: alertMailSender,
              accessToken: new EntraClientCredentialsTokenSource({
                tenantId: access.tenantId,
                clientId: access.clientId,
                clientSecret,
                scope: 'https://graph.microsoft.com/.default',
              }).token,
              next: consoleFallback,
              ...(onDispatchError ? { onError: (code) => onDispatchError(new Error(code)) } : {}),
            }),
        }
      : {}),
    // Destinatarios por rol desde el padrón. Las funciones leen el runtime al despachar, que
    // siempre ocurre después de construirlo.
    recipients: directoryRecipients({
      directory: () => runtime.directory,
      sessions: () => runtime.sessions,
      grants: roleGrants,
      now: () => runtime.now(),
    }),
    directory:
      directoryGroupId && directoryConfig.mode === 'graph'
        ? {
            mode: 'graph',
            groupId: directoryGroupId,
            intervalMs: directoryConfig.intervalMs,
            store: directoryStore,
          }
        : { mode: 'disabled' },
    sourceHealth: monitor,
    ...(vapidKey
      ? {
          push: {
            store: durable?.push ?? new InMemoryPushSubscriptionStore(),
            sender: new VapidPushSender({ privateKey: vapidKey, subject: access.consoleBaseUrl }),
          },
        }
      : {}),
    ...(eventProvider && ingestionConfig.source === 'wazuh'
      ? {
          events: createWazuhEventsReader({
            provider: eventProvider,
            tenantId: access.tenantId,
            sourceId: ingestionConfig.sourceId,
          }),
        }
      : {}),
  });
  const ingestion =
    eventProvider && ingestionConfig.source === 'wazuh'
      ? createWazuhIngestion({
          runtime,
          tenantId: access.tenantId,
          sourceId: ingestionConfig.sourceId,
          intervalMs: ingestionConfig.intervalMs,
          initialLookbackMs: ingestionConfig.initialLookbackMs,
          onError: onIngestionError ?? (() => undefined),
          provider: eventProvider,
          afterPass: async () => {
            await recordSourceHealth(
              monitor,
              runtime.soc.ingestion,
              runtime.soc.audit,
              runtime.now(),
            );
            // Actividad por suscripción: informativa. Si falla, la salud ya quedó registrada y
            // la vista muestra la medición anterior con su fecha; no se marca la pasada fallida.
            const readActivity = eventProvider.readActivity?.bind(eventProvider);
            if (readActivity) {
              await measureSourceActivity({
                monitor,
                state: runtime.soc.ingestion,
                readActivity,
                expectedStreams: OFFICE365_SUBSCRIPTIONS,
                now: runtime.now(),
              }).catch(() => false);
            }
          },
        })
      : undefined;
  // Sprint 5 · fase 3: sincronización del padrón por Microsoft Graph (token de aplicación).
  const directorySync =
    directoryGroupId && directoryReader && directoryConfig.mode === 'graph'
      ? new NotificationDispatcher({
          drain: createDirectorySyncPass({
            tenantId: access.tenantId,
            groupId: directoryGroupId,
            store: directoryStore,
            now: () => runtime.now(),
            // Quien sale del grupo o deja de ser dueño pierde sus sesiones abiertas. Un dueño
            // que sigue declarado en el deploy conserva el admin y no se toca.
            reconcileAccess: async ({ removedMembers, formerOwners }) => {
              await runtime.revokeSessionsByOid(removedMembers, 'membership_removed');
              await runtime.revokeSessionsByOid(
                formerOwners.filter((oid) => !roleGrants.groupOwnerOids.includes(oid)),
                'ownership_removed',
              );
            },
            reader: directoryReader,
          }),
          intervalMs: directoryConfig.intervalMs,
          onError: onDirectoryError ?? (() => undefined),
        })
      : undefined;
  const application = await composeApi(config, lifecycle, runtime);
  let listening: Promise<unknown> | undefined;
  const stop = () =>
    lifecycle.shutdown(async () => {
      // Si llega una señal durante el arranque, esperar antes de cerrar evita dejar un servidor abierto.
      if (listening) await Promise.allSettled([listening]);
      // Primero se detiene el despacho: espera la pasada en curso para no dejar leases
      // tomados por un proceso que ya no existe.
      await ingestion?.stop();
      await directorySync?.stop();
      await runtime.stopDispatcher();
      await application.close();
      await runtime.soc.close();
      await durable?.notifications.close();
      await durable?.sessions.close();
      await durable?.directory.close();
      await durable?.push.close();
    }, API_SHUTDOWN_TIMEOUT_MS);
  return {
    application,
    lifecycle,
    runtime,
    stop,
    /** Modo efectivo del estado SOC, para que el arranque lo registre sin datos de conexión. */
    persistence: runtime.soc.kind,
    /** Fuente de ingesta efectiva, para el registro de arranque. */
    ingestion: ingestionConfig.source,
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
          ingestion?.start();
          directorySync?.start();
        }
      } catch (error) {
        lifecycle.fail();
        await stop();
        throw error;
      }
    },
  };
}
