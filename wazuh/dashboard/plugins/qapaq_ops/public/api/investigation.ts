/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import {
  entityKey,
  EntityKind,
  EventResponse,
  INVESTIGATION_ROUTES,
  RelatedResponse,
  RelatedWindow,
  SourceResponse,
} from '../../common';
import { QapaqApiError } from './client';

/**
 * Rutas de investigación del propio plugin en OSD: el servidor del dashboard consulta
 * `wazuh-alerts-*` con la identidad de quien mira (proxy auth). Como `fetchOverview`.
 */
async function getJson<T>(
  basePath: string,
  path: string,
  params: URLSearchParams,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${basePath}${path}?${params.toString()}`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'osd-xsrf': 'true' },
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
  } catch {
    if (signal?.aborted) throw new DOMException('Solicitud cancelada', 'AbortError');
    throw new QapaqApiError('DEPENDENCY_DEGRADED', 0, null);
  }
  if (!response.ok) {
    throw new QapaqApiError(
      response.status === 401
        ? 'AUTH_REQUIRED'
        : response.status === 400
          ? 'VALIDATION_FAILED'
          : 'DEPENDENCY_DEGRADED',
      response.status,
      null,
    );
  }
  return (await response.json()) as T;
}

const defaultFetch: typeof fetch = (...args) => window.fetch(...args);

export function fetchSource(
  basePath: string,
  query: { id?: string; ruleId?: string | null; at?: string; description?: string },
  fetchImpl: typeof fetch = defaultFetch,
): Promise<SourceResponse> {
  const params = new URLSearchParams();
  if (query.id) params.set('id', query.id);
  if (query.ruleId) params.set('ruleId', query.ruleId);
  if (query.at) params.set('at', query.at);
  if (query.description) params.set('description', query.description.slice(0, 400));
  return getJson(basePath, INVESTIGATION_ROUTES.source, params, fetchImpl);
}

export function fetchEvent(
  basePath: string,
  id: string,
  fetchImpl: typeof fetch = defaultFetch,
): Promise<EventResponse> {
  return getJson(basePath, INVESTIGATION_ROUTES.event, new URLSearchParams({ id }), fetchImpl);
}

export function fetchRelated(
  basePath: string,
  query: {
    entities: ReadonlyArray<{ kind: EntityKind; value: string }>;
    at: string;
    window: RelatedWindow;
    exclude?: string;
    cursor?: string;
  },
  fetchImpl: typeof fetch = defaultFetch,
  signal?: AbortSignal,
): Promise<RelatedResponse> {
  const params = new URLSearchParams();
  for (const entity of query.entities) params.append('e', entityKey(entity));
  params.set('at', query.at);
  params.set('window', query.window);
  if (query.exclude) params.set('exclude', query.exclude);
  if (query.cursor) params.set('cursor', query.cursor);
  return getJson(basePath, INVESTIGATION_ROUTES.related, params, fetchImpl, signal);
}

/** Riesgo de entidad del motor de correlación (opcional). */
export interface EntityRisk {
  readonly score: number;
  /** Referencia opaca `ent_…` para `GET {apiPrefix}/risk/entities/{type}/{ref}`. */
  readonly ref: string | null;
  readonly lastSeen?: string;
}

/** Tipos de entidad del correlador QAPAQ (`apps/api/src/soc/risk.controller.ts`). */
const RISK_TYPES: Partial<Record<EntityKind, string>> = { user: 'user', host: 'host', ip: 'ip' };
const riskLists = new Map<
  string,
  { at: number; items: Promise<ReadonlyArray<Record<string, unknown>>> }
>();
const RISK_TTL_MS = 60000;

async function riskList(
  apiPrefix: string,
  type: string,
  fetchImpl: typeof fetch,
): Promise<ReadonlyArray<Record<string, unknown>>> {
  const cached = riskLists.get(type);
  if (cached && Date.now() - cached.at < RISK_TTL_MS) return cached.items;
  const items = (async () => {
    const response = await fetchImpl(`${apiPrefix}/risk/entities?top=100&type=${type}`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return [];
    const body = (await response.json()) as { items?: unknown };
    return Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>) : [];
  })().catch(() => []);
  riskLists.set(type, { at: Date.now(), items });
  return items;
}

/**
 * Riesgo de una entidad según el motor de correlación (`/api/risk/entities`). La API solo acepta
 * referencias opacas en la URL (D-10b), así que se busca la entidad por su `label` en el top 100
 * de su tipo (el valor viaja en el cuerpo, nunca en la URL). Si el motor no está desplegado, la
 * ruta falla o la entidad no tiene puntuación, devuelve `null` y la UI no muestra el chip.
 */
export async function fetchEntityRisk(
  apiPrefix: string,
  kind: EntityKind,
  value: string,
  fetchImpl: typeof fetch = defaultFetch,
): Promise<EntityRisk | null> {
  const type = RISK_TYPES[kind];
  if (!type) return null;
  try {
    const items = await riskList(apiPrefix, type, fetchImpl);
    const wanted = value.toLowerCase();
    const item = items.find((entry) => String(entry.label ?? '').toLowerCase() === wanted);
    const score = Number(item?.score);
    if (!item || !Number.isFinite(score)) return null;
    return {
      score,
      ref: typeof item.ref === 'string' ? item.ref : null,
      lastSeen: typeof item.lastSeen === 'string' ? item.lastSeen : undefined,
    };
  } catch {
    return null;
  }
}
