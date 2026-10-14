/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import {
  API_ERROR_CODES,
  API_ERROR_MESSAGE,
  ApiErrorBody,
  ApiErrorCode,
  LOGIN_PATH,
  SessionInfo,
} from '../../common';

/**
 * Cliente de la API de QAPAQ SecOps desde el navegador.
 *
 * Mismo origen que el dashboard: la cookie `qapaq_session` (HttpOnly) viaja sola y las
 * mutaciones llevan `x-csrf-token` de la sesión. No usa `core.http` porque la API no vive
 * bajo el basePath de OSD ni acepta sus cabeceras (`osd-xsrf`, `osd-version`).
 */

export class QapaqApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    public readonly status: number,
    public readonly correlationId: string | null,
    public readonly fields: readonly string[] = [],
  ) {
    super(API_ERROR_MESSAGE[code]);
    this.name = 'QapaqApiError';
  }
}

export type Query = Record<string, string | number | readonly string[] | undefined | null>;

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (API_ERROR_CODES as readonly string[]).includes(value);
}

/** El código del catálogo decide; un cuerpo ajeno (proxy, HTML) se clasifica por estado. */
function errorFrom(status: number, body: unknown): QapaqApiError {
  const parsed = (body ?? {}) as Partial<ApiErrorBody>;
  if (isApiErrorCode(parsed.code)) {
    return new QapaqApiError(
      parsed.code,
      status,
      parsed.correlationId ?? null,
      parsed.fields ?? [],
    );
  }
  const code: ApiErrorCode =
    status === 401
      ? 'AUTH_REQUIRED'
      : status === 403
        ? 'REQUEST_NOT_VERIFIED'
        : status === 404
          ? 'RESOURCE_UNAVAILABLE'
          : status === 409
            ? 'STATE_CONFLICT'
            : status === 422
              ? 'VALIDATION_FAILED'
              : status === 429
                ? 'RATE_LIMITED'
                : status === 502 || status === 503 || status === 504
                  ? 'DEPENDENCY_DEGRADED'
                  : 'INTERNAL_ERROR';
  return new QapaqApiError(code, status, null);
}

export function buildQuery(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(','));
    } else {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export interface QapaqApiClientOptions {
  readonly apiPrefix: string;
  readonly basePath: string;
  readonly fetchImpl?: typeof fetch;
  /** Navegación al login QAPAQ cuando la sesión no existe o expiró. */
  readonly redirect?: (url: string) => void;
  readonly currentUrl?: () => string;
}

export class QapaqApiClient {
  private sessionPromise: Promise<SessionInfo> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: QapaqApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => window.fetch(...args));
  }

  /** Sesión QAPAQ (persona, roles, capacidades y token CSRF). Se cachea por montaje. */
  public session(): Promise<SessionInfo> {
    if (!this.sessionPromise) {
      this.sessionPromise = this.request<SessionInfo>('GET', '/auth/session').catch((error) => {
        this.sessionPromise = null;
        throw error;
      });
    }
    return this.sessionPromise;
  }

  public get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', `${path}${buildQuery(query)}`);
  }

  public async post<T>(path: string, body?: unknown): Promise<T> {
    const session = await this.session();
    return this.request<T>('POST', path, body, session.csrfToken);
  }

  public loginUrl(): string {
    const current =
      this.options.currentUrl?.() ??
      `${window.location.pathname}${window.location.search}${window.location.hash}`;
    return `${this.options.basePath}${LOGIN_PATH}?nextUrl=${encodeURIComponent(current)}`;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    csrfToken?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.apiPrefix}${path}`, {
        method,
        headers,
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new QapaqApiError('DEPENDENCY_DEGRADED', 0, null);
    }
    if (response.status === 204) return undefined as unknown as T;
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const error = errorFrom(response.status, parsed);
      if (error.code === 'AUTH_REQUIRED' || error.code === 'SESSION_EXPIRED') {
        this.sessionPromise = null;
        this.options.redirect?.(this.loginUrl());
      }
      throw error;
    }
    return parsed as T;
  }
}
