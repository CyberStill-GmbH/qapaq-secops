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
  readonly displayName: string;
  readonly upn: string;
  readonly accountEnabled: boolean;
  readonly membership: 'member' | 'pending_removal';
  readonly grantStatus: 'active' | 'none' | 'suspended';
  readonly roles: readonly SocAdminRole[];
  readonly capabilities: readonly string[];
  readonly lastSignInAt: string | null;
  readonly lastSeenAt: string | null;
  readonly presence: 'active_recently' | 'seen' | 'no_session' | 'unknown';
  readonly activeSessions: number;
  readonly revision: number;
}

export interface SocAdminSession {
  readonly id: string;
  readonly startedAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly amr: readonly string[];
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

export interface SocRoleRequestReceipt {
  readonly requestId: string;
  readonly state: 'pending_approval';
  readonly correlationId: string;
}

export interface SocRoleRequestView {
  readonly id: string;
  readonly targetOid: string;
  readonly targetDisplayName: string;
  readonly targetUpn: string;
  readonly action: 'grant' | 'revoke';
  readonly role: SocAdminRole;
  readonly reason: string;
  readonly ticket: string | null;
  readonly requester: string;
  readonly requesterOid: string;
  readonly approvalStage: 'access' | 'security';
  readonly priorApproverOid: string | null;
  readonly submittedAt: string;
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
  adminUsers: (
    query: {
      readonly q?: string;
      readonly status?: string;
      readonly cursor?: string;
    } = {},
  ) => {
    const parameters = new URLSearchParams({ pageSize: '50' });
    if (query.q?.trim()) parameters.set('q', query.q.trim());
    if (query.status) parameters.set('status', query.status);
    if (query.cursor) parameters.set('cursor', query.cursor);
    return apiFetch<
      Page<SocAdminUser> & {
        readonly lastDirectorySyncAt: string | null;
        readonly syncStale: boolean;
        readonly presenceThresholdMinutes: number;
      }
    >(`/api/admin/users?${parameters.toString()}`);
  },
  adminUserSessions: (oid: string, cursor?: string) => {
    const parameters = new URLSearchParams({ pageSize: '50' });
    if (cursor) parameters.set('cursor', cursor);
    return apiFetch<Page<SocAdminSession>>(
      `/api/admin/users/${encodeURIComponent(oid)}/sessions?${parameters.toString()}`,
    );
  },
  requestRoleChange: (
    oid: string,
    body: {
      readonly action: 'grant' | 'revoke';
      readonly role: SocAdminRole;
      readonly reason: string;
      readonly ticket?: string;
      readonly expectedRevision: number;
    },
  ) =>
    apiFetch<SocRoleRequestReceipt>(`/api/admin/users/${encodeURIComponent(oid)}/role-requests`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  revokeAdminSession: (oid: string, sessionId: string, reason: string) =>
    apiFetch<{ readonly correlationId: string; readonly session: SocAdminSession }>(
      `/api/admin/users/${encodeURIComponent(oid)}/sessions/${encodeURIComponent(sessionId)}/revoke`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),
  setAdminUserSuspended: (
    oid: string,
    suspended: boolean,
    reason: string,
    expectedRevision: number,
  ) =>
    apiFetch<{ readonly correlationId: string; readonly user: SocAdminUser }>(
      `/api/admin/users/${encodeURIComponent(oid)}/${suspended ? 'suspend' : 'restore'}`,
      { method: 'POST', body: JSON.stringify({ reason, expectedRevision }) },
    ),
  adminRoleRequests: (cursor?: string) => {
    const parameters = new URLSearchParams({ status: 'pending', pageSize: '50' });
    if (cursor) parameters.set('cursor', cursor);
    return apiFetch<Page<SocRoleRequestView>>(`/api/admin/role-requests?${parameters.toString()}`);
  },
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
  decideAdminRoleRequest: (
    requestId: string,
    decision: 'approve' | 'reject',
    reason: string,
    expectedRevision: number,
  ) =>
    apiFetch<{ readonly correlationId: string; readonly status: 'approved' | 'rejected' }>(
      `/api/admin/role-requests/${encodeURIComponent(requestId)}/${decision}`,
      { method: 'POST', body: JSON.stringify({ reason, expectedRevision }) },
    ),
  health: () => apiFetch<{ status: 'ok' | 'unavailable'; service: string }>('/api/health/ready'),
  operationsHealth: () => apiFetch<OperationsHealthView>('/api/operations/health'),
  logout,
};
