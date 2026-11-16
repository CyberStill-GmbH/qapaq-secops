/**
 * Composición del BFF: C-16, C-17, C-18, C-19, C-20 y C-25 en un solo objeto de runtime.
 *
 * El estado SOC (candidatos, alertas, incidentes, auditoría y outbox) vive detrás de
 * `SocPersistence`. El composition root elige el adapter: PostgreSQL donde el estado debe
 * sobrevivir a un reinicio, memoria para specs y desarrollo. Los controladores solo ven
 * el puerto, así que el cambio de adapter no los toca.
 *
 * El despacho de C-20 consume directamente la cola durable del outbox SOC (claim con
 * lease) y guarda sus intentos en el `AttemptStore` inyectado; con PostgreSQL ambos
 * sobreviven a un reinicio. Un bucle (`NotificationDispatcher`) despacha sin intervención.
 *
 * Siguen en memoria, y así lo declara la matriz de C-22: sesiones, handshakes OIDC y
 * contadores de lockout/rate limit. Un reinicio cierra sesiones, pero no borra alertas,
 * veredictos, incidentes, auditoría ni notificaciones pendientes.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  beginAuthorization,
  constantTimeEquals,
  capabilitiesForRoles,
  decideSignIn,
  effectiveCapabilities,
  emptyCounter,
  evaluateLockout,
  evaluateNetwork,
  evaluateSession,
  consumeRateLimit,
  HANDSHAKE_LIMITS,
  InMemoryAttemptStore,
  InMemoryHandshakeStore,
  InMemoryRateLimitStore,
  InMemorySessionStore,
  openSession,
  policyForNetwork,
  registerFailure,
  registerSuccess,
  resolveCallback,
  revokeSession,
  validateIdToken,
  type Actor,
  type Capability,
  type JwksProvider,
  type NetworkPolicy,
  type RequestOrigin,
  type Session,
  type SessionStore,
  type SignInDenialReason,
  type TokenExchange,
} from '@qapaq/access';
import { recordAudit, type AuditEventDraft, type AuditStore } from '@qapaq/audit';
import type { AccessConfig } from '@qapaq/configuration';
import {
  correlate,
  correlationHorizon,
  decidePromotion,
  DEFAULT_CORRELATION_POLICY,
  entityKeysOf,
  PRIORITIZATION_RULESET_ID,
  PRIORITIZATION_RULESET_VERSION,
  promotionKey,
  type CorrelationPolicy,
  type PrioritizationContext,
  type SignalCatalog,
} from '@qapaq/detection';
import {
  InMemorySoc,
  ingestCandidate,
  type EntityRefFactory,
  type OutboxLane,
  type SocDependencies,
  type SocPersistence,
  type WazuhPushHint,
  type WazuhPushInboxStore,
} from '@qapaq/soc';
import {
  ConsoleFallbackChannel,
  drainOutbox,
  InMemoryAttemptStore as InMemoryNotificationStore,
  RETRY_POLICY,
  TeamsWorkflowTransport,
  type AttemptStore,
  type DispatchDependencies,
  type NotificationTransport,
  type OutboxReader,
} from '@qapaq/soar';
import type { SecurityEvent } from '@qapaq/contracts';

import {
  EntraJwksProvider,
  EntraTokenExchange,
  LocalJwksProvider,
  LocalTokenExchange,
} from '../access/identity-provider.js';
import { LocalDevelopmentIssuer, LOCAL_PRINCIPALS } from '../access/local-issuer.js';
import {
  DEMO_ADMIN_SESSION_MAX_MS,
  DemoAdminJwksProvider,
  DemoAdminTokenExchange,
  isDemoAdminSubject,
  type DemoAccount,
  type DemoAdminLogin,
} from '../access/demo-admin-credentials.js';
import type { AssistantService } from '../assistant/assistant-service.js';
import { rolesFromIdToken } from './role-grants.js';
import type { AnalystHost } from './analyst-host.js';
import type { InjectingServer } from '../assistant/internal-client.js';
import { csrfTokenFor } from '../http/csrf.js';
import { DEFAULT_RETURN_TO } from '../http/return-to.js';
import type { ProcessInfo } from '../soc/operations-health.js';
import type { EventsReader } from './events-reader.js';
import type { SourceHealthMonitor } from './source-health.js';
import type { RoleGrantsConfig } from '@qapaq/configuration';
import type { DirectoryDiagnostic, DirectoryStore, RoleAdministration } from '@qapaq/access';
import {
  notifyDevices,
  type FallbackChannel,
  type PushSender,
  type PushSubscriptionStore,
  type RecipientDirectory,
} from '@qapaq/soar';

/** Padrón disponible para la administración. */
export type RuntimeDirectory =
  | { readonly mode: 'disabled' }
  /**
   * Padrón por Graph configurado pero grupo aún sin resolver (p. ej. falta el permiso
   * `GroupMember.Read.All`). Se reintenta solo; la consola muestra el motivo.
   */
  | {
      readonly mode: 'pending';
      readonly intervalMs: number;
      readonly lastErrorCode: string | null;
      readonly diagnostic: DirectoryDiagnostic | null;
      readonly lastAttemptAt: Date | null;
      readonly nextAttemptAt: Date | null;
    }
  | {
      readonly mode: 'graph';
      readonly groupId: string;
      readonly intervalMs: number;
      readonly store: DirectoryStore;
    };
import { NotificationDispatcher } from './notification-dispatcher.js';
import type { NotificationChannelRegistry } from './notification-channels.js';
import {
  runAnalystDigest,
  runLowPriorityDigest,
  runSuppressedDigest,
  type AnalystDigestInput,
  type MailChannel,
  type NotificationEnricher,
  type NotificationPolicyConfig,
} from '@qapaq/soar';
import { CONNECTED_SOURCE_SIGNAL_CATALOG } from './signal-catalog.js';

/**
 * Diagnóstico de un inicio de sesión rechazado. Solo códigos: ni tokens, ni claims, ni texto
 * del proveedor. `stage` dice dónde se cortó y `code` el motivo técnico (p. ej. el AADSTS del
 * intercambio o la validación del ID token que falló).
 */
/** Identificadores del handshake interno de un acceso con contraseña (para limpiar su cookie). */
export interface PasswordFlow {
  readonly state: string;
  readonly browserBinding: string;
  readonly returnTo: string;
}

export interface SignInDiagnostic {
  readonly reason: SignInDenialReason;
  readonly stage:
    'rate_limit' | 'callback' | 'network' | 'token_exchange' | 'jwks' | 'decision' | 'password';
  readonly code?: string;
  readonly correlationId: string;
}

const DIAGNOSTIC_CODE = /^[A-Za-z0-9_.,-]{1,80}$/u;

function diagnosticCode(value: unknown): string | undefined {
  return typeof value === 'string' && DIAGNOSTIC_CODE.test(value) ? value : undefined;
}

/** Código técnico de un rechazo por decisión: qué faltó en el token o en los roles. */
function decisionDiagnostic(
  reason: SignInDenialReason,
  validation: ReturnType<typeof validateIdToken>,
): string {
  if (reason === 'LOCKED_OUT') return reason;
  if (!validation.ok) {
    return validation.code === 'AMR_NOT_ACCEPTED' && diagnosticCode(validation.detail)
      ? `AMR_NOT_ACCEPTED:${validation.detail}`
      : validation.code;
  }
  if (reason === 'MFA_REQUIRED' || reason === 'PASSKEY_REQUIRED') {
    return `amr:${(validation.claims.amr ?? []).join(',') || 'none'}`;
  }
  if (reason === 'NO_ROLE_ASSIGNED') {
    // Sin claim `groups`, la pertenencia al grupo admin solo puede salir del padrón de Graph.
    return `groups_claim:${validation.claims.groups === undefined ? 'absent' : 'present'}`;
  }
  return reason;
}

export interface RuntimeOptions {
  readonly access: AccessConfig;
  /** Clave CSRF compartida entre réplicas; solo efímera en perfiles de memoria/tests. */
  readonly csrfKey?: Buffer;
  readonly demoMfaExceptionUntil?: Date;
  /**
   * Excepción demo de contraseña del administrador (temporal). Solo existe si la configuración
   * la habilitó y validó; su vigencia la decide `activeAt` en cada intento y en cada request.
   */
  readonly demoAdminLogin?: DemoAdminLogin;
  readonly profile: string;
  readonly clientSecret?: string;
  /** Service credential for the private deterministic correlator; absent disables its API. */
  readonly correlatorServiceToken?: string;
  /**
   * Read link API → correlator (`/v1/*` on the private Docker network) for `/api/risk/*`.
   * Absent: the risk endpoints answer DEPENDENCY_DEGRADED.
   */
  readonly correlatorRead?: { readonly baseUrl: string; readonly token: string };
  readonly teamsWorkflowUrl?: string;
  readonly transport?: NotificationTransport;
  readonly clock?: () => Date;
  /** Adapter de estado SOC. Sin él, memoria: válido para specs y desarrollo. */
  readonly soc?: SocPersistence;
  /** Contexto de negocio de C-16 cargado desde configuración. */
  readonly detectionContext?: PrioritizationContext;
  readonly correlationPolicy?: CorrelationPolicy;
  /** Catálogo acción → señal de las fuentes conectadas; por defecto, el del MVP. */
  readonly signalCatalog?: SignalCatalog;
  /** Referencias opacas de entidad (D-10b). Sin ella, las alertas no se pueden pivotar. */
  readonly entityRefs?: EntityRefFactory;
  /** Sesiones del BFF (C-18). Sin él, memoria: un reinicio cierra todas las sesiones. */
  readonly sessions?: SessionStore;
  /** Intentos de notificación de C-20. Sin él, memoria. */
  readonly notifications?: AttemptStore;
  /** Intervalo del bucle de despacho; el bucle solo corre tras `startDispatcher()`. */
  readonly dispatchIntervalMs?: number;
  /** Reporte de fallos del bucle de despacho, sin datos del mensaje. */
  readonly onDispatchError?: (error: unknown) => void;
  /** Motivo técnico de cada inicio de sesión rechazado, para el log del proceso. */
  readonly onSignInDenied?: (diagnostic: SignInDiagnostic) => void;
  /** Métricas del proceso; las inyecta el entrypoint, único que puede leer `process`. */
  readonly processInfo?: () => ProcessInfo;
  /**
   * Roles concedidos por QAPAQ (asignaciones del deploy y dueños del grupo). Se suman a los
   * app roles del token; sin resolvedor, solo cuentan el token y la asignación temporal.
   */
  readonly roleGrants?: (
    oid: string | undefined,
    groups?: readonly string[],
  ) => Promise<readonly string[]>;
  /** Explorador de eventos (fase 1). Sin lector, la fuente de eventos está deshabilitada. */
  readonly events?: EventsReader;
  /** HMAC credential for Wazuh manager push wake-ups. Never serialized or logged. */
  readonly wazuhPushSecret?: string;
  /** PostgreSQL-backed accepted Wazuh hints; absent means push ingestion is disabled. */
  readonly wazuhPushInbox?: WazuhPushInboxStore;
  /** Fuente vigilada por la salud por fuente (fase 2); existe aunque esté deshabilitada. */
  readonly sourceHealth?: SourceHealthMonitor;
  /** Padrón del grupo de admisión (fase 3); sin él, la sincronización está deshabilitada. */
  /** Una función si el padrón puede activarse después del arranque (grupo resuelto tarde). */
  readonly directory?: RuntimeDirectory | (() => RuntimeDirectory);
  /** Roles concedidos por el deploy, para explicar el origen de cada rol en la administración. */
  readonly roleGrantsConfig?: RoleGrantsConfig;
  /**
   * Administración de roles: grants dinámicos y solicitudes, con la unidad de trabajo que los
   * confirma junto a su AuditEvent. Sin ella no se pueden pedir ni aprobar roles desde la consola;
   * para que los grants cuenten al iniciar sesión, el composition root los suma en `roleGrants`.
   */
  readonly roleAdministration?: RoleAdministration;
  /** Destinatarios de Teams por rol (Sprint 5); sin él, la tarjeta sale sin menciones. */
  readonly recipients?: RecipientDirectory;
  /**
   * Respaldo cuando Teams no confirma la entrega (Sprint 5: correo). Recibe la bandeja de la
   * consola como siguiente eslabón; sin él, el respaldo es solo la consola.
   */
  readonly fallbackChain?: (consoleFallback: FallbackChannel) => FallbackChannel;
  /** Canales administrables (Teams/correo/push); su transporte de Teams sustituye al fijo. */
  readonly channels?: NotificationChannelRegistry;
  /** Contexto explicativo de los avisos (alerta, catálogo, correlador). */
  readonly notificationEnricher?: NotificationEnricher;
  /** Copia por correo de P1/incidentes críticos y de los resúmenes. */
  readonly mail?: MailChannel;
  readonly notificationPolicy?: NotificationPolicyConfig;
  /** Avisos al dispositivo (Web Push, Sprint 5); sin él la consola los muestra deshabilitados. */
  readonly push?: { readonly store: PushSubscriptionStore; readonly sender: PushSender };
}

/** Tope de alertas que la correlación lee por evento; protege frente a entidades ruidosas. */
const CORRELATION_READ_LIMIT = 500;
/**
 * Lote que el despacho reclama por pasada. Los envíos del lote son secuenciales: el peor caso
 * de una pasada es `DISPATCH_BATCH × timeout del transporte` (5 × 10 s = 50 s).
 */
const DISPATCH_BATCH = 5;
/**
 * Lease del claim del outbox: al menos el doble del peor caso de una pasada, para que un
 * despachador sano nunca pierda su claim a mitad de lote. Si el proceso muere, el lease
 * vence, otro despachador reclama con un token nuevo (fencing) y el anterior ya no puede
 * cerrar el mensaje.
 */
const OUTBOX_LEASE_MS = Math.max(120_000, 2 * DISPATCH_BATCH * RETRY_POLICY.requestTimeoutMs);
const DEFAULT_DISPATCH_INTERVAL_MS = 5_000;
const DIGEST_INTERVAL_MS = 5 * 60_000;
/** Tope de alertas P3/P4 que lee un resumen (el total real viene aparte). */
const DIGEST_ALERT_LIMIT = 500;
/** Pasadas de revocación tras un cambio de roles; cada una relee las sesiones activas. */
const ROLE_CHANGE_REVOCATION_ATTEMPTS = 3;

/**
 * Scopes que el BFF, como cliente confidencial, siempre solicita. El recorte real lo
 * hace el rol de la persona: la intersección vive en `effectiveCapabilities`.
 */
export const BFF_SCOPES = ['soc.read', 'soc.write', 'audit.read'] as const;

export type SignInFailure = { readonly reason: SignInDenialReason; readonly message: string };

/**
 * Quién emitió el `id_token` que se valida. `directory` es Entra (o el emisor local de
 * desarrollo); `demo-admin` es el emisor en memoria de la excepción demo. Las claves, el emisor
 * esperado y el canje nunca se mezclan: un token de un emisor no valida contra el otro.
 */
type IdentitySource =
  | { readonly kind: 'directory' }
  | {
      readonly kind: 'demo-admin';
      readonly login: DemoAdminLogin;
      /** Cuenta demo cuya contraseña se verificó: fija el único `sub` y el único rol admitidos. */
      readonly account: DemoAccount;
    };

/** Motivos de auditoría de la excepción demo de contraseña (`access.sign_in`). */
const DEMO_ADMIN_AUDIT = Object.freeze({
  admitted: 'demo_admin_password_login',
  denied: 'demo_admin_denied',
});

export interface SignInSuccess {
  readonly session: Session;
  readonly supersededSessions: readonly string[];
}

export class SecOpsRuntime {
  public readonly handshakes = new InMemoryHandshakeStore();
  public readonly sessions: SessionStore;
  public readonly attempts = new InMemoryAttemptStore();
  public readonly rateLimits = new InMemoryRateLimitStore();
  public readonly soc: SocPersistence;
  public readonly notifications: AttemptStore;
  public readonly dispatcher: NotificationDispatcher;
  private readonly urgentDispatcher: NotificationDispatcher;
  public readonly wazuhPushSecret: string | undefined;
  private readonly wazuhPushInbox: WazuhPushInboxStore | undefined;
  private wazuhPushInboxDispatcher: NotificationDispatcher | undefined;
  private wazuhIngestionWakeup: (() => void) | undefined;
  private readonly digests: NotificationDispatcher;
  public readonly correlatorServiceToken: string | undefined;
  public readonly correlatorRead: { readonly baseUrl: string; readonly token: string } | undefined;
  /** Bandeja de la consola: último eslabón del respaldo, siempre presente. */
  public readonly consoleFallback = new ConsoleFallbackChannel();

  /** Cadena de respaldo efectiva: correo → consola, o solo consola. */
  public get fallback(): FallbackChannel {
    this.#fallback ??= this.options.fallbackChain
      ? this.options.fallbackChain(this.consoleFallback)
      : this.consoleFallback;
    return this.#fallback;
  }

  #fallback: FallbackChannel | undefined;
  public readonly localIssuer: LocalDevelopmentIssuer | undefined;
  /** Qapaqzito (asistente de IA); `undefined` si `QAPAQ_QAPAQZITO_ENABLED` no está activo. */
  public assistant: AssistantService | undefined;
  /**
   * Analista IA (docs/27): lista, ajustes y presupuesto siempre; bucle solo con
   * `QAPAQ_ANALYST_ENABLED=true`. `undefined` si su almacén no está disponible.
   */
  public analyst: AnalystHost | undefined;
  /** Servidor HTTP para las lecturas internas de Qapaqzito (lo asigna el arranque; ver bootstrap). */
  public internalServer: InjectingServer | undefined;
  public readonly networkPolicy: NetworkPolicy;
  private readonly jwks: JwksProvider;
  private readonly tokens: TokenExchange;
  /** Emisor de la excepción demo; ausentes si no está configurada. */
  private readonly demoJwks: JwksProvider | undefined;
  private readonly demoTokens: TokenExchange | undefined;
  private readonly transport: NotificationTransport;
  private readonly clock: () => Date;
  /** Clave estable entre réplicas cuando el BFF usa persistencia compartida. */
  private readonly csrfKey: Buffer;
  /**
   * Contexto de priorización de C-16. Viene de configuración (`QAPAQ_DETECTION_*`); sin
   * ella, listas vacías y la prioridad depende solo de severidad y correlación.
   */
  public detectionContext: PrioritizationContext;
  private readonly correlationPolicy: CorrelationPolicy;
  private readonly signalCatalog: SignalCatalog;

  public constructor(private readonly options: RuntimeOptions) {
    this.wazuhPushSecret = options.wazuhPushSecret;
    this.wazuhPushInbox = options.wazuhPushInbox;
    this.correlatorServiceToken = options.correlatorServiceToken;
    this.correlatorRead = options.correlatorRead;
    this.clock = options.clock ?? (() => new Date());
    this.csrfKey = options.csrfKey ?? randomBytes(32);
    this.soc = options.soc ?? new InMemorySoc();
    this.sessions = options.sessions ?? new InMemorySessionStore();
    this.notifications = options.notifications ?? new InMemoryNotificationStore();
    this.urgentDispatcher = new NotificationDispatcher({
      drain: async () =>
        (await drainOutbox(this.dispatchDependencies('urgent'), DISPATCH_BATCH, DISPATCH_BATCH))
          .length,
      intervalMs: options.dispatchIntervalMs ?? DEFAULT_DISPATCH_INTERVAL_MS,
      onError: options.onDispatchError ?? (() => undefined),
    });
    this.dispatcher = new NotificationDispatcher({
      drain: async () =>
        (await drainOutbox(this.dispatchDependencies('normal'), DISPATCH_BATCH, DISPATCH_BATCH))
          .length,
      intervalMs: options.dispatchIntervalMs ?? DEFAULT_DISPATCH_INTERVAL_MS,
      onError: options.onDispatchError ?? (() => undefined),
      onKick: () => this.urgentDispatcher.kick(),
    });
    // Resúmenes (suprimidas y P3/P4): una pasada cada 5 min, en el mismo proceso.
    this.digests = new NotificationDispatcher({
      drain: async () => {
        await this.runDigests();
        return 0;
      },
      intervalMs: DIGEST_INTERVAL_MS,
      onError: options.onDispatchError ?? (() => undefined),
    });
    this.detectionContext = options.detectionContext ?? {
      privilegedIdentities: new Set(),
      criticalAssets: new Set(),
    };
    this.correlationPolicy = options.correlationPolicy ?? DEFAULT_CORRELATION_POLICY;
    this.signalCatalog = options.signalCatalog ?? CONNECTED_SOURCE_SIGNAL_CATALOG;
    this.networkPolicy = {
      allowedCidrs: options.access.allowedCidrs,
      trustedProxyCidrs: options.access.trustedProxyCidrs,
    };
    if (options.access.identityMode === 'local-development') {
      this.localIssuer = new LocalDevelopmentIssuer({
        issuer: options.access.issuer,
        audience: options.access.clientId,
        tenantId: options.access.tenantId,
        profile: options.profile,
      });
      this.jwks = new LocalJwksProvider(this.localIssuer);
      this.tokens = new LocalTokenExchange(this.localIssuer, this.clock);
    } else {
      this.jwks = new EntraJwksProvider(options.access.jwksUri);
      this.tokens = new EntraTokenExchange({
        tokenEndpoint: options.access.tokenEndpoint,
        clientId: options.access.clientId,
        clientSecret: options.clientSecret ?? '',
        scopes: options.access.scopes,
      });
    }
    if (options.demoAdminLogin) {
      this.demoJwks = new DemoAdminJwksProvider(options.demoAdminLogin);
      this.demoTokens = new DemoAdminTokenExchange(options.demoAdminLogin, this.clock);
    }
    this.transport =
      options.transport ??
      options.channels?.teamsTransport ??
      new TeamsWorkflowTransport({
        workflowUrl: options.teamsWorkflowUrl ?? 'https://localhost/teams-not-configured',
        destinationRef: 'teams:canal-soc',
      });
  }

  /** Attach the source poller after composition for independent pull reconciliation. */
  public setWazuhIngestionWakeup(wakeup: (() => void) | undefined): void {
    this.wazuhIngestionWakeup = wakeup;
  }

  public wakeWazuhIngestion(): boolean {
    if (!this.wazuhPushSecret || !this.wazuhIngestionWakeup) return false;
    this.wazuhIngestionWakeup();
    return true;
  }

  /** Installs the durable hint consumer after the Indexer provider is composed. */
  public setWazuhPushInboxProcessor(drain: () => Promise<number>): void {
    if (!this.wazuhPushInbox) throw new Error('WAZUH_PUSH_INBOX_NOT_CONFIGURED');
    if (this.wazuhPushInboxDispatcher) throw new Error('WAZUH_PUSH_INBOX_PROCESSOR_ALREADY_SET');
    this.wazuhPushInboxDispatcher = new NotificationDispatcher({
      drain,
      intervalMs: 250,
      errorIntervalMs: 5_000,
      onError: this.options.onDispatchError ?? (() => undefined),
    });
  }

  public get canAcceptWazuhPush(): boolean {
    return Boolean(this.wazuhPushSecret && this.wazuhPushInbox && this.wazuhPushInboxDispatcher);
  }

  public async acceptWazuhPushHint(
    hint: WazuhPushHint,
  ): Promise<'inserted' | 'duplicate' | 'reopened-terminal'> {
    const inbox = this.wazuhPushInbox;
    const dispatcher = this.wazuhPushInboxDispatcher;
    if (!this.wazuhPushSecret || !inbox || !dispatcher) {
      throw new Error('WAZUH_PUSH_INBOX_NOT_CONFIGURED');
    }
    const accepted = await inbox.enqueue(hint);
    dispatcher.kick();
    // The durable worker handles the hinted event; this also advances the regular reconciler.
    this.wakeWazuhIngestion();
    return accepted;
  }

  public now(): Date {
    return this.clock();
  }

  /**
   * Cadena de auditoría única: la escriben los casos de uso SOC, el inicio de sesión y el
   * despacho, y la lee C-19. Se resuelve en cada acceso porque el adapter en memoria
   * reemplaza su store al deshacer una transacción.
   */
  public get audit(): AuditStore {
    return this.soc.audit;
  }

  /** La cookie solo se marca `Secure` donde el transporte lo es: si no, no viajaría. */
  public get secureCookies(): boolean {
    return this.options.profile === 'production';
  }

  public get directory(): RuntimeDirectory | undefined {
    const directory = this.options.directory;
    return typeof directory === 'function' ? directory() : directory;
  }

  public get roleGrantsConfig(): RoleGrantsConfig | undefined {
    return this.options.roleGrantsConfig;
  }

  public get roleAdministration(): RoleAdministration | undefined {
    return this.options.roleAdministration;
  }

  /** Tenant del padrón: el del app registration (instalación de un solo tenant). */
  public get tenantIdForDirectory(): string {
    return this.options.access.tenantId;
  }

  /** Fuente vigilada por la salud por fuente; `undefined` solo en specs que no la declaran. */
  public get sourceHealth(): SourceHealthMonitor | undefined {
    return this.options.sourceHealth;
  }

  public wazuhPushInboxMetrics(at = this.now()) {
    return this.wazuhPushInbox?.metrics(at) ?? Promise.resolve(null);
  }

  public get push(): RuntimeOptions['push'] {
    return this.options.push;
  }

  public get access(): AccessConfig {
    return this.options.access;
  }

  /** Lector del explorador de eventos; `undefined` si no hay fuente configurada. */
  public get events(): EventsReader | undefined {
    return this.options.events;
  }

  /** Vencimiento de la excepción demo de contraseña, si está configurada (para el log de arranque). */
  public get demoAdminLoginUntil(): Date | undefined {
    return this.options.demoAdminLogin?.until;
  }

  /** Una sesión de la cuenta sintética demo recibe una cookie más estricta (ver auth.controller). */
  public isDemoAdminSubject(subjectId: string): boolean {
    return isDemoAdminSubject(subjectId);
  }

  /**
   * Una sesión `demo-admin:*` solo vale mientras la excepción esté configurada, vigente y sea de
   * uno de sus sujetos configurados con exactamente el rol de esa cuenta. Cubre el vencimiento
   * sin reinicio, un reinicio con la excepción apagada o con la cuenta retirada o cambiada de rol
   * (sesiones durables en PostgreSQL).
   */
  private demoAdminSessionAllowed(subjectId: string, roles: readonly string[], now: Date): boolean {
    const login = this.options.demoAdminLogin;
    const account = login?.accountForSubject(subjectId);
    return (
      login !== undefined &&
      account !== undefined &&
      login.activeAt(now) &&
      roles.length === 1 &&
      roles[0] === account.role
    );
  }

  public get isLocalIdentity(): boolean {
    return this.options.access.identityMode === 'local-development';
  }

  public get redirectUri(): string {
    return this.options.access.redirectUri;
  }

  public get tenantId(): string {
    return this.options.access.tenantId;
  }

  public socDependencies(): SocDependencies {
    return {
      unitOfWork: this.soc,
      clock: { now: () => this.now() },
      ids: { next: () => randomUUID() },
      ...(this.options.entityRefs ? { entityRefs: this.options.entityRefs } : {}),
    };
  }

  /** Referencia opaca de una clave de entidad, o `undefined` sin factory configurada. */
  public entityRefOf(tenantId: string, entityKey: string): string | undefined {
    return this.options.entityRefs?.(tenantId, entityKey);
  }

  /**
   * Puerto `OutboxReader` de C-20 sobre la cola durable del SOC. No hay copia intermedia:
   * lo que el despacho no publicó sigue en la cola y vuelve a ser reclamable al vencer el
   * lease.
   */
  private outboxReader(lane: OutboxLane): OutboxReader {
    return {
      claimPending: async (limit, now) => {
        const claimed = await this.soc.claimOutbox(now, limit, OUTBOX_LEASE_MS, lane);
        for (const message of claimed) this.claimTokens.set(message.messageId, message.claimToken);
        return claimed;
      },
      // Sin token propio no hay nada que cerrar: el claim lo tiene otro despachador.
      markPublished: async (messageId, at) => {
        const token = this.claimTokens.get(messageId);
        this.claimTokens.delete(messageId);
        if (token) await this.soc.markOutboxPublished(messageId, token, at);
      },
      scheduleRetry: async (messageId, availableAt, errorCode) => {
        const token = this.claimTokens.get(messageId);
        this.claimTokens.delete(messageId);
        if (token) await this.soc.scheduleOutboxRetry(messageId, token, availableAt, errorCode);
      },
    };
  }

  /**
   * Tokens de los claims vivos de este proceso, por `messageId`. Es memoria de trabajo: si
   * el proceso muere, los claims vencen solos y otro despachador los toma con token nuevo.
   */
  private readonly claimTokens = new Map<string, string>();

  /** El canal push apagado desde la consola no avisa a ningún dispositivo. */
  private pushGate(
    inner: NonNullable<DispatchDependencies['devices']>,
  ): NonNullable<DispatchDependencies['devices']> {
    return this.options.channels ? this.options.channels.devices(inner) : inner;
  }

  public dispatchDependencies(lane: OutboxLane = 'all'): DispatchDependencies {
    return {
      outbox: this.outboxReader(lane),
      attempts: this.notifications,
      transport: this.transport,
      fallback: this.fallback,
      audit: this.soc.audit,
      clock: { now: () => this.now() },
      ids: { next: () => randomUUID() },
      consoleBaseUrl: this.options.access.consoleBaseUrl,
      ...(this.options.recipients ? { recipients: this.options.recipients } : {}),
      ...(this.options.notificationEnricher ? { enricher: this.options.notificationEnricher } : {}),
      ...(this.options.mail ? { mail: this.options.mail } : {}),
      ...(this.options.notificationPolicy ? { policy: this.options.notificationPolicy } : {}),
      ...(this.options.push
        ? {
            devices: this.pushGate({
              notify: (tenantId: string, subjectKeys: readonly string[]) =>
                notifyDevices({
                  store: this.options.push!.store,
                  sender: this.options.push!.sender,
                  tenantId,
                  subjectKeys,
                  now: () => this.now(),
                }),
            }),
          }
        : {}),
    };
  }

  /**
   * Puente C-16 → C-17: correlaciona, prioriza y materializa la alerta si corresponde.
   *
   * Orden deliberado:
   * 1. Idempotencia por evento: si ya hay alerta para este `recordId`, es `duplicate`
   *    aunque el ruleset haya cambiado de versión. Una alerta por evento es la regla del
   *    runtime; reevaluar con otra versión es un replay explícito, no un efecto lateral.
   * 2. Correlación sobre la ventana de alertas previas de las mismas entidades, excluida
   *    la propia alerta del evento si existiera.
   * 3. Priorización con contexto de negocio + correlación, y promoción.
   */
  public async promoteEvent(
    event: SecurityEvent,
  ): Promise<'promoted' | 'duplicate' | 'not_promoted' | 'below_threshold' | 'suppressed'> {
    const tenantId = event.tenant.id;
    const key = promotionKey(tenantId, event.recordId, PRIORITIZATION_RULESET_VERSION);
    const existingAlert = await this.soc.alertByEventRecordId(tenantId, event.recordId);
    const existing = existingAlert
      ? {
          id: existingAlert.id,
          tenantId: existingAlert.tenantId,
          eventRecordId: existingAlert.eventRecordId,
          eventUid: event.eventUid,
          idempotencyKey: key,
          priority: existingAlert.priority,
          score: existingAlert.score,
          reasons: existingAlert.reasons,
          rulesetId: PRIORITIZATION_RULESET_ID,
          rulesetVersion: PRIORITIZATION_RULESET_VERSION,
          occurredAt: existingAlert.occurredAt,
          createdAt: existingAlert.createdAt,
          title: existingAlert.title,
          entityKeys: existingAlert.entityKeys,
          signal: existingAlert.signal ?? 'other',
          ruleId: existingAlert.ruleId,
          relatedAlertIds: existingAlert.relatedAlertIds,
        }
      : undefined;
    const recent = existing
      ? []
      : await this.soc.recentByEntities(
          tenantId,
          entityKeysOf(event),
          correlationHorizon(event, this.correlationPolicy),
          CORRELATION_READ_LIMIT,
        );
    const correlation = correlate(event, recent, this.correlationPolicy, this.signalCatalog);
    const decision = decidePromotion(
      event,
      { ...this.detectionContext, correlation },
      existing,
      this.now(),
    );
    if (decision.outcome === 'duplicate') return 'duplicate';
    if (decision.outcome === 'not_promoted') {
      return decision.reasonCode === 'SUPPRESSED' ? 'suppressed' : 'below_threshold';
    }
    const ingested = await ingestCandidate(this.socDependencies(), decision.candidate);
    if (!ingested.ok) {
      // Do not let the pull cursor advance as if an alert/outbox row had been created.
      // The poller records a retryable error and the next pass replays this event.
      throw Object.assign(new Error('SOC_ALERT_INGESTION_FAILED'), {
        code: 'SOC_ALERT_INGESTION_FAILED',
        retryable: true,
      });
    }
    if (!ingested.value.created) return 'duplicate';
    this.dispatcher.kick();
    // Después del commit, nunca dentro de la transacción: un fallo del analista solo se registra.
    this.analyst?.alertCreated(ingested.value.alert);
    return 'promoted';
  }

  /** Referencia `h:<sha256>` de una sesión: la forma en que la administración la nombra. */
  /**
   * Sprint 5 · fase 3 — revoca las sesiones activas de personas que perdieron acceso por un cambio
   * en el padrón (baja del grupo o pérdida de la propiedad). Idempotente: sin sesiones activas no
   * hace nada, así puede correr en cada ciclo de sincronización. Cada revocación queda auditada
   * con el motivo; un conflicto de revisión (la sesión cambió en paralelo) se reintenta en el
   * ciclo siguiente.
   */
  public async revokeSessionsByOid(
    oids: readonly string[],
    reason: 'membership_removed' | 'ownership_removed',
  ): Promise<number> {
    let revoked = 0;
    for (const oid of new Set(oids.map((value) => value.toLowerCase()))) {
      revoked += await this.revokeActiveSessionsOf(
        oid,
        reason,
        { id: 'system:directory-sync', type: 'service' },
        randomUUID(),
      );
    }
    return revoked;
  }

  /**
   * Cambio de roles desde la administración: revoca las sesiones activas de la persona para que
   * ninguna siga con los roles anteriores. A diferencia del padrón, no hay un ciclo siguiente que
   * reintente, así que un conflicto de revisión (la sesión justo registró actividad) se relee y
   * se reintenta aquí. `remaining` > 0 significa que alguna sigue activa tras los reintentos.
   */
  public async revokeSessionsForRoleChange(
    oid: string,
    actor: { readonly id: string; readonly sessionId: string },
    correlationId: string,
  ): Promise<{ readonly revoked: number; readonly remaining: number }> {
    const key = oid.toLowerCase();
    let revoked = 0;
    for (let attempt = 0; attempt < ROLE_CHANGE_REVOCATION_ATTEMPTS; attempt += 1) {
      revoked += await this.revokeActiveSessionsOf(
        key,
        'roles_changed',
        { id: actor.id, type: 'user', sessionId: actor.sessionId },
        correlationId,
      );
      if ((await this.sessions.activeByOid(this.tenantId, key)).length === 0) {
        return { revoked, remaining: 0 };
      }
    }
    return { revoked, remaining: (await this.sessions.activeByOid(this.tenantId, key)).length };
  }

  /** Una pasada sobre las sesiones activas de un OID; cada revocación queda auditada. */
  private async revokeActiveSessionsOf(
    oid: string,
    reason: 'membership_removed' | 'ownership_removed' | 'roles_changed',
    actor: AuditEventDraft['actor'],
    correlationId: string,
  ): Promise<number> {
    let revoked = 0;
    for (const session of await this.sessions.activeByOid(this.tenantId, oid)) {
      const at = this.now();
      if (!(await this.sessions.update(revokeSession(session, reason, at), session.revision))) {
        continue;
      }
      revoked += 1;
      await recordAudit(this.audit, {
        id: randomUUID(),
        tenantId: this.tenantId,
        occurredAt: at,
        actor,
        action: 'access.session.revoked',
        resource: { type: 'session', id: session.subjectId },
        outcome: 'succeeded',
        correlationId,
        reason,
        metadata: { reference: session.id },
      });
    }
    return revoked;
  }

  public sessionReferenceOf(sessionId: string): string {
    return `h:${createHash('sha256').update(sessionId, 'utf8').digest('hex')}`;
  }

  public processInfo(): ProcessInfo | null {
    return this.options.processInfo?.() ?? null;
  }

  /** Arranca el despacho continuo. Lo llama el entrypoint, no las specs. */
  public startDispatcher(): void {
    this.urgentDispatcher.start();
    this.dispatcher.start();
    this.digests.start();
    this.wazuhPushInboxDispatcher?.start();
    this.options.channels?.start();
  }

  public async stopDispatcher(): Promise<void> {
    this.options.channels?.stop();
    await Promise.all([
      this.urgentDispatcher.stop(),
      this.dispatcher.stop(),
      this.digests.stop(),
      this.wazuhPushInboxDispatcher?.stop(),
    ]);
  }

  public get channels(): NotificationChannelRegistry | undefined {
    return this.options.channels;
  }

  public get consoleBaseUrl(): string {
    return this.options.access.consoleBaseUrl;
  }

  public get mailChannel(): MailChannel | undefined {
    return this.options.mail;
  }

  /** Prueba de Web Push a los dispositivos de una persona; devuelve cuántos aceptaron. */
  public async testPush(tenantId: string, subjectKey: string): Promise<number> {
    if (!this.options.push) return 0;
    return notifyDevices({
      store: this.options.push.store,
      sender: this.options.push.sender,
      tenantId,
      subjectKeys: [subjectKey.toLowerCase()],
      now: () => this.now(),
    });
  }

  /** Resúmenes de avisos: suprimidas (agrupadas/atraso/tope) y P3/P4 periódico. */
  public async runDigests(): Promise<void> {
    const recipients = this.options.recipients;
    const dependencies = {
      tenantId: this.tenantId,
      attempts: this.notifications,
      transport: this.transport,
      audit: this.soc.audit,
      clock: { now: () => this.now() },
      consoleBaseUrl: this.options.access.consoleBaseUrl,
      ...(this.options.notificationPolicy ? { policy: this.options.notificationPolicy } : {}),
      ...(recipients ? { recipients } : {}),
      ...(this.options.mail ? { mail: this.options.mail } : {}),
      lowPriorityAlerts: async (since: Date) => {
        const items = [];
        let total = 0;
        for (const priority of ['P3', 'P4'] as const) {
          const result = await this.soc.listAlerts({
            tenantId: this.tenantId,
            priority,
            status: 'open',
          });
          const recent = result.items.filter((alert) => alert.createdAt >= since);
          total += recent.length;
          items.push(
            ...recent.slice(0, DIGEST_ALERT_LIMIT).map((alert) => ({
              alertId: alert.id,
              title: alert.title,
              priority,
              ruleId: alert.ruleId,
              occurredAt: alert.occurredAt,
            })),
          );
        }
        return { items, total };
      },
    };
    await runSuppressedDigest(dependencies);
    await runLowPriorityDigest(dependencies);
  }

  /** Resumen diario del Analista IA por el mismo canal y evidencia que los demás resúmenes. */
  public async sendAnalystDigest(input: AnalystDigestInput): Promise<void> {
    await runAnalystDigest(
      {
        tenantId: this.tenantId,
        attempts: this.notifications,
        transport: this.transport,
        audit: this.soc.audit,
        clock: { now: () => this.now() },
        consoleBaseUrl: this.options.access.consoleBaseUrl,
        ...(this.options.notificationPolicy ? { policy: this.options.notificationPolicy } : {}),
        ...(this.options.recipients ? { recipients: this.options.recipients } : {}),
        ...(this.options.mail ? { mail: this.options.mail } : {}),
      },
      input,
    );
  }

  /** Token CSRF de la sesión: se entrega en `GET /api/auth/session` y se exige al mutar. */
  public csrfTokenFor(sessionId: string): string {
    return csrfTokenFor(this.csrfKey, sessionId);
  }

  public async beginSignIn(
    origin: RequestOrigin,
    returnTo: string = DEFAULT_RETURN_TO,
  ): Promise<{
    readonly url: string;
    readonly state: string;
    readonly browserBinding: string;
    readonly network: ReturnType<typeof evaluateNetwork>;
  }> {
    const { request, network } = await this.openHandshake(origin, returnTo);
    return {
      url: request.authorizationUrl,
      state: request.state,
      browserBinding: request.browserBinding,
      network,
    };
  }

  /** Abre y guarda el handshake; el `code_verifier` solo sale de aquí hacia emisores internos. */
  private async openHandshake(
    origin: RequestOrigin,
    returnTo: string,
  ): Promise<{
    readonly request: ReturnType<typeof beginAuthorization>;
    readonly network: ReturnType<typeof evaluateNetwork>;
  }> {
    const request = beginAuthorization(
      {
        tenantId: this.options.access.tenantId,
        clientId: this.options.access.clientId,
        authorizationEndpoint: this.options.access.authorizationEndpoint,
        redirectUri: this.options.access.redirectUri,
        allowedRedirectUris: this.options.access.allowedRedirectUris,
        scopes: this.options.access.scopes,
      },
      this.now(),
    );
    this.prunePendingFlows(this.now());
    this.rememberNonce(request.state, request.nonce, request.expiresAt);
    this.pendingReturnTo.set(request.state, {
      returnTo,
      browserBinding: request.browserBinding,
      expiresAt: request.expiresAt,
    });
    await this.handshakes.save({
      state: request.state,
      nonce: request.nonce,
      codeVerifier: request.codeVerifier,
      browserBinding: request.browserBinding,
      redirectUri: this.options.access.redirectUri,
      createdAt: this.now(),
      expiresAt: request.expiresAt,
    });
    return { request, network: evaluateNetwork(origin, this.networkPolicy) };
  }

  /** Atajo del emisor local: entrega el código que Entra devolvería tras autenticar. */
  public localAuthorize(username: string, state: string): string {
    if (!this.localIssuer) throw new Error('LOCAL_ISSUER_NOT_ENABLED');
    const pending = this.handshakePeek(state);
    if (!pending) throw new Error('STATE_UNKNOWN');
    return this.localIssuer.issueCode(username, pending.nonce, this.now());
  }

  /**
   * Acceso con usuario y contraseña. No es un camino paralelo: tras comprobar la credencial
   * se entra por el mismo `completeSignIn` que usa Entra, de modo que límite de tasa, bloqueo,
   * política de red (MFA dentro, passkey fuera), roles, sesión única y auditoría son idénticos.
   *
   * Verificadores: el del emisor local (desarrollo y pruebas) y, si está configurada y vigente,
   * la excepción demo de contraseña del administrador (una sola cuenta sintética). Sin ninguno,
   * el acceso se rechaza sin distinguir el motivo; vencida la excepción, la ruta se comporta
   * exactamente como si no existiera.
   */
  public async passwordSignIn(
    input: { readonly username: string; readonly password: string; readonly returnTo: string },
    origin: RequestOrigin,
    correlationId: string,
  ): Promise<
    | { readonly ok: true; readonly value: SignInSuccess; readonly flow: PasswordFlow }
    | { readonly ok: false; readonly failure: SignInFailure; readonly flow?: PasswordFlow }
  > {
    const at = this.now();
    const network = evaluateNetwork(origin, this.networkPolicy);
    const originKey = network.clientIp ?? 'unknown';
    const issuer = this.localIssuer;
    const demo = this.options.demoAdminLogin?.activeAt(at)
      ? this.options.demoAdminLogin
      : undefined;
    // Con la excepción vigente, todo intento de la ruta se audita con su motivo propio.
    const auditReason = demo ? DEMO_ADMIN_AUDIT.denied : undefined;
    const deny = (
      reason: SignInDenialReason,
      diagnostic: Pick<SignInDiagnostic, 'stage' | 'code'>,
    ) =>
      this.denied(reason, originKey, correlationId, at, network.clientIp, diagnostic, auditReason);
    if (!issuer && !demo) {
      return deny('TOKEN_INVALID', { stage: 'password', code: 'PASSWORD_LOGIN_UNAVAILABLE' });
    }
    // Mismo cupo por origen que el callback de Entra: un script no puede probar contraseñas
    // más rápido que un atacante contra el flujo OIDC (a cambio, un acceso consume dos).
    const rate = consumeRateLimit(
      await this.rateLimits.get(`auth:${originKey}`),
      `auth:${originKey}`,
      at,
    );
    await this.rateLimits.save(rate.state);
    if (!rate.allowed) return deny('RATE_LIMITED', { stage: 'rate_limit' });
    // Tope propio de la excepción demo: más estricto que el límite general de autenticación.
    if (demo && !demo.consumeAttempt(originKey, at)) {
      return deny('RATE_LIMITED', { stage: 'rate_limit', code: 'DEMO_ADMIN_ATTEMPTS' });
    }
    const username = input.username.trim().toLowerCase().slice(0, 254);
    const password = input.password.slice(0, 256);
    const subjectKey = `password:${username}`;
    const counter =
      (await this.attempts.get(subjectKey, originKey)) ?? emptyCounter(subjectKey, originKey, at);
    // El scrypt se calcula antes de mirar el bloqueo: un origen bloqueado tarda lo mismo que un
    // fallo y el tiempo no revela el estado de la cuenta.
    const demoVerification = demo
      ? await demo.authenticate(username, password)
      : ({ result: 'mismatch' } as const);
    if (demoVerification.result === 'busy') {
      return deny('RATE_LIMITED', { stage: 'rate_limit', code: 'DEMO_ADMIN_BUSY' });
    }
    if (!evaluateLockout(counter, at).allowed) {
      return deny('LOCKED_OUT', { stage: 'password', code: 'LOCKED_OUT' });
    }
    if (demo && demoVerification.result === 'match') {
      const account = demoVerification.account;
      const { request } = await this.openHandshake(origin, input.returnTo);
      const flow: PasswordFlow = {
        state: request.state,
        browserBinding: request.browserBinding,
        returnTo: this.takeReturnTo(request.state, request.browserBinding),
      };
      // El código queda ligado al `nonce` y al `code_verifier` de este handshake.
      const code = demo.issueCode(request.nonce, request.codeVerifier, at, account);
      const result = await this.completeSignInWith(
        { state: request.state, code, browserBinding: request.browserBinding },
        origin,
        correlationId,
        { kind: 'demo-admin', login: demo, account },
      );
      if (result.ok) await this.attempts.save(registerSuccess(counter, at));
      return { ...result, flow };
    }
    const principal = issuer?.verifyPassword(username, password);
    if (!issuer || !principal) {
      await this.attempts.save(registerFailure(counter, at));
      return deny('TOKEN_INVALID', { stage: 'password', code: 'BAD_CREDENTIALS' });
    }
    const begun = await this.beginSignIn(origin, input.returnTo);
    const flow: PasswordFlow = {
      state: begun.state,
      browserBinding: begun.browserBinding,
      returnTo: this.takeReturnTo(begun.state, begun.browserBinding),
    };
    const code = this.localAuthorize(principal.username, begun.state);
    const result = await this.completeSignIn(
      { state: begun.state, code, browserBinding: begun.browserBinding },
      origin,
      correlationId,
    );
    if (result.ok) await this.attempts.save(registerSuccess(counter, at));
    return { ...result, flow };
  }

  private readonly pendingNonces = new Map<string, { nonce: string; expiresAt: Date }>();
  /** Destino ya validado por `safeReturnTo`, atado al `state` del handshake (B-03). */
  private readonly pendingReturnTo = new Map<
    string,
    { readonly returnTo: string; readonly browserBinding: string; readonly expiresAt: Date }
  >();

  /**
   * `/api/auth/start` es anónimo: el estado auxiliar del flujo (nonce y destino) caduca con su
   * handshake y tiene el mismo tope que el store, o un script agotaría la memoria del proceso.
   */
  private prunePendingFlows(at: Date): void {
    for (const pending of [this.pendingNonces, this.pendingReturnTo] as Map<
      string,
      { readonly expiresAt: Date }
    >[]) {
      for (const [state, entry] of pending) {
        if (entry.expiresAt.getTime() > at.getTime()) break;
        pending.delete(state);
      }
      while (pending.size >= HANDSHAKE_LIMITS.maxPending) {
        const oldest = pending.keys().next();
        if (oldest.done) break;
        pending.delete(oldest.value);
      }
    }
  }

  /** Flujos pendientes retenidos en memoria (diagnóstico y pruebas). */
  public get pendingFlowCount(): { readonly nonces: number; readonly returnTo: number } {
    return { nonces: this.pendingNonces.size, returnTo: this.pendingReturnTo.size };
  }

  /** Se consume una sola vez, igual que el `state` al que pertenece. */
  public takeReturnTo(state: string | undefined, browserBinding: string | undefined): string {
    if (!state) return DEFAULT_RETURN_TO;
    const pending = this.pendingReturnTo.get(state);
    if (
      !pending ||
      !browserBinding ||
      !constantTimeEquals(browserBinding, pending.browserBinding) ||
      pending.expiresAt.getTime() <= this.now().getTime()
    ) {
      return DEFAULT_RETURN_TO;
    }
    this.pendingReturnTo.delete(state);
    return pending.returnTo;
  }

  public rememberNonce(
    state: string,
    nonce: string,
    expiresAt: Date = new Date(this.now().getTime() + HANDSHAKE_LIMITS.stateTtlMs),
  ): void {
    this.pendingNonces.set(state, { nonce, expiresAt });
  }

  public handshakePeek(state: string): { readonly nonce: string } | undefined {
    return this.pendingNonces.get(state);
  }

  /** Callback de Entra (o del emisor local). Nunca canjea códigos del emisor demo. */
  public async completeSignIn(
    input: {
      readonly state?: string;
      readonly code?: string;
      readonly error?: string;
      readonly errorDescription?: string;
      readonly browserBinding?: string;
    },
    origin: RequestOrigin,
    correlationId: string,
  ): Promise<
    | { readonly ok: true; readonly value: SignInSuccess }
    | { readonly ok: false; readonly failure: SignInFailure }
  > {
    return this.completeSignInWith(input, origin, correlationId, { kind: 'directory' });
  }

  /**
   * Un único pipeline de admisión para todos los emisores: handshake (`state`, `nonce`, PKCE,
   * vínculo con el navegador), red, canje, `validateIdToken`, bloqueo, roles, decisión, sesión
   * única y auditoría. Lo único que cambia con `source` es quién firma y qué emisor se espera.
   */
  private async completeSignInWith(
    input: {
      readonly state?: string;
      readonly code?: string;
      readonly error?: string;
      readonly errorDescription?: string;
      readonly browserBinding?: string;
    },
    origin: RequestOrigin,
    correlationId: string,
    source: IdentitySource,
  ): Promise<
    | { readonly ok: true; readonly value: SignInSuccess }
    | { readonly ok: false; readonly failure: SignInFailure }
  > {
    const at = this.now();
    const network = evaluateNetwork(origin, this.networkPolicy);
    const originKey = network.clientIp ?? 'unknown';
    const demo = source.kind === 'demo-admin' ? source.login : undefined;
    const demoAccount = source.kind === 'demo-admin' ? source.account : undefined;
    const auditReason = demo ? DEMO_ADMIN_AUDIT.denied : undefined;
    const deny = (
      reason: SignInDenialReason,
      diagnostic: Pick<SignInDiagnostic, 'stage' | 'code'>,
    ) =>
      this.denied(reason, originKey, correlationId, at, network.clientIp, diagnostic, auditReason);
    const tokens = demo ? this.demoTokens : this.tokens;
    const jwks = demo ? this.demoJwks : this.jwks;
    if (!tokens || !jwks || (demo && !demo.activeAt(at))) {
      return deny('TOKEN_INVALID', { stage: 'password', code: 'PASSWORD_LOGIN_UNAVAILABLE' });
    }
    const rate = consumeRateLimit(
      await this.rateLimits.get(`auth:${originKey}`),
      `auth:${originKey}`,
      at,
    );
    await this.rateLimits.save(rate.state);
    if (!rate.allowed) {
      return deny('RATE_LIMITED', { stage: 'rate_limit' });
    }
    const stored = input.state
      ? await this.handshakes.consume(input.state, input.browserBinding, at)
      : undefined;
    const callback = resolveCallback(input, stored, at);
    if (!callback.ok) {
      return deny('TOKEN_INVALID', {
        stage: 'callback',
        code:
          callback.code === 'PROVIDER_ERROR' && diagnosticCode(callback.detail)
            ? `PROVIDER_ERROR:${callback.detail}`
            : callback.code,
      });
    }
    const policy = policyForNetwork(network.decision);
    if (!policy) {
      return deny('NETWORK_UNTRUSTED', { stage: 'network', code: network.decision });
    }
    let idToken: string;
    try {
      idToken = (
        await tokens.exchange({
          code: callback.code,
          codeVerifier: callback.handshake.codeVerifier,
          redirectUri: callback.handshake.redirectUri,
        })
      ).idToken;
    } catch (error) {
      return deny('TOKEN_INVALID', {
        stage: 'token_exchange',
        code: diagnosticCode(error instanceof Error ? error.message : undefined) ?? 'UNKNOWN',
      });
    }
    let signingKeys: Awaited<ReturnType<JwksProvider['keys']>>;
    try {
      signingKeys = await jwks.keys();
    } catch (error) {
      return deny('TOKEN_INVALID', {
        stage: 'jwks',
        code: diagnosticCode(error instanceof Error ? error.message : undefined) ?? 'UNKNOWN',
      });
    }
    const tokenPolicy = {
      issuer: demo ? demo.issuer : this.options.access.issuer,
      audience: this.options.access.clientId,
      tenantId: this.options.access.tenantId,
    };
    let verified = validateIdToken(idToken, signingKeys, tokenPolicy, callback.handshake.nonce, at);
    // `kid` desconocido = Microsoft rotó sus claves después de la última lectura del JWKS. El
    // código ya se canjeó (es de un solo uso): se refresca el JWKS una vez y se revalida el mismo
    // token, en vez de rechazar todos los accesos hasta que venza la caché.
    if (!verified.ok && verified.code === 'KEY_UNKNOWN') {
      try {
        const refreshed = await jwks.keys({ forceRefresh: true });
        if (refreshed !== signingKeys) {
          verified = validateIdToken(idToken, refreshed, tokenPolicy, callback.handshake.nonce, at);
        }
      } catch {
        // Sin JWKS fresco se mantiene el rechazo original (`KEY_UNKNOWN`).
      }
    }
    // El prefijo `demo-admin:` es exclusivo del emisor demo, y ese emisor solo firma al sujeto de
    // la cuenta verificada: ningún otro token abre una sesión con identidad de la excepción ni al
    // revés, y una cuenta demo no puede obtener la sesión de otra.
    const validation: typeof verified =
      verified.ok &&
      (demoAccount
        ? verified.claims.sub !== demoAccount.subjectId
        : isDemoAdminSubject(verified.claims.sub))
        ? { ok: false, code: 'CLAIMS_MALFORMED' }
        : verified;
    const subjectKey = validation.ok ? validation.claims.sub : `unknown:${originKey}`;
    const counter =
      (await this.attempts.get(subjectKey, originKey)) ?? emptyCounter(subjectKey, originKey, at);
    const lockout = evaluateLockout(counter, at);
    // La persona sintética no hereda asignaciones del deploy ni grants: su único rol es el de su
    // cuenta (uno de los cuatro roles runtime; nunca un rol aprobador).
    const backendBinding = demo ? undefined : this.options.access.mvpRoleBinding;
    const backendRole =
      validation.ok &&
      backendBinding &&
      validation.claims.oid?.toLowerCase() === backendBinding.oid &&
      at.getTime() < backendBinding.expiresAt.getTime()
        ? backendBinding.role
        : undefined;
    const granted =
      validation.ok && !demo && this.options.roleGrants
        ? await this.options.roleGrants(validation.claims.oid, validation.claims.groups)
        : [];
    const roles = !validation.ok
      ? []
      : demoAccount
        ? (validation.claims.roles ?? []).filter((role) => role === demoAccount.role).slice(0, 1)
        : [
            ...new Set([
              ...rolesFromIdToken(validation.claims.roles),
              ...(backendRole ? [backendRole] : []),
              ...granted,
            ]),
          ];
    const capabilities = effectiveCapabilities(roles, BFF_SCOPES);
    let decision = decideSignIn({
      network: network.decision,
      locked: !lockout.allowed,
      rateLimited: false,
      ...(validation.ok ? { claims: validation.claims } : {}),
      roles,
      capabilities: capabilities as ReadonlySet<string>,
    });
    // Excepción temporal, solo para el demo: una identidad que QAPAQ ya autorizó (tiene al
    // menos una capacidad: dueño o miembro del grupo de admisión, o asignación del deploy)
    // entra aunque el `amr` del token no pruebe MFA/passkey. Nunca inventa evidencia de AMR
    // ni salta las comprobaciones de token, red, bloqueo o rol: la pertenencia a Accesos_SOC
    // es el control de admisión. Acotada a este despliegue (tenant/client/redirect fijos) y
    // con vencimiento obligatorio, con tope de 30 días para que no se vuelva permanente.
    const exceptionUntil = this.options.demoMfaExceptionUntil?.getTime() ?? Number.NaN;
    const demoMfaException =
      !demo &&
      !decision.admitted &&
      (decision.reason === 'MFA_REQUIRED' || decision.reason === 'PASSKEY_REQUIRED') &&
      validation.ok &&
      capabilities.size > 0 &&
      this.options.access.redirectUri === 'https://app.qapaq.pe/api/auth/callback' &&
      this.options.access.tenantId === '11111111-1111-4111-8111-111111111111' &&
      this.options.access.clientId === '22222222-2222-4222-8222-222222222222' &&
      Number.isFinite(exceptionUntil) &&
      exceptionUntil <= at.getTime() + 30 * 86_400_000 &&
      at.getTime() < exceptionUntil;
    if (demoMfaException) {
      decision = { admitted: true, requiredAmr: [] };
    }
    // Excepción demo de contraseña: decisión explícita y separada. Solo para el sujeto del
    // emisor demo, con la excepción vigente, desde la red permitida (`inside`), sin bloqueo y
    // con exactamente el rol de la cuenta verificada. Admite una sesión con `amr: ['pwd']`: no
    // inventa MFA.
    // Fuera de la red, con cadena de proxies no confiable o bloqueada, la denegación se mantiene.
    const demoPasswordException =
      demo !== undefined &&
      demoAccount !== undefined &&
      !decision.admitted &&
      decision.reason === 'MFA_REQUIRED' &&
      network.decision === 'inside' &&
      lockout.allowed &&
      validation.ok &&
      validation.claims.sub === demoAccount.subjectId &&
      demo.activeAt(at) &&
      roles.length === 1 &&
      roles[0] === demoAccount.role &&
      capabilities.size > 0;
    if (demoPasswordException) {
      decision = { admitted: true, requiredAmr: [] };
    }
    if (!decision.admitted) {
      await this.attempts.save(registerFailure(counter, at));
      await this.auditSignIn(
        'denied',
        subjectKey,
        correlationId,
        at,
        network.clientIp,
        demo ? DEMO_ADMIN_AUDIT.denied : decision.reason,
        demo ? { denial: decision.reason } : undefined,
      );
      this.options.onSignInDenied?.({
        reason: decision.reason,
        stage: 'decision',
        correlationId,
        code: decisionDiagnostic(decision.reason, validation),
      });
      return { ok: false, failure: { reason: decision.reason, message: decision.publicMessage } };
    }
    await this.attempts.save(registerSuccess(counter, at));
    const claims = validation.ok ? validation.claims : undefined;
    const existing = await this.sessions.activeBySubject(this.tenantId, claims!.sub);
    const plan = openSession(
      {
        subjectId: claims!.sub,
        ...(claims!.oid ? { oid: claims!.oid } : {}),
        ...(claims!.name ? { displayName: claims!.name } : {}),
        ...(claims!.preferred_username ? { email: claims!.preferred_username } : {}),
        tenantId: this.tenantId,
        roles,
        scopes: [...this.options.access.scopes],
        capabilities: capabilities as ReadonlySet<Capability>,
        amr: claims!.amr ?? [],
        clientIp: network.clientIp ?? 'unknown',
        ...(claims!.sid ? { idpSessionId: claims!.sid } : {}),
      },
      existing,
      at,
    );
    // La sesión abierta con un rol temporal no debe sobrevivir al vencimiento de la asignación.
    let session = backendRole
      ? {
          ...plan.session,
          absoluteExpiresAt: new Date(
            Math.min(plan.session.absoluteExpiresAt.getTime(), backendBinding!.expiresAt.getTime()),
          ),
        }
      : plan.session;
    if (demoMfaException) {
      session = {
        ...session,
        absoluteExpiresAt: new Date(Math.min(session.absoluteExpiresAt.getTime(), exceptionUntil)),
      };
    }
    // Sesión de la excepción demo: vida absoluta ≤ 8 h y nunca más allá del vencimiento.
    if (demoPasswordException) {
      session = {
        ...session,
        absoluteExpiresAt: new Date(
          Math.min(
            session.absoluteExpiresAt.getTime(),
            at.getTime() + DEMO_ADMIN_SESSION_MAX_MS,
            demo.until.getTime(),
          ),
        ),
      };
    }
    // Se revoca con la sesión que ya devolvió `activeBySubject`, no releyendo por id: el
    // store durable no conoce los ids originales (solo su hash) y `byId` solo acepta cookies.
    for (const id of plan.supersedes) {
      const previous = existing.find((candidate) => candidate.id === id);
      if (previous) {
        await this.sessions.update(revokeSession(previous, 'superseded', at), previous.revision);
      }
    }
    await this.sessions.create(session);
    await this.auditSignIn(
      'succeeded',
      claims!.sub,
      correlationId,
      at,
      network.clientIp,
      demoPasswordException
        ? DEMO_ADMIN_AUDIT.admitted
        : demoMfaException
          ? 'temporary_demo_mfa_exception'
          : backendRole
            ? 'backend_mvp_role_binding'
            : undefined,
    );
    return { ok: true, value: { session, supersededSessions: plan.supersedes } };
  }

  private async denied(
    reason: SignInDenialReason,
    originKey: string,
    correlationId: string,
    at: Date,
    clientIp: string | null,
    diagnostic: Pick<SignInDiagnostic, 'stage' | 'code'>,
    /** Motivo de auditoría propio (excepción demo); por defecto, el motivo de la denegación. */
    auditReason?: string,
  ): Promise<{ readonly ok: false; readonly failure: SignInFailure }> {
    this.options.onSignInDenied?.({ reason, correlationId, ...diagnostic });
    const decision = decideSignIn({
      network: reason === 'NETWORK_UNTRUSTED' ? 'untrusted_chain' : 'inside',
      locked: reason === 'LOCKED_OUT',
      rateLimited: reason === 'RATE_LIMITED',
      roles: [],
      capabilities: new Set(),
    });
    await this.auditSignIn(
      'denied',
      `unknown:${originKey}`,
      correlationId,
      at,
      clientIp,
      auditReason ?? reason,
      auditReason === undefined ? undefined : { denial: reason },
    );
    return {
      ok: false,
      failure: {
        reason,
        message: decision.admitted ? 'No fue posible iniciar sesión.' : decision.publicMessage,
      },
    };
  }

  private async auditSignIn(
    outcome: AuditEventDraft['outcome'],
    subjectId: string,
    correlationId: string,
    at: Date,
    clientIp: string | null,
    reason?: string,
    /** Solo códigos (p. ej. el motivo técnico de una denegación demo); nunca credenciales. */
    metadata?: Readonly<Record<string, string>>,
  ): Promise<void> {
    await recordAudit(this.audit, {
      id: randomUUID(),
      tenantId: this.tenantId,
      occurredAt: at,
      actor: { id: subjectId, type: 'user', ...(clientIp ? { ip: clientIp } : {}) },
      action: 'access.sign_in',
      resource: { type: 'session', id: subjectId },
      outcome,
      correlationId,
      ...(reason === undefined ? {} : { reason }),
      ...(metadata === undefined ? {} : { metadata }),
    });
  }

  /** Auditoría de una pregunta a Qapaqzito: quién, resultado y herramientas usadas; sin el texto. */
  public async auditAssistant(
    subjectId: string,
    correlationId: string,
    outcome: AuditEventDraft['outcome'],
    tools: readonly string[],
    usage?: {
      readonly provider: string;
      readonly model: string;
      readonly usage: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly cacheReadTokens: number;
        readonly cacheWriteTokens: number;
      };
    },
  ): Promise<void> {
    await recordAudit(this.audit, {
      id: randomUUID(),
      tenantId: this.tenantId,
      occurredAt: this.now(),
      actor: { id: subjectId, type: 'user' },
      action: 'assistant.ask',
      resource: { type: 'assistant', id: correlationId },
      outcome,
      correlationId,
      ...(tools.length > 0 ? { reason: `tools:${tools.join(',')}`.slice(0, 200) } : {}),
      ...(usage
        ? {
            metadata: {
              provider: usage.provider,
              model: usage.model,
              usage: {
                inputTokens: usage.usage.inputTokens,
                outputTokens: usage.usage.outputTokens,
                cacheReadTokens: usage.usage.cacheReadTokens,
                cacheWriteTokens: usage.usage.cacheWriteTokens,
              },
            },
          }
        : {}),
    });
  }

  public async resolveActor(
    sessionId: string | undefined,
    origin: RequestOrigin,
  ): Promise<
    | { readonly ok: true; readonly actor: Actor; readonly session: Session }
    | {
        readonly ok: false;
        readonly reason: 'AUTH_REQUIRED' | 'SESSION_EXPIRED' | 'NETWORK_NOT_ALLOWED';
      }
  > {
    if (!sessionId) return { ok: false, reason: 'AUTH_REQUIRED' };
    const network = evaluateNetwork(origin, this.networkPolicy);
    if (network.decision === 'untrusted_chain') {
      return { ok: false, reason: 'NETWORK_NOT_ALLOWED' };
    }
    const now = this.now();
    const stored = await this.sessions.byId(sessionId);
    const evaluation = evaluateSession(stored, now);
    if (!evaluation.valid) {
      return { ok: false, reason: stored ? 'SESSION_EXPIRED' : 'AUTH_REQUIRED' };
    }
    // Excepción demo vencida, apagada o de otro sujeto: la sesión deja de valer en el acto.
    if (
      isDemoAdminSubject(evaluation.session.subjectId) &&
      !this.demoAdminSessionAllowed(evaluation.session.subjectId, evaluation.session.roles, now)
    ) {
      await this.sessions.update(revokeSession(stored!, 'identity_revoked', now), stored!.revision);
      return { ok: false, reason: 'SESSION_EXPIRED' };
    }
    await this.sessions.update(evaluation.session, stored!.revision);
    return {
      ok: true,
      session: evaluation.session,
      actor: {
        subjectId: evaluation.session.subjectId,
        tenantId: evaluation.session.tenantId,
        sessionId: evaluation.session.id,
        capabilities: evaluation.session.capabilities,
        roles: evaluation.session.roles,
      },
    };
  }

  public async signOut(sessionId: string): Promise<void> {
    const session = await this.sessions.byId(sessionId);
    if (!session) return;
    await this.sessions.update(revokeSession(session, 'logout', this.now()), session.revision);
  }

  public static capabilitiesOf(roles: readonly string[]): ReadonlySet<Capability> {
    return capabilitiesForRoles(roles);
  }

  public static get localPrincipals(): typeof LOCAL_PRINCIPALS {
    return LOCAL_PRINCIPALS;
  }
}
