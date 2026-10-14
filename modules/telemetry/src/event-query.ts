/**
 * C-14 — modelo de consulta tipado y autorizable.
 *
 * Dominio puro. Dos invariantes que no se negocian:
 *
 * 1. **Deny por defecto** (ADR-009): sin la capability correspondiente no hay resultado,
 *    y la ausencia de permiso se resuelve antes de tocar cualquier índice.
 * 2. **`raw` oculto por defecto** (ADR-018): la referencia al objeto crudo solo viaja al
 *    lector que tiene capability explícita para verla. No basta con poder leer eventos.
 */

import type { Raw, SecurityEvent } from '@qapaq/contracts';
import {
  NORMALIZED_SEVERITIES,
  SECURITY_EVENT_CATEGORIES,
  SECURITY_EVENT_KINDS,
  SECURITY_EVENT_OUTCOMES,
} from '@qapaq/contracts';

/** Límites canónicos de ADR-016 / `docs/reference/toolchain-and-capacity.md`. */
export const QUERY_LIMITS = Object.freeze({
  defaultPageSize: 50,
  maximumPageSize: 200,
  /** Una consulta sin ventana acotada degenera en un barrido del índice completo. */
  maximumRangeDays: 90,
});

export const EVENTS_READ = 'events.read' as const;
export const EVENTS_READ_RAW = 'events.read_raw' as const;

export const QUERY_ERROR_CODES = [
  'UNAUTHORIZED',
  'TENANT_REQUIRED',
  'PAGE_SIZE_INVALID',
  'PAGE_SIZE_EXCEEDED',
  'RANGE_REQUIRED',
  'RANGE_INVERTED',
  'RANGE_TOO_WIDE',
  'FILTER_VALUE_UNKNOWN',
] as const;

export type QueryErrorCode = (typeof QUERY_ERROR_CODES)[number];

export interface QueryRejection {
  readonly code: QueryErrorCode;
  readonly field: string;
}

export interface ReaderContext {
  readonly tenantId: string;
  readonly capabilities: ReadonlySet<string>;
}

export interface RawEventQuery {
  readonly from?: string;
  readonly to?: string;
  readonly pageSize?: number;
  readonly cursor?: string;
  readonly severity?: readonly string[];
  readonly category?: readonly string[];
  readonly kind?: readonly string[];
  readonly outcome?: readonly string[];
  readonly dataset?: string;
}

export interface EventQuery {
  readonly tenantId: string;
  readonly from: Date;
  readonly to: Date;
  readonly pageSize: number;
  readonly cursor: string | null;
  readonly severity: readonly string[];
  readonly category: readonly string[];
  readonly kind: readonly string[];
  readonly outcome: readonly string[];
  readonly dataset: string | null;
  /** Resuelto en la autorización, no en la consulta: el índice no decide quién ve el crudo. */
  readonly includeRaw: boolean;
}

export type QueryPlan =
  | { readonly ok: true; readonly query: EventQuery }
  | { readonly ok: false; readonly rejection: QueryRejection };

function reject(code: QueryErrorCode, field: string): QueryPlan {
  return { ok: false, rejection: { code, field } };
}

function validateEnum(
  values: readonly string[] | undefined,
  allowed: readonly string[],
): readonly string[] | 'invalid' {
  if (values === undefined) return [];
  for (const value of values) if (!allowed.includes(value)) return 'invalid';
  return [...new Set(values)];
}

/**
 * Traduce una petición sin confianza en una consulta ejecutable, o la rechaza con un
 * código estable. Nunca lanza y nunca corrige en silencio: un tamaño de página mayor al
 * permitido se rechaza en vez de recortarse, para que el llamante sepa que no recibió lo
 * que pidió.
 */
export function planQuery(input: RawEventQuery, reader: ReaderContext): QueryPlan {
  if (!reader.capabilities.has(EVENTS_READ)) return reject('UNAUTHORIZED', 'capabilities');
  if (!reader.tenantId) return reject('TENANT_REQUIRED', 'tenantId');

  if (input.from === undefined || input.to === undefined) return reject('RANGE_REQUIRED', 'range');
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    return reject('RANGE_REQUIRED', 'range');
  }
  if (from.getTime() > to.getTime()) return reject('RANGE_INVERTED', 'range');
  const spanDays = (to.getTime() - from.getTime()) / 86_400_000;
  if (spanDays > QUERY_LIMITS.maximumRangeDays) return reject('RANGE_TOO_WIDE', 'range');

  const pageSize = input.pageSize ?? QUERY_LIMITS.defaultPageSize;
  if (!Number.isInteger(pageSize) || pageSize < 1) return reject('PAGE_SIZE_INVALID', 'pageSize');
  if (pageSize > QUERY_LIMITS.maximumPageSize) return reject('PAGE_SIZE_EXCEEDED', 'pageSize');

  const severity = validateEnum(input.severity, NORMALIZED_SEVERITIES);
  if (severity === 'invalid') return reject('FILTER_VALUE_UNKNOWN', 'severity');
  const category = validateEnum(input.category, SECURITY_EVENT_CATEGORIES);
  if (category === 'invalid') return reject('FILTER_VALUE_UNKNOWN', 'category');
  const kind = validateEnum(input.kind, SECURITY_EVENT_KINDS);
  if (kind === 'invalid') return reject('FILTER_VALUE_UNKNOWN', 'kind');
  const outcome = validateEnum(input.outcome, SECURITY_EVENT_OUTCOMES);
  if (outcome === 'invalid') return reject('FILTER_VALUE_UNKNOWN', 'outcome');

  return {
    ok: true,
    query: {
      // El tenant sale del lector autenticado, nunca de la petición: así una consulta no
      // puede pedir los eventos de otro.
      tenantId: reader.tenantId,
      from,
      to,
      pageSize,
      cursor: input.cursor ?? null,
      severity,
      category,
      kind,
      outcome,
      dataset: input.dataset ?? null,
      includeRaw: reader.capabilities.has(EVENTS_READ_RAW),
    },
  };
}

export type ReadableEvent = Omit<SecurityEvent, 'raw'> & { readonly raw?: Raw };

/**
 * Da forma a un evento para el lector. Sin capability de crudo, la referencia se elimina
 * del documento entregado: no se vacía ni se enmascara, desaparece.
 */
export function shapeEventForReader(event: SecurityEvent, query: EventQuery): ReadableEvent {
  if (query.includeRaw) return event;
  const { raw: _raw, ...withoutRaw } = event;
  return withoutRaw;
}

export interface EventPage {
  readonly events: readonly ReadableEvent[];
  readonly nextCursor: string | null;
  readonly pageSize: number;
}

export function shapePage(
  events: readonly SecurityEvent[],
  query: EventQuery,
  nextCursor: string | null,
): EventPage {
  return {
    events: Object.freeze(events.map((event) => shapeEventForReader(event, query))),
    nextCursor,
    pageSize: query.pageSize,
  };
}
