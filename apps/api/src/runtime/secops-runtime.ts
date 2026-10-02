/**
 * Composición del BFF: C-16, C-17, C-18, C-19, C-20 y C-25 en un solo objeto de runtime.
 *
 * Los adapters de persistencia son, en esta entrega, los de memoria que publican los
 * módulos. Están aquí y no inventados en `apps`: el contrato de almacenamiento pertenece
 * al dominio, y el adapter PostgreSQL se enchufa en el mismo punto sin tocar
 * controladores. La limitación está declarada en la matriz de evidencia de C-22.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import {
  beginAuthorization,
  capabilitiesForRoles,
  decideSignIn,
  effectiveCapabilities,
  emptyCounter,
  evaluateLockout,
  evaluateNetwork,
  evaluateSession,
  consumeRateLimit,
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
  type SignInDenialReason,
  type TokenExchange,
} from '@qapaq/access';
import { InMemoryAuditStore, recordAudit, type AuditEventDraft } from '@qapaq/audit';
import type { AccessConfig } from '@qapaq/configuration';
import { decidePromotion, promotionKey, type PrioritizationContext } from '@qapaq/detection';
import { InMemorySoc, ingestCandidate, type SocDependencies } from '@qapaq/soc';
import {
  ConsoleFallbackChannel,
  InMemoryAttemptStore as InMemoryNotificationStore,
  InMemoryOutbox,
  TeamsWorkflowTransport,
  type DispatchDependencies,
  type NotificationTransport,
} from '@qapaq/soar';
import type { SecurityEvent } from '@qapaq/contracts';

import {
  EntraJwksProvider,
  EntraTokenExchange,
  LocalJwksProvider,
  LocalTokenExchange,
} from '../access/identity-provider.js';
import { LocalDevelopmentIssuer, LOCAL_PRINCIPALS } from '../access/local-issuer.js';
import { csrfTokenFor } from '../http/csrf.js';
import { DEFAULT_RETURN_TO } from '../http/return-to.js';

export interface RuntimeOptions {
  readonly access: AccessConfig;
  readonly profile: string;
  readonly clientSecret?: string;
  readonly teamsWorkflowUrl?: string;
  readonly transport?: NotificationTransport;
  readonly clock?: () => Date;
}

/**
 * Scopes que el BFF, como cliente confidencial, siempre solicita. El recorte real lo
 * hace el rol de la persona: la intersección vive en `effectiveCapabilities`.
 */
export const BFF_SCOPES = ['soc.read', 'soc.write', 'audit.read'] as const;

export type SignInFailure = { readonly reason: SignInDenialReason; readonly message: string };

export interface SignInSuccess {
  readonly session: Session;
  readonly supersededSessions: readonly string[];
}

export class SecOpsRuntime {
  public readonly handshakes = new InMemoryHandshakeStore();
  public readonly sessions = new InMemorySessionStore();
  public readonly attempts = new InMemoryAttemptStore();
  public readonly rateLimits = new InMemoryRateLimitStore();
  public readonly audit = new InMemoryAuditStore();
  public readonly soc = new InMemorySoc();
  public readonly outbox = new InMemoryOutbox();
  public readonly notifications = new InMemoryNotificationStore();
  public readonly fallback = new ConsoleFallbackChannel();
  public readonly localIssuer: LocalDevelopmentIssuer | undefined;
  public readonly networkPolicy: NetworkPolicy;
  private readonly jwks: JwksProvider;
  private readonly tokens: TokenExchange;
  private readonly transport: NotificationTransport;
  private readonly clock: () => Date;
  /**
   * Clave del token CSRF (B-01). Vive en memoria igual que las sesiones: un reinicio
   * invalida ambas a la vez. Con el adapter PostgreSQL de sesiones pasa a SecretProvider.
   */
  private readonly csrfKey = randomBytes(32);
  /** Contexto de priorización de C-16; en esta entrega se declara, no se inventa. */
  public detectionContext: PrioritizationContext = {
    privilegedIdentities: new Set(),
    criticalAssets: new Set(),
  };

  public constructor(private readonly options: RuntimeOptions) {
    this.clock = options.clock ?? (() => new Date());
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
    this.transport =
      options.transport ??
      new TeamsWorkflowTransport({
        workflowUrl: options.teamsWorkflowUrl ?? 'https://localhost/teams-not-configured',
        destinationRef: 'teams:canal-soc',
      });
  }

  public now(): Date {
    return this.clock();
  }

  /** La cookie solo se marca `Secure` donde el transporte lo es: si no, no viajaría. */
  public get secureCookies(): boolean {
    return this.options.profile === 'production';
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
    };
  }

  public dispatchDependencies(): DispatchDependencies {
    return {
      outbox: this.outbox,
      attempts: this.notifications,
      transport: this.transport,
      fallback: this.fallback,
      audit: this.audit,
      clock: { now: () => this.now() },
      ids: { next: () => randomUUID() },
      consoleBaseUrl: this.options.access.consoleBaseUrl,
    };
  }

  /** Puente C-16 → C-17: promueve el evento y materializa la alerta si corresponde. */
  public async promoteEvent(
    event: SecurityEvent,
  ): Promise<'promoted' | 'duplicate' | 'not_promoted'> {
    const key = promotionKey(event.tenant.id, event.recordId, '1.0.0');
    const alerts = [...this.soc.alertRows.values()];
    const existingAlert = alerts.find((alert) => alert.eventRecordId === event.recordId);
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
          rulesetId: 'qapaq.detection.prioritization',
          rulesetVersion: '1.0.0',
          occurredAt: existingAlert.occurredAt,
          createdAt: existingAlert.createdAt,
          title: existingAlert.title,
        }
      : undefined;
    const decision = decidePromotion(event, this.detectionContext, existing, this.now());
    if (decision.outcome !== 'promoted') return decision.outcome;
    await ingestCandidate(this.socDependencies(), decision.candidate);
    // El outbox del SOC y el que lee el worker son el mismo flujo: se reenvía aquí
    // hasta que el adapter PostgreSQL comparta la tabla.
    for (const message of this.soc.outboxRows.values()) this.outbox.enqueue(message);
    return 'promoted';
  }

  public pumpOutbox(): void {
    for (const message of this.soc.outboxRows.values()) this.outbox.enqueue(message);
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
    this.rememberNonce(request.state, request.nonce);
    this.pendingReturnTo.set(request.state, returnTo);
    await this.handshakes.save({
      state: request.state,
      nonce: request.nonce,
      codeVerifier: request.codeVerifier,
      redirectUri: this.options.access.redirectUri,
      createdAt: this.now(),
      expiresAt: request.expiresAt,
    });
    return {
      url: request.authorizationUrl,
      state: request.state,
      network: evaluateNetwork(origin, this.networkPolicy),
    };
  }

  /** Atajo del emisor local: entrega el código que Entra devolvería tras autenticar. */
  public localAuthorize(username: string, state: string): string {
    if (!this.localIssuer) throw new Error('LOCAL_ISSUER_NOT_ENABLED');
    const pending = this.handshakePeek(state);
    if (!pending) throw new Error('STATE_UNKNOWN');
    return this.localIssuer.issueCode(username, pending.nonce, this.now());
  }

  private readonly pendingNonces = new Map<string, { nonce: string }>();
  /** Destino ya validado por `safeReturnTo`, atado al `state` del handshake (B-03). */
  private readonly pendingReturnTo = new Map<string, string>();

  /** Se consume una sola vez, igual que el `state` al que pertenece. */
  public takeReturnTo(state: string | undefined): string {
    if (!state) return DEFAULT_RETURN_TO;
    const returnTo = this.pendingReturnTo.get(state) ?? DEFAULT_RETURN_TO;
    this.pendingReturnTo.delete(state);
    return returnTo;
  }

  public rememberNonce(state: string, nonce: string): void {
    this.pendingNonces.set(state, { nonce });
  }

  public handshakePeek(state: string): { readonly nonce: string } | undefined {
    return this.pendingNonces.get(state);
  }

  public async completeSignIn(
    input: { readonly state?: string; readonly code?: string; readonly error?: string },
    origin: RequestOrigin,
    correlationId: string,
  ): Promise<
    | { readonly ok: true; readonly value: SignInSuccess }
    | { readonly ok: false; readonly failure: SignInFailure }
  > {
    const at = this.now();
    const network = evaluateNetwork(origin, this.networkPolicy);
    const originKey = network.clientIp ?? 'unknown';
    const rate = consumeRateLimit(
      await this.rateLimits.get(`auth:${originKey}`),
      `auth:${originKey}`,
      at,
    );
    await this.rateLimits.save(rate.state);
    if (!rate.allowed) {
      return this.denied('RATE_LIMITED', originKey, correlationId, at, network.clientIp);
    }
    const stored = input.state ? await this.handshakes.consume(input.state, at) : undefined;
    const callback = resolveCallback(input, stored, at);
    if (!callback.ok) {
      return this.denied('TOKEN_INVALID', originKey, correlationId, at, network.clientIp);
    }
    const policy = policyForNetwork(network.decision);
    if (!policy) {
      return this.denied('NETWORK_UNTRUSTED', originKey, correlationId, at, network.clientIp);
    }
    let idToken: string;
    try {
      idToken = (
        await this.tokens.exchange({
          code: callback.code,
          codeVerifier: callback.handshake.codeVerifier,
          redirectUri: callback.handshake.redirectUri,
        })
      ).idToken;
    } catch {
      return this.denied('TOKEN_INVALID', originKey, correlationId, at, network.clientIp);
    }
    const validation = validateIdToken(
      idToken,
      await this.jwks.keys(),
      {
        issuer: this.options.access.issuer,
        audience: this.options.access.clientId,
        tenantId: this.options.access.tenantId,
      },
      callback.handshake.nonce,
      at,
    );
    const subjectKey = validation.ok ? validation.claims.sub : `unknown:${originKey}`;
    const counter =
      (await this.attempts.get(subjectKey, originKey)) ?? emptyCounter(subjectKey, originKey, at);
    const lockout = evaluateLockout(counter, at);
    const roles = validation.ok ? (validation.claims.roles ?? []) : [];
    const capabilities = effectiveCapabilities(roles, BFF_SCOPES);
    const decision = decideSignIn({
      network: network.decision,
      locked: !lockout.allowed,
      rateLimited: false,
      ...(validation.ok ? { claims: validation.claims } : {}),
      roles,
      capabilities: capabilities as ReadonlySet<string>,
    });
    if (!decision.admitted) {
      await this.attempts.save(registerFailure(counter, at));
      await this.auditSignIn(
        'denied',
        subjectKey,
        correlationId,
        at,
        network.clientIp,
        decision.reason,
      );
      return { ok: false, failure: { reason: decision.reason, message: decision.publicMessage } };
    }
    await this.attempts.save(registerSuccess(counter, at));
    const claims = validation.ok ? validation.claims : undefined;
    const existing = await this.sessions.activeBySubject(this.tenantId, claims!.sub);
    const plan = openSession(
      {
        subjectId: claims!.sub,
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
    for (const id of plan.supersedes) {
      const previous = await this.sessions.byId(id);
      if (previous) {
        await this.sessions.update(revokeSession(previous, 'superseded', at), previous.revision);
      }
    }
    await this.sessions.create(plan.session);
    await this.auditSignIn('succeeded', claims!.sub, correlationId, at, network.clientIp);
    return { ok: true, value: { session: plan.session, supersededSessions: plan.supersedes } };
  }

  private async denied(
    reason: SignInDenialReason,
    originKey: string,
    correlationId: string,
    at: Date,
    clientIp: string | null,
  ): Promise<{ readonly ok: false; readonly failure: SignInFailure }> {
    const decision = decideSignIn({
      network: reason === 'NETWORK_UNTRUSTED' ? 'untrusted_chain' : 'inside',
      locked: reason === 'LOCKED_OUT',
      rateLimited: reason === 'RATE_LIMITED',
      roles: [],
      capabilities: new Set(),
    });
    await this.auditSignIn('denied', `unknown:${originKey}`, correlationId, at, clientIp, reason);
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
    const stored = await this.sessions.byId(sessionId);
    const evaluation = evaluateSession(stored, this.now());
    if (!evaluation.valid) {
      return { ok: false, reason: stored ? 'SESSION_EXPIRED' : 'AUTH_REQUIRED' };
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
