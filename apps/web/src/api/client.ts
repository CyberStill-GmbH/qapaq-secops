/**
 * C-21/C-27 — cliente HTTP de la consola.
 *
 * Tres decisiones:
 *
 * 1. **La cookie de sesión la gestiona el navegador** (`credentials: 'same-origin'`).
 *    La consola nunca guarda tokens ni los ve.
 * 2. **Todo fallo se normaliza** a la forma del catálogo de errores. Que el servicio esté
 *    caído, que responda 500 o que devuelva un cuerpo ilegible no son tres experiencias
 *    distintas para quien opera: son un mismo estado degradado con acción sugerida.
 * 3. **El `correlationId` se conserva y se muestra**. Es lo que permite que soporte
 *    encuentre el rastro de un error concreto.
 * 4. **Toda mutación lleva el token CSRF de la sesión** (`x-csrf-token`, B-01). Se obtiene
 *    de `GET /api/auth/session`, vive solo en memoria y se descarta al cerrar sesión.
 */

import { API_ERROR_CATALOG, type ApiErrorBody } from '@qapaq/contracts';

export type ApiResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: ApiErrorBody };

function offline(correlationId: string): ApiErrorBody {
  const definition = API_ERROR_CATALOG.DEPENDENCY_DEGRADED;
  return {
    code: definition.code,
    message: definition.publicMessage,
    action: definition.action,
    helpRef: definition.helpRef,
    retriable: definition.retriable,
    correlationId,
  };
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof (value as { code: unknown }).code === 'string' &&
    (value as { code: string }).code in API_ERROR_CATALOG
  );
}

let csrfToken: string | null = null;

function isMutation(init: RequestInit): boolean {
  const method = (init.method ?? 'GET').toUpperCase();
  return method !== 'GET' && method !== 'HEAD';
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const correlationId = globalThis.crypto?.randomUUID?.() ?? `fallback-${Date.now().toString(16)}`;
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'x-correlation-id': correlationId,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(isMutation(init) && csrfToken ? { 'x-csrf-token': csrfToken } : {}),
        ...init.headers,
      },
    });
  } catch {
    return { ok: false, error: offline(correlationId) };
  }
  if (response.status === 204) return { ok: true, data: undefined as T };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: offline(correlationId) };
  }
  if (response.ok) return { ok: true, data: body as T };
  return { ok: false, error: isApiErrorBody(body) ? body : offline(correlationId) };
}

export interface SessionView {
  readonly subjectId: string;
  readonly displayName?: string | null;
  readonly email?: string | null;
  readonly tenantId: string;
  readonly roles: readonly string[];
  readonly capabilities: readonly string[];
  readonly amr: readonly string[];
  readonly csrfToken: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly totalCount?: number;
}

export interface AlertView {
  readonly id: string;
  readonly title: string;
  readonly priority: string;
  readonly score: number;
  readonly status: string;
  readonly assigneeId: string | null;
  readonly verdict: string | null;
  readonly incidentId: string | null;
  readonly occurredAt: string;
  readonly revision: number;
  readonly reasons: readonly { readonly code: string; readonly detail: string }[];
  readonly entities?: readonly {
    readonly ref: string | null;
    readonly kind: 'user' | 'ip';
    readonly label: string;
  }[];
  readonly signal?:
    | 'credential_access'
    | 'initial_access'
    | 'persistence'
    | 'privilege_escalation'
    | 'defense_evasion'
    | 'collection'
    | 'exfiltration'
    | 'other'
    | null;
  readonly relatedAlertIds?: readonly string[];
  readonly rawRef?: string;
}

export type AlertStatus = 'new' | 'acknowledged' | 'triaged' | 'escalated' | 'closed';
export type TriageVerdict = 'true_positive' | 'false_positive' | 'benign' | 'duplicate';
export type IncidentStatus = 'open' | 'contained' | 'eradicated' | 'resolved' | 'closed';

export interface IncidentView {
  readonly id: string;
  readonly title: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low';
  readonly status: IncidentStatus;
  readonly ownerId: string;
  readonly alertIds: readonly string[];
  readonly summary: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly revision: number;
}

export interface IncidentAlertsPage {
  readonly correlationId: string;
  readonly incidentId: string;
  readonly items: readonly AlertView[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
  readonly unavailableCount: number;
  readonly truncated: boolean;
}

export type IncidentTaskStatus = 'open' | 'in_progress' | 'done' | 'cancelled';
export interface IncidentTaskView {
  readonly id: string;
  readonly incidentId: string;
  readonly title: string;
  readonly description: string;
  readonly status: IncidentTaskStatus;
  readonly required: boolean;
  readonly assigneeId: string | null;
  readonly dueAt: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly cancellationReason: string | null;
  readonly revision: number;
}
export interface IncidentNoteView {
  readonly id: string;
  readonly incidentId: string;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt: string;
  readonly correctsNoteId: string | null;
}
export interface IncidentTimelineEntry {
  readonly id: string;
  readonly kind:
    | 'incident.opened'
    | 'incident.transition'
    | 'incident.closed'
    | 'alert.linked'
    | 'task.created'
    | 'task.completed'
    | 'task.cancelled'
    | 'note.added';
  readonly at: string;
  readonly recordedAt: string;
  readonly timeSource: 'provider' | 'recorded';
  readonly actorId: string | null;
  readonly summary: string;
  readonly ref: { readonly type: string; readonly id: string };
}
export type IncidentTimelinePage = Page<IncidentTimelineEntry> & {
  readonly incidentId: string;
  readonly transitions: 'included' | 'partial' | 'requires_audit_read';
};

export interface SecurityEventView {
  readonly recordId: string;
  readonly eventUid: string;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly kind: string;
  readonly severity: string;
  readonly category: readonly string[];
  readonly outcome: string;
  readonly action: string | null;
  readonly title: string | null;
  readonly rule: { readonly id: string; readonly groups: readonly string[] } | null;
  readonly identities: readonly Readonly<Record<string, unknown>>[];
  readonly resources: readonly Readonly<Record<string, unknown>>[];
  readonly source: Readonly<Record<string, unknown>>;
  readonly extensions: Readonly<Record<string, unknown>> | null;
  readonly raw?: Readonly<Record<string, unknown>>;
}
export interface SecurityEventsPage {
  readonly correlationId: string;
  readonly status: 'ok' | 'disabled';
  readonly window: { readonly from: string; readonly to: string };
  readonly items: readonly SecurityEventView[];
  readonly unparsedCount: number;
  readonly nextCursor: string | null;
  readonly query?: { readonly grammar: 'qapaq-events-v1'; readonly canonical: string };
}
export interface PushConfigView {
  readonly enabled: boolean;
  readonly vapidPublicKey: string | null;
  readonly maximumDevices: number;
}
export interface PushDeviceView {
  readonly id: string;
  readonly label: string;
  readonly service: string;
  readonly createdAt: string;
  readonly lastSuccessAt: string | null;
}
export interface PushDevicesPage {
  readonly correlationId: string;
  readonly items: readonly PushDeviceView[];
}
export interface PendingPushView {
  readonly type: 'alert' | 'incident';
  readonly id: string;
  readonly title: string;
  readonly severity: string;
  readonly at: string;
  readonly url: string;
}
export interface ChangeView {
  readonly seq: string;
  readonly resource: { readonly type: string; readonly id: string };
  readonly kind: 'created' | 'updated';
  readonly at: string;
}
export interface ChangesPage {
  readonly correlationId: string;
  readonly cursor: string;
  readonly changes: readonly ChangeView[];
  readonly resync: boolean;
}

export interface NotificationView {
  readonly id: string;
  readonly status:
    'pending' | 'sending' | 'sent' | 'indeterminate' | 'fallback' | 'failed' | 'acknowledged';
  readonly channel: 'teams' | 'fallback_email' | 'manual_console';
  readonly attemptCount: number;
  readonly sentAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
  readonly lastFailureClass: 'transient' | 'permanent' | 'ambiguous' | null;
}

export type OperationsHealthStatus = 'OK' | 'NO_DATA' | 'STALE' | 'DEGRADED';

export interface OperationsHealthSummary {
  readonly status: OperationsHealthStatus;
  readonly checkedAt: string;
  readonly lastAlertAt: string | null;
  readonly alertFreshnessSeconds: number | null;
  readonly sourceCoverage: 'NO_DATA' | 'OK' | 'STALE' | 'DEGRADED';
}

export interface OperationsHealthSoc {
  readonly status: OperationsHealthStatus;
  readonly checkedAt: string;
  readonly degradedReasons: readonly string[];
  readonly persistence: 'memory' | 'postgres';
  readonly dispatcherRunning: boolean;
  readonly outbox: {
    readonly pending: number;
    readonly processing: number;
    readonly oldestPendingAgeSeconds: number | null;
  };
  readonly notifications: {
    readonly windowHours: number;
    readonly since: string;
    readonly byStatus: Readonly<Record<string, number>>;
  };
}

export interface OperationsHealthPlatform {
  readonly status: OperationsHealthStatus;
  readonly checkedAt: string;
  readonly degradedReasons: readonly string[];
  readonly uptimeSeconds: number | null;
  readonly memoryRssMb: number | null;
  readonly databaseLatencyMs: number | null;
  readonly nodeVersion: string | null;
}

export interface OperationsHealthView {
  readonly correlationId: string;
  readonly generatedAt: string;
  readonly status: OperationsHealthStatus;
  readonly sections: {
    readonly summary: OperationsHealthSummary;
    readonly soc?: OperationsHealthSoc;
    readonly platform?: OperationsHealthPlatform;
  };
}

export interface AuditEventView {
  readonly id: string;
  readonly sequence: string;
  readonly occurredAt: string;
  readonly actor: {
    readonly id: string;
    readonly type: string;
    readonly sessionId?: string;
    readonly ip?: string;
  };
  readonly action: string;
  readonly resource: { readonly type: string; readonly id: string };
  readonly outcome: string;
  readonly correlationId: string;
  readonly reason?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly hash: string;
  readonly previousHash: string;
}

export interface AuditIntegrityView {
  readonly ok: boolean;
  readonly checked: number;
  readonly headSequence: string;
  readonly violations: readonly {
    readonly code: string;
    readonly sequence: string;
    readonly detail: string;
  }[];
}

export type SocAdminRole =
  'qapaq.soc.analyst' | 'qapaq.soc.lead' | 'qapaq.auditor' | 'qapaq.platform.admin';

export interface SocAdminUser {
  readonly oid: string;
  readonly displayName: string | null;
  readonly upn: string | null;
  readonly accountEnabled: boolean | null;
  readonly membership: 'member' | 'removed' | null;
  readonly isOwner: boolean;
  readonly roles: readonly SocAdminRole[];
  readonly roleOrigin: 'group_owner' | 'deploy_binding' | 'entra_app_role' | 'none';
  readonly lastSeenAt: string | null;
  readonly activeSessions: number;
}

export interface SocAdminUserSession {
  readonly ref: string;
  readonly current: boolean;
  readonly state: 'active' | 'expired' | 'revoked' | 'superseded';
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly amr: readonly string[];
  readonly revocationReason?: string | null;
  readonly revision: number;
}

export interface AdminUsersSync {
  readonly mode: 'disabled' | 'graph';
  readonly status: 'never' | 'ok' | 'failed' | null;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastErrorClass: string | null;
  readonly stale: boolean;
}

export interface SourceHealthView {
  readonly sourceId: string;
  readonly dataset: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly state: 'unknown' | 'healthy' | 'degraded' | 'failed' | 'disabled';
  readonly reason:
    | 'DISABLED'
    | 'NO_OBSERVATIONS'
    | 'PERMANENT_ERROR'
    | 'NO_RECENT_SUCCESS'
    | 'CONSECUTIVE_FAILURES'
    | 'NEVER_SUCCEEDED'
    | 'RECENT_SUCCESS';
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastEventAt: string | null;
  readonly consecutiveFailures: number;
  readonly lastErrorClass: string | null;
  readonly policy: {
    readonly intervalMs: number;
    readonly degradeAfterMs: number;
    readonly failAfterMs: number;
  };
  readonly subscriptions: {
    readonly measuredAt: string;
    readonly windowHours: 24;
    readonly items: readonly {
      readonly stream: string;
      readonly lastEventAt: string | null;
      readonly eventsInWindow: number;
    }[];
  } | null;
  readonly transitions: readonly {
    readonly id: string;
    readonly fromState: string;
    readonly toState: string;
    readonly reason: string;
    readonly at: string;
  }[];
}

export interface AdminSessionRecord {
  readonly ref: string;
  readonly current: boolean;
  readonly subjectId: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly state: 'active' | 'expired' | 'revoked' | 'superseded';
  readonly roles: readonly string[];
  readonly amr: readonly string[];
  readonly clientIp: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly absoluteExpiresAt: string;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly revision: number;
}

async function session(): Promise<ApiResult<SessionView>> {
  const result = await apiFetch<SessionView>('/api/auth/session');
  csrfToken = result.ok ? result.data.csrfToken : null;
  return result;
}

async function logout(): Promise<ApiResult<void>> {
  const result = await apiFetch<void>('/api/auth/logout', { method: 'POST' });
  if (result.ok) csrfToken = null;
  return result;
}

export const api = {
  session,
  alerts: (cursor?: string) =>
    apiFetch<Page<AlertView>>(
      cursor ? `/api/alerts?cursor=${encodeURIComponent(cursor)}` : '/api/alerts',
    ),
  alert: (id: string) => apiFetch<{ alert: AlertView }>(`/api/alerts/${encodeURIComponent(id)}`),
  alertsByStatus: (
    status?: 'open' | AlertStatus,
    cursor?: string,
    search?: string,
    priority?: 'P1' | 'P2' | 'P3' | 'P4',
    entityRef?: string,
  ) => {
    const query = new URLSearchParams({ pageSize: '50' });
    if (status) query.set('status', status);
    if (cursor) query.set('cursor', cursor);
    if (search?.trim()) query.set('q', search.trim());
    if (priority) query.set('priority', priority);
    if (entityRef) query.set('entity', entityRef);
    return apiFetch<Page<AlertView>>(`/api/alerts?${query.toString()}`);
  },
  command: (id: string, body: Record<string, unknown>) =>
    apiFetch<{ alert: AlertView }>(`/api/alerts/${encodeURIComponent(id)}/commands`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  incident: (id: string) =>
    apiFetch<{ incident: IncidentView }>(`/api/incidents/${encodeURIComponent(id)}`),
  incidentAlerts: (id: string, cursor?: string) => {
    const query = new URLSearchParams({ pageSize: '50' });
    if (cursor) query.set('cursor', cursor);
    return apiFetch<IncidentAlertsPage>(
      `/api/incidents/${encodeURIComponent(id)}/alerts?${query.toString()}`,
    );
  },
  incidentTasks: (id: string, cursor?: string) => {
    const query = new URLSearchParams({ pageSize: '50' });
    if (cursor) query.set('cursor', cursor);
    return apiFetch<
      Page<IncidentTaskView> & { readonly incidentId: string; readonly openRequiredCount: number }
    >(`/api/incidents/${encodeURIComponent(id)}/tasks?${query.toString()}`);
  },
  createIncidentTask: (
    id: string,
    body: {
      readonly title: string;
      readonly required: boolean;
      readonly description?: string;
      readonly assigneeId?: string;
      readonly dueAt?: string;
    },
  ) =>
    apiFetch<{ readonly task: IncidentTaskView }>(
      `/api/incidents/${encodeURIComponent(id)}/tasks`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  incidentTaskCommand: (incidentId: string, taskId: string, body: Record<string, unknown>) =>
    apiFetch<{ readonly task: IncidentTaskView }>(
      `/api/incidents/${encodeURIComponent(incidentId)}/tasks/${encodeURIComponent(taskId)}/commands`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  incidentNotes: (id: string, cursor?: string) => {
    const query = new URLSearchParams({ pageSize: '50' });
    if (cursor) query.set('cursor', cursor);
    return apiFetch<Page<IncidentNoteView> & { readonly incidentId: string }>(
      `/api/incidents/${encodeURIComponent(id)}/notes?${query.toString()}`,
    );
  },
  addIncidentNote: (
    id: string,
    body: { readonly body: string; readonly correctsNoteId?: string },
  ) =>
    apiFetch<{ readonly note: IncidentNoteView }>(
      `/api/incidents/${encodeURIComponent(id)}/notes`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  incidentTimeline: (id: string, cursor?: string) => {
    const query = new URLSearchParams({ pageSize: '50' });
    if (cursor) query.set('cursor', cursor);
    return apiFetch<IncidentTimelinePage>(
      `/api/incidents/${encodeURIComponent(id)}/timeline?${query.toString()}`,
    );
  },
  events: (
    filters: {
      readonly from: string;
      readonly to: string;
      readonly severity?: readonly string[];
      readonly category?: readonly string[];
      readonly outcome?: 'success' | 'failure';
      readonly q?: string;
      readonly cursor?: string;
      readonly pageSize?: number;
    },
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({ from: filters.from, to: filters.to });
    if (filters.q !== undefined) query.set('q', filters.q);
    else {
      if (filters.severity?.length) query.set('severity', filters.severity.join(','));
      if (filters.category?.length) query.set('category', filters.category.join(','));
      if (filters.outcome) query.set('outcome', filters.outcome);
    }
    if (filters.cursor) query.set('cursor', filters.cursor);
    if (filters.pageSize) query.set('pageSize', String(filters.pageSize));
    return apiFetch<SecurityEventsPage>(
      `/api/events?${query.toString()}`,
      signal ? { signal } : {},
    );
  },
  changes: (after?: string, signal?: AbortSignal) => {
    const query = after ? `?after=${encodeURIComponent(after)}` : '';
    return apiFetch<ChangesPage>(`/api/changes${query}`, signal ? { signal } : {});
  },
  incidents: (cursor?: string, status?: string, search?: string) => {
    const query = new URLSearchParams({ pageSize: '50' });
    if (cursor) query.set('cursor', cursor);
    if (status) query.set('status', status);
    if (search?.trim()) query.set('q', search.trim());
    return apiFetch<Page<IncidentView>>(`/api/incidents?${query.toString()}`);
  },
  createIncident: (body: {
    readonly alertId: string;
    readonly title: string;
    readonly severity: 'critical' | 'high' | 'medium' | 'low';
    readonly summary: string;
    readonly expectedAlertRevision: number;
  }) =>
    apiFetch<{ incident: IncidentView }>('/api/incidents', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  incidentCommand: (id: string, body: Record<string, unknown>) =>
    apiFetch<{ incident: IncidentView }>(`/api/incidents/${encodeURIComponent(id)}/commands`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  notifications: (cursor?: string) => {
    const query = new URLSearchParams({ pageSize: '50' });
    if (cursor) query.set('cursor', cursor);
    return apiFetch<Page<NotificationView>>(`/api/notifications?${query.toString()}`);
  },
  acknowledgeNotification: (id: string) =>
    apiFetch<{ status: 'acknowledged' }>(
      `/api/notifications/${encodeURIComponent(id)}/acknowledge`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    ),
  dispatchNotifications: () =>
    apiFetch<{ correlationId: string; results: readonly string[] }>('/api/notifications/drain', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  audit: (
    from: string,
    to: string,
    action?: string,
    filters: {
      readonly cursor?: string;
      readonly actorId?: string;
      readonly resourceType?: string;
      readonly resourceId?: string;
      readonly outcome?: string;
    } = {},
  ) => {
    const query = new URLSearchParams({ from, to, pageSize: '50' });
    if (action) query.set('action', action);
    if (filters.cursor) query.set('cursor', filters.cursor);
    if (filters.actorId?.trim()) query.set('actorId', filters.actorId.trim());
    if (filters.resourceType) query.set('resourceType', filters.resourceType);
    if (filters.resourceId?.trim()) query.set('resourceId', filters.resourceId.trim());
    if (filters.outcome) query.set('outcome', filters.outcome);
    return apiFetch<Page<AuditEventView>>(`/api/audit/events?${query.toString()}`);
  },
  verifyAudit: () => apiFetch<AuditIntegrityView>('/api/audit/verify'),
  adminUsers: () =>
    apiFetch<{
      readonly correlationId: string;
      readonly sync: AdminUsersSync;
      readonly items: readonly SocAdminUser[];
      readonly totalCount: number;
    }>('/api/admin/users'),
  adminUser: (oid: string) =>
    apiFetch<{
      readonly correlationId: string;
      readonly user: SocAdminUser;
      readonly sessions: readonly SocAdminUserSession[];
    }>(`/api/admin/users/${encodeURIComponent(oid)}`),
  adminSessions: (cursor?: string) => {
    const parameters = new URLSearchParams({ pageSize: '50' });
    if (cursor) parameters.set('cursor', cursor);
    return apiFetch<{
      readonly correlationId: string;
      readonly windowDays: number;
      readonly items: readonly AdminSessionRecord[];
      readonly nextCursor: string | null;
      readonly totalCount: number;
    }>(`/api/admin/sessions?${parameters.toString()}`);
  },
  revokeSession: (reference: string, reason: string, expectedRevision: number) =>
    apiFetch<{ readonly correlationId: string; readonly session: AdminSessionRecord }>(
      `/api/admin/sessions/${encodeURIComponent(reference)}/revoke`,
      { method: 'POST', body: JSON.stringify({ reason, expectedRevision }) },
    ),
  health: () => apiFetch<{ status: 'ok' | 'unavailable'; service: string }>('/api/health/ready'),
  operationsHealth: () => apiFetch<OperationsHealthView>('/api/operations/health'),
  sourcesHealth: () =>
    apiFetch<{
      readonly correlationId: string;
      readonly checkedAt: string;
      readonly sources: readonly SourceHealthView[];
    }>('/api/sources/health'),
  pushConfig: () => apiFetch<PushConfigView>('/api/me/push/config'),
  pushDevices: () => apiFetch<PushDevicesPage>('/api/me/push/subscriptions'),
  registerPushDevice: (body: {
    readonly endpoint: string;
    readonly keys: { readonly p256dh: string; readonly auth: string };
    readonly label: string;
  }) =>
    apiFetch<{
      readonly correlationId: string;
      readonly subscription: { readonly id: string; readonly label: string };
    }>('/api/me/push/subscriptions', { method: 'POST', body: JSON.stringify(body) }),
  revokePushDevice: (id: string) =>
    apiFetch<{ readonly correlationId: string; readonly revoked: boolean }>(
      `/api/me/push/subscriptions/${encodeURIComponent(id)}/revoke`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  sendPushTest: () =>
    apiFetch<{ readonly correlationId: string; readonly delivered: number }>('/api/me/push/test', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  logout,
};
