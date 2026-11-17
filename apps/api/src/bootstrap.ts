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
  loadNotificationPolicy,
  loadDemoAdminLoginConfig,
  loadVapidPrivateKey,
  loadSocPersistenceConfig,
  type DetectionContextConfig,
  type EnvironmentInput,
  type SocPersistenceConfig,
} from '@qapaq/configuration';
import type { PrioritizationContext } from '@qapaq/detection';
import type { SessionStore } from '@qapaq/access';
import {
  ConsoleFallbackChannel,
  InMemoryChannelStore,
  notificationPolicyFrom,
  type AttemptStore,
  type ChannelStore,
} from '@qapaq/soar';
import { SOC_KNOWLEDGE } from './assistant/soc-knowledge.generated.js';
import { deriveChannelKey, NotificationChannelRegistry } from './runtime/notification-channels.js';
import { notificationEnricher } from './runtime/notification-enricher.js';
import { entityRiskLookup } from './runtime/entity-risk.js';
import type { SocPersistence, WazuhPushInboxStore } from '@qapaq/soc';
import { composeApi } from './composition-root.js';
import { createAssistantService } from './assistant/assistant-service.js';
import { assistantArtifactStoreFor, startArtifactPurge } from './assistant/artifact-store.js';
import { assistantConversationStoreFor } from './assistant/conversation-history.js';
import { composeAnalyst } from './assistant/analyst-wiring.js';
import type { AnalystLog } from './runtime/analyst-host.js';
import type { InjectingServer } from './assistant/internal-client.js';
import { ApiLifecycle, type ApiEvent } from './lifecycle.js';
import { resolveApiSecretEnvironment } from './runtime/secret-environment.js';
import { DemoAdminLogin } from './access/demo-admin-credentials.js';
import { entityRefFactory } from './runtime/entity-refs.js';
import { deriveCsrfKey } from './http/csrf.js';
import type { ProcessInfo } from './soc/operations-health.js';
import {
  SecOpsRuntime,
  type RuntimeDirectory,
  type SignInDiagnostic,
} from './runtime/secops-runtime.js';
import {
  createWazuhEventProvider,
  createWazuhEventsReader,
  createWazuhIngestion,
  OFFICE365_SUBSCRIPTIONS,
  PROVIDER_STREAMS,
  WAZUH_DATASET,
} from './runtime/wazuh-ingestion.js';
import { createWazuhPushInboxPass } from './runtime/wazuh-push-inbox.js';
import {
  EntraClientCredentialsTokenSource,
  StaticGatewayTokenSource,
} from './runtime/workload-token.js';
import {
  createRoleGrantResolver,
  isRoleRosterFresh,
  withDynamicGrants,
} from './runtime/role-grants.js';
import {
  directoryOwnerSource,
  createDirectorySyncPass,
  lazyOwnerSource,
} from './runtime/directory-sync.js';
import { DirectoryGroupActivation } from './runtime/directory-activation.js';
import { GraphDirectoryReader } from './runtime/graph-directory.js';
import { directoryRecipients } from './runtime/notification-recipients.js';
import { GraphMailFallbackChannel } from './runtime/email-fallback.js';
import { ephemeralVapidKey, VapidPushSender, vapidKeyFrom } from './runtime/web-push.js';
import { InMemoryPushSubscriptionStore, type PushSubscriptionStore } from '@qapaq/soar';
import { NotificationDispatcher } from './runtime/notification-dispatcher.js';
import {
  InMemoryDirectoryStore,
  InMemoryRoleAdministration,
  type DirectoryStore,
  type RoleAdministration,
} from '@qapaq/access';
import { clearRemovedMembers } from './runtime/role-administration.js';
import { correlatorUrl } from './runtime/correlator-link.js';
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
  readonly notifications: AttemptStore & {
    close(): Promise<void>;
    readonly channels: ChannelStore;
  };
  readonly sessions: SessionStore & { close(): Promise<void> };
  readonly directory: DirectoryStore & { close(): Promise<void> };
  readonly push: PushSubscriptionStore & { close(): Promise<void> };
  readonly roleAdministration: RoleAdministration & { close(): Promise<void> };
  readonly wazuhPushInbox?: WazuhPushInboxStore & { close(): Promise<void> };
}

/**
 * Crea los adapters durables: estado SOC (con la cola del outbox) y, en el mismo modo, los
 * intentos de notificación de C-20. Van juntos a propósito: una cola durable con intentos en
 * memoria podría reenviar un crítico ya entregado después de un reinicio.
 *
 * Se importan de forma diferida: un runtime en memoria (specs, desarrollo) no carga Prisma
 * ni el driver de PostgreSQL.
 */
async function durableStoresFor(
  config: SocPersistenceConfig,
  enableWazuhPushInbox: boolean,
): Promise<DurableStores | undefined> {
  if (config.mode === 'memory') return undefined;
  const [
    { PostgresSocPersistence, PostgresWazuhPushInboxStore },
    { PostgresNotificationAttemptStore, PostgresPushSubscriptionStore },
    { PostgresSessionStore, PostgresDirectoryStore, PostgresRoleAdministration },
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
  // Grants y solicitudes de rol: una lectura por inicio de sesión y pocos cambios. Sus escrituras
  // comparten transacción y cadena de auditoría con el SOC (`audit_events`).
  const roleAdministration = PostgresRoleAdministration.connect({
    connectionString,
    connectionTimeoutMs: postgres.connectionTimeoutMs,
    statementTimeoutMs: postgres.statementTimeoutMs,
    maxConnections: 2,
  });
  const wazuhPushInbox = enableWazuhPushInbox
    ? PostgresWazuhPushInboxStore.connect({
        connectionString,
        connectionTimeoutMs: postgres.connectionTimeoutMs,
        statementTimeoutMs: postgres.statementTimeoutMs,
        maxConnections: 2,
      })
    : undefined;
  try {
    // Falla al arrancar, no en la primera alerta: sin base o con esquema viejo no se sirve.
    await soc.ready();
    await wazuhPushInbox?.ready();
  } catch (error) {
    await Promise.allSettled([
      soc.close(),
      notifications.close(),
      sessions.close(),
      directory.close(),
      push.close(),
      roleAdministration.close(),
      ...(wazuhPushInbox ? [wazuhPushInbox.close()] : []),
    ]);
    throw error;
  }
  return {
    soc,
    notifications,
    sessions,
    directory,
    push,
    roleAdministration,
    ...(wazuhPushInbox ? { wazuhPushInbox } : {}),
  };
}

export async function buildApi(
  unresolvedEnvironment: EnvironmentInput,
  emit: ApiEvent,
  /** Fallos del bucle de despacho; el entrypoint los registra sin datos del mensaje. */
  onDispatchError?: (error: unknown) => void,
  /** Métricas del proceso; solo el entrypoint puede leer `process`. */
  processInfo?: () => ProcessInfo,
  /** Fallos de la ingesta de fuentes; el entrypoint los registra solo con su código. */
  onIngestionError?: (error: unknown) => void,
  /** Fallos del padrón (resolución del grupo y sincronización); solo con su código. */
  onDirectoryError?: (error: unknown) => void,
  /** Excepción demo con vencimiento, leída por el entrypoint en el límite del proceso. */
  demoMfaExceptionUntil?: Date,
  /** Inicios de sesión rechazados: etapa y código técnico, sin datos de la cuenta. */
  onSignInDenied?: (diagnostic: SignInDiagnostic) => void,
  /** Eventos del Analista IA: códigos, etapas e ids; nunca prompts ni evidencia. */
  onAnalystEvent?: AnalystLog,
) {
  const environment = await resolveApiSecretEnvironment(unresolvedEnvironment);
  const config = loadApiConfig(environment);
  const access = loadAccessConfig(environment);
  // Excepción demo de contraseña del administrador (temporal, apagada por defecto). El arranque
  // falla si el perfil no la admite, si vence a más de 30 días o si el hash no es un scrypt
  // válido. El texto del hash solo vive en el entorno resuelto y en este constructor.
  const demoAdminConfig = loadDemoAdminLoginConfig(environment, new Date());
  const demoAdminLogin = demoAdminConfig.enabled
    ? new DemoAdminLogin({
        username: demoAdminConfig.username,
        passwordHash: demoAdminConfig.passwordHash.reveal(),
        until: demoAdminConfig.until,
        issuer: 'urn:qapaq:demo-admin-password',
        audience: access.clientId,
        tenantId: access.tenantId,
        profile: config.profile,
        // Cuentas demo adicionales (QAPAQ_DEMO_ACCOUNTS): mismas reglas, un rol cada una.
        accounts: demoAdminConfig.accounts.map((account) => ({
          username: account.username,
          role: account.role,
          passwordHash: account.passwordHash.reveal(),
        })),
      })
    : undefined;
  const detection = loadDetectionContextConfig(environment);
  const persistenceConfig = loadSocPersistenceConfig(environment);
  const entityRefKey = loadEntityRefKey(environment);
  const entityRefSecret = entityRefKey?.reveal();
  const ingestionConfig = loadIngestionConfig(environment);
  if (
    ingestionConfig.source === 'wazuh' &&
    ingestionConfig.pushSecret &&
    persistenceConfig.mode !== 'postgres'
  ) {
    throw new Error('WAZUH_PUSH_REQUIRES_POSTGRES');
  }
  const roleGrants = loadRoleGrantsConfig(environment);
  const directoryConfig = loadDirectoryConfig(environment);
  const directoryIntervalMs =
    directoryConfig.mode === 'graph' ? directoryConfig.intervalMs : undefined;
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
  // Sprint 5 · fases 0 y 1: con `entra`, la ingesta necesita el client secret para el token de
  // workload; `wazuh` sin secreto es un error de despliegue y no arranca. Con `static-token`
  // (un solo nodo sin Entra) el bearer ya viene validado por la configuración.
  if (
    ingestionConfig.source === 'wazuh' &&
    ingestionConfig.gatewayAuth === 'entra' &&
    !clientSecret
  ) {
    throw new Error('INGESTION_CLIENT_SECRET_MISSING');
  }
  const eventProvider =
    ingestionConfig.source !== 'wazuh'
      ? undefined
      : ingestionConfig.gatewayAuth === 'static-token'
        ? createWazuhEventProvider({
            sourceId: ingestionConfig.sourceId,
            gatewayBaseUrl: ingestionConfig.gatewayBaseUrl,
            accessToken: new StaticGatewayTokenSource(ingestionConfig.gatewayAccessToken).token,
            tlsOrLoopbackOnly: true,
          })
        : clientSecret
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
  const directoryTokens = directoryConfig.mode === 'graph' && clientSecret
    ? new EntraClientCredentialsTokenSource({
        tenantId: access.tenantId,
        clientId: access.clientId,
        clientSecret,
        scope: 'https://graph.microsoft.com/.default',
      }) : undefined;
  const directoryReader = directoryTokens
    ? new GraphDirectoryReader({
        accessToken: directoryTokens.token,
        refreshRejectedToken: directoryTokens.refreshRejected,
      }) : undefined;
  // Si el nombre no se resuelve al arrancar (sin consentimiento, red), se reintenta en segundo
  // plano con espera exponencial y el padrón se activa solo al resolverse, sin reiniciar.
  // El ciclo de sincronización existe después; al resolverse el grupo se le pide una pasada.
  let kickDirectorySync: () => void = () => undefined;
  const activation =
    directoryConfig.mode === 'graph' && directoryReader
      ? new DirectoryGroupActivation({
          ...(directoryConfig.groupId ? { groupId: directoryConfig.groupId } : {}),
          ...(directoryConfig.groupName ? { groupName: directoryConfig.groupName } : {}),
          resolve: (name) => directoryReader.resolveGroupId(name),
          onResolved: () => kickDirectorySync(),
          onError: onDirectoryError ?? (() => undefined),
        })
      : undefined;
  await activation?.attempt();
  const durable = await durableStoresFor(
    persistenceConfig,
    ingestionConfig.source === 'wazuh' && ingestionConfig.pushSecret !== undefined,
  );
  // Avisos: política de ruido, canales administrables y correo (si hay buzón y secreto).
  const notificationPolicy = notificationPolicyFrom(loadNotificationPolicy(environment));
  const graphMail =
    alertMailSender && clientSecret
      ? (next: ConstructorParameters<typeof GraphMailFallbackChannel>[0]['next']) =>
          new GraphMailFallbackChannel({
            sender: alertMailSender,
            accessToken: new EntraClientCredentialsTokenSource({
              tenantId: access.tenantId,
              clientId: access.clientId,
              clientSecret,
              scope: 'https://graph.microsoft.com/.default',
            }).token,
            next,
            ...(onDispatchError ? { onError: (code) => onDispatchError(new Error(code)) } : {}),
          })
      : undefined;
  const channels = new NotificationChannelRegistry({
    tenantId: access.tenantId,
    store: durable?.notifications.channels ?? new InMemoryChannelStore(),
    ...(entityRefSecret ? { key: deriveChannelKey(entityRefSecret) } : {}),
    ...(teamsWorkflowUrl ? { environmentTeamsUrl: teamsWorkflowUrl } : {}),
    emailConfigured: graphMail !== undefined,
    pushConfigured: vapidKey !== undefined,
    clock: () => new Date(),
    ...(onDispatchError ? { onError: (code) => onDispatchError(new Error(code)) } : {}),
  });
  await channels.refresh();
  const directoryStore: DirectoryStore = durable?.directory ?? new InMemoryDirectoryStore();
  // Los grants dinámicos exigen padrón: sin él no hay cómo validar miembro ni cuenta habilitada,
  // así que ni se asignan ni cuentan al iniciar sesión. El grupo puede resolverse más tarde.
  const rosterGroupId = (): string | undefined => activation?.groupId;
  // En memoria, la unidad de trabajo se apoya en la del SOC en memoria del runtime, dueña de la
  // cadena de auditoría; `runtime` solo se usa al ejecutar, cuando ya existe.
  const memoryAdministration = () =>
    new InMemoryRoleAdministration((work) => runtime.soc.run((context) => work(context.audit)));
  let roleAdministration: RoleAdministration | undefined;
  if (activation) roleAdministration = durable?.roleAdministration ?? memoryAdministration();
  const ownerSource = activation
    ? lazyOwnerSource(
        () => activation.groupId,
        (groupId) =>
          directoryOwnerSource(directoryStore, access.tenantId, groupId, () =>
            directoryReader!.readOwners(groupId),
          ),
      )
    : undefined;
  const staticRoleGrants = createRoleGrantResolver(roleGrants, ownerSource);
  // La URL del Teams Workflow es un secreto y se resuelve por `SecretProvider`, no por
  // entorno. Mientras ese provider no esté disponible, el transporte queda sin destino
  // alcanzable y el crítico sale por el fallback de C-20, que es el comportamiento
  // declarado para esta condición.
  const runtime: SecOpsRuntime = new SecOpsRuntime({
    access,
    ...(demoMfaExceptionUntil ? { demoMfaExceptionUntil } : {}),
    ...(demoAdminLogin ? { demoAdminLogin } : {}),
    profile: config.profile,
    detectionContext: detectionContextFrom(detection),
    ...(entityRefSecret
      ? {
          entityRefs: entityRefFactory(entityRefSecret),
          csrfKey: deriveCsrfKey(entityRefSecret),
        }
      : {}),
    ...(durable
      ? { soc: durable.soc, notifications: durable.notifications, sessions: durable.sessions }
      : {}),
    ...(durable?.wazuhPushInbox ? { wazuhPushInbox: durable.wazuhPushInbox } : {}),
    ...(onDispatchError ? { onDispatchError } : {}),
    ...(onSignInDenied ? { onSignInDenied } : {}),
    ...(processInfo ? { processInfo } : {}),
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    ...(ingestionConfig.source === 'wazuh' && ingestionConfig.pushSecret
      ? { wazuhPushSecret: ingestionConfig.pushSecret.reveal() }
      : {}),
    ...(environment['QAPAQ_CORRELATOR_SERVICE_TOKEN']
      ? { correlatorServiceToken: environment['QAPAQ_CORRELATOR_SERVICE_TOKEN'] }
      : {}),
    ...(environment['QAPAQ_CORRELATOR_URL'] && environment['QAPAQ_CORRELATOR_READ_TOKEN']
      ? {
          correlatorRead: {
            baseUrl: correlatorUrl(environment['QAPAQ_CORRELATOR_URL']),
            token: environment['QAPAQ_CORRELATOR_READ_TOKEN'],
          },
        }
      : {}),
    roleGrants:
      roleAdministration && activation && directoryIntervalMs !== undefined
        ? withDynamicGrants(staticRoleGrants, {
            store: roleAdministration.grants,
            tenantId: access.tenantId,
            isRosterFresh: async () => {
              const groupId = rosterGroupId();
              return (
                groupId !== undefined &&
                isRoleRosterFresh(
                  await directoryStore.syncState(access.tenantId, groupId),
                  runtime.now(),
                  directoryIntervalMs,
                )
              );
            },
            isActiveMember: async (oid) => {
              const groupId = rosterGroupId();
              if (groupId === undefined) return false;
              const member = await directoryStore.member(access.tenantId, groupId, oid);
              return member?.membership === 'member' && member.accountEnabled === true;
            },
          })
        : staticRoleGrants,
    roleGrantsConfig: roleGrants,
    ...(roleAdministration ? { roleAdministration } : {}),
    ...(teamsWorkflowUrl ? { teamsWorkflowUrl } : {}),
    // Respaldo: si Teams no confirma, correo a los mismos destinatarios; si no, la consola.
    // El canal de correo se puede apagar desde la consola: entonces el respaldo es la consola.
    ...(graphMail
      ? {
          fallbackChain: (consoleFallback) =>
            channels.fallback(graphMail(consoleFallback), consoleFallback),
          mail: channels.mail(graphMail(new ConsoleFallbackChannel())),
        }
      : {}),
    channels,
    notificationPolicy,
    notificationEnricher: notificationEnricher({
      alertById: (tenantId, alertId) => runtime.soc.alertById(tenantId, alertId),
      knowledge: SOC_KNOWLEDGE,
      // Contexto de riesgo del correlador para «Por qué importa»; sin correlador, no aporta.
      entityRisk: entityRiskLookup({
        link:
          environment['QAPAQ_CORRELATOR_URL'] && environment['QAPAQ_CORRELATOR_READ_TOKEN']
            ? {
                baseUrl: correlatorUrl(environment['QAPAQ_CORRELATOR_URL']),
                token: environment['QAPAQ_CORRELATOR_READ_TOKEN'],
              }
            : undefined,
      }),
    }),
    // Destinatarios por rol desde el padrón. Las funciones leen el runtime al despachar, que
    // siempre ocurre después de construirlo.
    recipients: directoryRecipients({
      directory: () => runtime.directory,
      sessions: () => runtime.sessions,
      grants: roleGrants,
      now: () => runtime.now(),
    }),
    directory:
      activation && directoryConfig.mode === 'graph'
        ? (): RuntimeDirectory => {
            const state = activation.state;
            return state.groupId
              ? {
                  mode: 'graph',
                  groupId: state.groupId,
                  intervalMs: directoryConfig.intervalMs,
                  store: directoryStore,
                }
              : {
                  mode: 'pending',
                  intervalMs: directoryConfig.intervalMs,
                  lastErrorCode: state.lastErrorCode,
                  diagnostic: state.diagnostic,
                  lastAttemptAt: state.lastAttemptAt,
                  nextAttemptAt: state.nextAttemptAt,
                };
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
            now: () => runtime.now(),
          }),
        }
      : {}),
  });
  // Inicialización de canales: una fila por canal que aún no la tenga (`system:bootstrap`,
  // auditada). Idempotente; una fila existente no se toca (la base manda sobre el entorno).
  const channelInitialization = await channels.initialize({ audit: runtime.audit });
  // Qapaqzito (asistente de IA): solo existe con QAPAQ_QAPAQZITO_ENABLED=true; sin él, el endpoint no responde.
  // Su historial va a PostgreSQL cuando el SOC es durable (pool propio y mínimo); si no, a memoria.
  const assistantDatabase =
    persistenceConfig.mode === 'postgres'
      ? {
          connectionString: connectionStringFor(persistenceConfig),
          connectionTimeoutMs: persistenceConfig.postgres.connectionTimeoutMs,
          statementTimeoutMs: persistenceConfig.postgres.statementTimeoutMs,
          maxConnections: 2,
        }
      : undefined;
  const assistantConversations = await assistantConversationStoreFor(
    environment,
    assistantDatabase,
  );
  // Archivos de los informes de Qapaqzito (24 h): mismo criterio de almacén; purga periódica.
  const assistantArtifacts = await assistantArtifactStoreFor(environment, assistantDatabase);
  runtime.assistant = createAssistantService(
    environment,
    undefined,
    assistantConversations,
    assistantArtifacts,
  );
  const stopArtifactPurge = runtime.assistant?.artifacts
    ? startArtifactPurge(runtime.assistant.artifacts)
    : undefined;
  // Analista IA (docs/27): la consola siempre ve lista, ajustes y presupuesto; el bucle solo corre
  // con QAPAQ_ANALYST_ENABLED=true. Pool propio y mínimo en PostgreSQL; memoria en otro caso.
  const analyst = await composeAnalyst({
    environment,
    runtime,
    ...(persistenceConfig.mode === 'postgres'
      ? {
          connection: {
            connectionString: connectionStringFor(persistenceConfig),
            connectionTimeoutMs: persistenceConfig.postgres.connectionTimeoutMs,
            statementTimeoutMs: persistenceConfig.postgres.statementTimeoutMs,
            maxConnections: 2,
          },
        }
      : {}),
    ...(onAnalystEvent ? { log: onAnalystEvent } : {}),
  });
  runtime.analyst = analyst.host;
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
                expectedStreams: [...OFFICE365_SUBSCRIPTIONS, ...PROVIDER_STREAMS],
                now: runtime.now(),
              }).catch(() => false);
            }
          },
        })
      : undefined;
  runtime.setWazuhIngestionWakeup(ingestion ? () => ingestion.kick() : undefined);
  if (durable?.wazuhPushInbox && eventProvider && ingestionConfig.source === 'wazuh') {
    runtime.setWazuhPushInboxProcessor(
      createWazuhPushInboxPass({
        store: durable.wazuhPushInbox,
        provider: eventProvider,
        tenantId: access.tenantId,
        sourceId: ingestionConfig.sourceId,
        now: () => runtime.now(),
        promote: (event) => runtime.promoteEvent(event),
      }),
    );
  }
  // Sprint 5 · fase 3: sincronización del padrón por Microsoft Graph (token de aplicación).
  // La pasada se construye al resolverse el grupo; hasta entonces el ciclo no hace nada.
  let directorySyncPass:
    { readonly groupId: string; readonly drain: () => Promise<number> } | undefined;
  const directorySyncPassFor = (groupId: string, reader: GraphDirectoryReader) =>
    createDirectorySyncPass({
      tenantId: access.tenantId,
      groupId,
      store: directoryStore,
      now: () => runtime.now(),
      // Quien sale del grupo o deja de ser dueño pierde sus sesiones abiertas. Un dueño
      // que sigue declarado en el deploy conserva el admin y no se toca.
      // La baja también retira sus grants dinámicos y cancela sus solicitudes abiertas: si
      // vuelve al grupo, no recupera nada sin una solicitud y aprobación nuevas.
      reconcileAccess: async ({ removedMembers, formerOwners }) => {
        await runtime.revokeSessionsByOid(removedMembers, 'membership_removed');
        await runtime.revokeSessionsByOid(
          formerOwners.filter((oid) => !roleGrants.groupOwnerOids.includes(oid)),
          'ownership_removed',
        );
        if (roleAdministration) {
          await clearRemovedMembers(
            {
              administration: roleAdministration,
              tenantId: access.tenantId,
              now: () => runtime.now(),
            },
            removedMembers,
          );
        }
      },
      reader,
    });
  const directorySync =
    activation && directoryReader && directoryConfig.mode === 'graph'
      ? new NotificationDispatcher({
          drain: async () => {
            const groupId = activation.groupId;
            if (!groupId) return 0;
            if (directorySyncPass?.groupId !== groupId) {
              directorySyncPass = {
                groupId,
                drain: directorySyncPassFor(groupId, directoryReader),
              };
            }
            return directorySyncPass.drain();
          },
          intervalMs: directoryConfig.intervalMs,
          onError: onDirectoryError ?? (() => undefined),
        })
      : undefined;
  kickDirectorySync = () => directorySync?.kick();
  const application = await composeApi(config, lifecycle, runtime);
  // Qapaqzito lee el SOC por esta misma API (inject de Fastify, sin red) con la sesión de la persona.
  runtime.internalServer = application.getHttpAdapter().getInstance() as unknown as InjectingServer;
  let listening: Promise<unknown> | undefined;
  const stop = () =>
    lifecycle.shutdown(async () => {
      // Si llega una señal durante el arranque, esperar antes de cerrar evita dejar un servidor abierto.
      if (listening) await Promise.allSettled([listening]);
      // Primero se detiene el despacho: espera la pasada en curso para no dejar leases
      // tomados por un proceso que ya no existe.
      await ingestion?.stop();
      await activation?.stop();
      await directorySync?.stop();
      // El analista se drena antes que el despacho: sus acciones pueden encolar avisos.
      await analyst.host?.stop();
      await runtime.stopDispatcher();
      await application.close();
      await runtime.soc.close();
      await durable?.notifications.close();
      await durable?.sessions.close();
      await durable?.directory.close();
      await durable?.push.close();
      await durable?.roleAdministration.close();
      await durable?.wazuhPushInbox?.close();
      stopArtifactPurge?.();
      await assistantConversations?.close();
      await assistantArtifacts?.close();
      await analyst.close();
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
    /** Estado de cada canal de aviso al arrancar (sin secretos), para el registro de arranque. */
    notificationChannels: channels.views().map((view) => {
      const seed = channelInitialization.seeded.find((item) => item.channelId === view.id);
      return {
        channel: view.id,
        status: view.status,
        setup: view.setup,
        enabled: view.enabled,
        configured: view.configured,
        source: view.source,
        revision: view.revision,
        initialized: seed
          ? 'seeded'
          : channelInitialization.failed.includes(view.id)
            ? 'failed'
            : 'existing',
        secretSkipped: seed?.secretSkipped ?? null,
      };
    }),
    /** Vencimiento de la excepción demo de contraseña, para la advertencia del arranque. */
    demoAdminLoginUntil: demoAdminLogin?.until,
    /** Despliegue que justificó la excepción (`entra` = convivencia con Entra real). */
    demoAdminLoginDeployment: demoAdminConfig.enabled ? demoAdminConfig.deployment : undefined,
    /** Cuentas demo adicionales (sin el administrador), para la advertencia del arranque. */
    demoAccountCount: Math.max(0, (demoAdminLogin?.accounts.length ?? 1) - 1),
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
          analyst.host?.start();
          ingestion?.start();
          directorySync?.start();
          activation?.start();
        }
      } catch (error) {
        lifecycle.fail();
        await stop();
        throw error;
      }
    },
  };
}
