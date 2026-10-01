/**
 * Frontend contract for the institutional administration console.
 * Routes describe the future same-origin NestJS BFF; no browser token is exposed.
 */
export const ADMIN_API = {
  session: '/api/v1/session',
  overview: '/api/v1/platform/overview',
  events: '/api/v1/soc/events',
  alerts: '/api/v1/soc/alerts',
  cases: '/api/v1/soc/cases',
  incidents: '/api/v1/soc/incidents',
  rules: '/api/v1/detection/rules',
  quarantine: '/api/v1/platform/quarantine',
  sessions: '/api/v1/platform/sessions',
  sources: '/api/v1/platform/sources',
  services: '/api/v1/platform/services',
  accessRequests: '/api/v1/platform/access-requests',
  auditEvents: '/api/v1/platform/audit-events',
  notifications: '/api/v1/platform/notifications',
} as const;

export const AUTH_API = {
  startEntra: '/api/v1/auth/entra/start',
  callbackEntra: '/api/v1/auth/entra/callback',
  session: '/api/v1/session',
  logout: '/api/v1/session/logout',
} as const;

export type DataMode = 'mock' | 'live';
export type OperationalStatus = 'healthy' | 'degraded' | 'blocked' | 'unknown';
export type Severity = 'INFORMATIONAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type AlertState =
  'new' | 'enriching' | 'triage' | 'investigating' | 'confirmed' | 'false_positive' | 'closed';
export type AdminRole =
  | 'PLATFORM_ADMIN'
  | 'SOC_L1'
  | 'SOC_L2'
  | 'SOC_MANAGER'
  | 'DETECTION_ENGINEER'
  | 'AUDITOR'
  | 'VIEWER'
  | 'ACCESS_ADMIN';

export interface AdminSession {
  readonly mode: DataMode;
  readonly actor: {
    readonly id: string;
    readonly displayName: string;
    readonly email: string;
    readonly role: AdminRole;
    readonly scope: 'institution';
    readonly capabilities: readonly string[];
  };
  readonly auth: {
    readonly provider: 'Microsoft Entra ID';
    readonly flow: 'OIDC Authorization Code + PKCE';
    readonly session: 'opaque BFF cookie' | 'simulated in memory';
    readonly tenantLabel: string;
  };
}

export interface ServiceHealth {
  readonly id: string;
  readonly name: string;
  readonly kind: 'source' | 'storage' | 'queue' | 'search' | 'identity' | 'notification';
  readonly status: OperationalStatus;
  readonly detail: string;
  readonly checkedAt: string;
  readonly latencyMs?: number;
}

export interface PlatformOverview {
  readonly mode: DataMode;
  readonly asOf: string;
  readonly metrics: {
    readonly openAlerts: number;
    readonly criticalAlerts: number;
    readonly activeIncidents: number;
    readonly eventsLastHour: number;
    readonly pendingAccessReviews: number;
  };
  readonly services: readonly ServiceHealth[];
  readonly coverage: readonly {
    readonly id: string;
    readonly name: string;
    readonly state: 'collecting' | 'partial' | 'blocked';
    readonly lastEventAt: string | null;
    readonly note: string;
  }[];
}

export interface AlertSummary {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly state: AlertState;
  readonly source: string;
  readonly occurredAt: string;
  readonly ruleId: string;
  readonly eventUid: string;
  readonly incidentId?: string;
  readonly summary: string;
}

export interface SecurityEventSummary {
  readonly id: string;
  readonly occurredAt: string;
  readonly severity: Severity;
  readonly category: string;
  readonly source: string;
  readonly ruleId: string;
  readonly principal: string;
  readonly host: string;
  readonly summary: string;
}

export interface CaseSummary {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly state: 'open' | 'investigating' | 'contained' | 'resolved';
  readonly owner: string;
  readonly updatedAt: string;
}

export interface DetectionRuleSummary {
  readonly id: string;
  readonly name: string;
  readonly status: 'enabled' | 'draft' | 'review';
  readonly version: string;
  readonly hitsLast24h: number;
  readonly falsePositiveRate: number;
  readonly updatedAt: string;
}

export interface QuarantineRecord {
  readonly id: string;
  readonly source: string;
  readonly reason: string;
  readonly state: 'pending' | 'reprocessing' | 'recovered' | 'blocked';
  readonly attempts: number;
  readonly occurredAt: string;
}

export interface SessionSummary {
  readonly id: string;
  readonly actor: string;
  readonly role: AdminRole;
  readonly startedAt: string;
  readonly lastSeenAt: string;
  readonly state: 'active' | 'expired' | 'revoked';
}

export interface IncidentSummary {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly state:
    'open' | 'investigating' | 'containment' | 'eradication' | 'recovery' | 'resolved' | 'closed';
  readonly owner: string;
  readonly alertCount: number;
  readonly updatedAt: string;
}

export interface SourceSummary {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly status: OperationalStatus;
  readonly datasets: readonly string[];
  readonly lastSuccessfulRead: string | null;
  readonly replayCapability: 'bounded' | 'best_effort' | 'not_verified';
}

export interface AccessRequest {
  readonly id: string;
  readonly requester: string;
  readonly target: string;
  readonly requestedBundle: AdminRole;
  readonly scope: string;
  readonly reason: string;
  readonly state: 'pending_second_approver' | 'approved' | 'rejected';
  readonly submittedAt: string;
}

export interface AuditEventSummary {
  readonly id: string;
  readonly occurredAt: string;
  readonly actor: string;
  readonly action: string;
  readonly resource: string;
  readonly outcome: 'allowed' | 'denied' | 'pending';
  readonly correlationId: string;
}

export interface NotificationDelivery {
  readonly id: string;
  readonly destination: string;
  readonly severity: Severity;
  readonly state: 'delivered' | 'retrying' | 'failed';
  readonly attempts: number;
  readonly updatedAt: string;
  readonly alertId: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface PageQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

function pagePath(path: string, query: PageQuery): string {
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new RangeError('PAGE_LIMIT_OUT_OF_RANGE');
  }
  const parameters = new URLSearchParams({ limit: String(limit) });
  if (query.cursor) parameters.set('cursor', query.cursor);
  return `${path}?${parameters.toString()}`;
}

export interface AccessRequestInput {
  readonly target: string;
  readonly requestedBundle: AccessRequest['requestedBundle'];
  readonly scope: string;
  readonly reason: string;
}

export interface ReplayRequestInput {
  readonly sourceId: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

export interface OperationReceipt {
  readonly id: string;
  readonly state: 'accepted_for_review' | 'queued' | 'rejected';
  readonly message: string;
  readonly mode: DataMode;
}

/** Application port used by the console; both mock and future BFF adapters implement it. */
export interface AdminApi {
  getSession(signal?: AbortSignal): Promise<AdminSession>;
  getOverview(signal?: AbortSignal): Promise<PlatformOverview>;
  searchEvents(
    query: PageQuery & { readonly q?: string; readonly from: string; readonly to: string },
    signal?: AbortSignal,
  ): Promise<Page<SecurityEventSummary>>;
  getCases(query?: PageQuery, signal?: AbortSignal): Promise<Page<CaseSummary>>;
  getDetectionRules(query?: PageQuery, signal?: AbortSignal): Promise<Page<DetectionRuleSummary>>;
  getQuarantine(signal?: AbortSignal): Promise<readonly QuarantineRecord[]>;
  getSessions(signal?: AbortSignal): Promise<readonly SessionSummary[]>;
  reprocessQuarantine(recordId: string, reason: string): Promise<OperationReceipt>;
  getAlerts(query?: PageQuery, signal?: AbortSignal): Promise<Page<AlertSummary>>;
  getIncidents(query?: PageQuery, signal?: AbortSignal): Promise<Page<IncidentSummary>>;
  getSources(signal?: AbortSignal): Promise<readonly SourceSummary[]>;
  getServices(signal?: AbortSignal): Promise<readonly ServiceHealth[]>;
  getAccessRequests(query?: PageQuery, signal?: AbortSignal): Promise<Page<AccessRequest>>;
  getAuditEvents(query?: PageQuery, signal?: AbortSignal): Promise<Page<AuditEventSummary>>;
  getNotifications(signal?: AbortSignal): Promise<readonly NotificationDelivery[]>;
  submitAccessRequest(input: AccessRequestInput): Promise<AccessRequest>;
  requestReplay(input: ReplayRequestInput): Promise<OperationReceipt>;
  acknowledgeAlert(alertId: string): Promise<AlertSummary>;
  retryNotification(deliveryId: string): Promise<NotificationDelivery>;
  logout(): Promise<void>;
}

export class AdminApiError extends Error {
  public constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = 'AdminApiError';
  }
}

/**
 * Same-origin BFF adapter. The production BFF is not implemented yet; this client
 * is the contract boundary and expects an opaque HttpOnly cookie plus CSRF token.
 */
export class HttpAdminApi implements AdminApi {
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    if (method !== 'GET' && method !== 'HEAD') {
      const csrf = document.querySelector<HTMLMetaElement>('meta[name="qapaq-csrf"]')?.content;
      if (!csrf) throw new AdminApiError('CSRF_TOKEN_MISSING', 0);
      headers.set('x-csrf-token', csrf);
    }
    let response: Response;
    try {
      response = await fetch(path, {
        ...init,
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      });
    } catch {
      throw new AdminApiError('API_UNAVAILABLE', 0);
    }
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const code =
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { code?: unknown }).code === 'string'
          ? (body as { code: string }).code
          : `HTTP_${response.status}`;
      throw new AdminApiError(code, response.status);
    }
    return (await response.json()) as T;
  }

  public getSession(signal?: AbortSignal) {
    return this.request<AdminSession>(ADMIN_API.session, signal ? { signal } : {});
  }
  public getOverview(signal?: AbortSignal) {
    return this.request<PlatformOverview>(ADMIN_API.overview, signal ? { signal } : {});
  }
  public searchEvents(
    query: PageQuery & { readonly q?: string; readonly from: string; readonly to: string },
    signal?: AbortSignal,
  ) {
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new RangeError('PAGE_LIMIT_OUT_OF_RANGE');
    const from = new Date(query.from).getTime();
    const to = new Date(query.to).getTime();
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      to < from ||
      to - from > 90 * 86_400_000
    ) {
      throw new RangeError('EVENT_WINDOW_INVALID');
    }
    const parameters = new URLSearchParams({
      limit: String(limit),
      from: query.from,
      to: query.to,
    });
    if (query.cursor) parameters.set('cursor', query.cursor);
    if (query.q) parameters.set('q', query.q);
    return this.request<Page<SecurityEventSummary>>(
      `${ADMIN_API.events}?${parameters}`,
      signal ? { signal } : {},
    );
  }
  public getCases(query: PageQuery = {}, signal?: AbortSignal) {
    return this.request<Page<CaseSummary>>(
      pagePath(ADMIN_API.cases, query),
      signal ? { signal } : {},
    );
  }
  public getDetectionRules(query: PageQuery = {}, signal?: AbortSignal) {
    return this.request<Page<DetectionRuleSummary>>(
      pagePath(ADMIN_API.rules, query),
      signal ? { signal } : {},
    );
  }
  public getQuarantine(signal?: AbortSignal) {
    return this.request<readonly QuarantineRecord[]>(
      ADMIN_API.quarantine,
      signal ? { signal } : {},
    );
  }
  public getSessions(signal?: AbortSignal) {
    return this.request<readonly SessionSummary[]>(ADMIN_API.sessions, signal ? { signal } : {});
  }
  public reprocessQuarantine(recordId: string, reason: string) {
    return this.request<OperationReceipt>(
      `${ADMIN_API.quarantine}/${encodeURIComponent(recordId)}/reprocess`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      },
    );
  }
  public getAlerts(query: PageQuery = {}, signal?: AbortSignal) {
    return this.request<Page<AlertSummary>>(
      pagePath(ADMIN_API.alerts, query),
      signal ? { signal } : {},
    );
  }
  public getIncidents(query: PageQuery = {}, signal?: AbortSignal) {
    return this.request<Page<IncidentSummary>>(
      pagePath(ADMIN_API.incidents, query),
      signal ? { signal } : {},
    );
  }
  public getSources(signal?: AbortSignal) {
    return this.request<readonly SourceSummary[]>(ADMIN_API.sources, signal ? { signal } : {});
  }
  public getServices(signal?: AbortSignal) {
    return this.request<readonly ServiceHealth[]>(ADMIN_API.services, signal ? { signal } : {});
  }
  public getAccessRequests(query: PageQuery = {}, signal?: AbortSignal) {
    return this.request<Page<AccessRequest>>(
      pagePath(ADMIN_API.accessRequests, query),
      signal ? { signal } : {},
    );
  }
  public getAuditEvents(query: PageQuery = {}, signal?: AbortSignal) {
    return this.request<Page<AuditEventSummary>>(
      pagePath(ADMIN_API.auditEvents, query),
      signal ? { signal } : {},
    );
  }
  public getNotifications(signal?: AbortSignal) {
    return this.request<readonly NotificationDelivery[]>(
      ADMIN_API.notifications,
      signal ? { signal } : {},
    );
  }
  public submitAccessRequest(input: AccessRequestInput) {
    return this.request<AccessRequest>(ADMIN_API.accessRequests, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
  public requestReplay(input: ReplayRequestInput) {
    return this.request<OperationReceipt>(
      `${ADMIN_API.sources}/${encodeURIComponent(input.sourceId)}/replays`,
      {
        method: 'POST',
        body: JSON.stringify({ from: input.from, to: input.to, reason: input.reason }),
      },
    );
  }
  public acknowledgeAlert(alertId: string) {
    return this.request<AlertSummary>(
      `${ADMIN_API.alerts}/${encodeURIComponent(alertId)}/acknowledgement`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    );
  }
  public retryNotification(deliveryId: string) {
    return this.request<NotificationDelivery>(
      `${ADMIN_API.notifications}/${encodeURIComponent(deliveryId)}/retries`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    );
  }
  public async logout(): Promise<void> {
    await this.request<{ readonly status: 'ok' }>('/api/v1/session/logout', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }
}
