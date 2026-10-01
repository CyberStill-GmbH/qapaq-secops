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

export const api = {
  session: () => apiFetch<SessionView>('/api/auth/session'),
  alerts: () => apiFetch<{ items: readonly AlertView[] }>('/api/alerts'),
  alert: (id: string) => apiFetch<{ alert: AlertView }>(`/api/alerts/${encodeURIComponent(id)}`),
  command: (id: string, body: Record<string, unknown>) =>
    apiFetch<{ alert: AlertView }>(`/api/alerts/${encodeURIComponent(id)}/commands`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  logout: () => apiFetch<void>('/api/auth/logout', { method: 'POST' }),
};
