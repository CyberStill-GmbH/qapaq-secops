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
  readonly tenantId: string;
  readonly roles: readonly string[];
  readonly capabilities: readonly string[];
  readonly amr: readonly string[];
  readonly csrfToken: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
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
  alertsByStatus: (status?: AlertStatus, cursor?: string) => {
    const query = new URLSearchParams({ pageSize: '50' });
    if (status) query.set('status', status);
    if (cursor) query.set('cursor', cursor);
    return apiFetch<Page<AlertView>>(`/api/alerts?${query.toString()}`);
  },
  command: (id: string, body: Record<string, unknown>) =>
    apiFetch<{ alert: AlertView }>(`/api/alerts/${encodeURIComponent(id)}/commands`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  incidents: (cursor?: string) => {
    const query = new URLSearchParams({ pageSize: '50' });
    if (cursor) query.set('cursor', cursor);
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
  audit: (from: string, to: string, action?: string) => {
    const query = new URLSearchParams({ from, to, pageSize: '50' });
    if (action) query.set('action', action);
    return apiFetch<Page<AuditEventView>>(`/api/audit/events?${query.toString()}`);
  },
  verifyAudit: () => apiFetch<AuditIntegrityView>('/api/audit/verify'),
  health: () => apiFetch<{ status: 'ok' | 'unavailable'; service: string }>('/api/health/ready'),
  logout,
};
