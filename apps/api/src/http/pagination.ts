/**
 * B-02 — paginación por cursor de los listados del BFF (ADR-016).
 *
 * Paginación por clave (*keyset*), no por desplazamiento: el cursor guarda la posición
 * del último elemento entregado (instante + id), de modo que una alerta nueva que llega
 * entre dos páginas no desplaza ni duplica filas.
 *
 * El cursor es opaco para el cliente y queda atado al listado y a su filtro: reutilizarlo
 * en otra consulta se rechaza en lugar de devolver una página que no corresponde. No
 * concede acceso a nada: el filtro por tenant y capability se aplica antes de paginar.
 * Un tamaño mayor al máximo se rechaza, no se recorta.
 */

import { ApiError } from './api-error.js';

export const PAGE_LIMITS = Object.freeze({ defaultSize: 50, maximumSize: 200 });

export interface PageQuery {
  readonly pageSize?: string;
  readonly cursor?: string;
}

export interface PageKey {
  readonly at: number;
  readonly id: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

interface CursorPayload {
  readonly v: 1;
  readonly s: string;
  readonly t: number;
  readonly i: string;
}

const MAX_CURSOR_LENGTH = 1024;

function pageSizeOf(raw: string | undefined, correlationId: string): number {
  if (raw === undefined || raw === '') return PAGE_LIMITS.defaultSize;
  const size = /^\d{1,4}$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(size) || size < 1 || size > PAGE_LIMITS.maximumSize) {
    throw new ApiError('VALIDATION_FAILED', correlationId, ['pageSize']);
  }
  return size;
}

function decodeCursor(raw: string, scope: string, correlationId: string): PageKey {
  const invalid = () => new ApiError('VALIDATION_FAILED', correlationId, ['cursor']);
  if (raw.length > MAX_CURSOR_LENGTH) throw invalid();
  let payload: Partial<CursorPayload>;
  try {
    payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as CursorPayload;
  } catch {
    throw invalid();
  }
  if (
    payload.v !== 1 ||
    payload.s !== scope ||
    typeof payload.t !== 'number' ||
    !Number.isFinite(payload.t) ||
    typeof payload.i !== 'string'
  ) {
    throw invalid();
  }
  return { at: payload.t, id: payload.i };
}

function encodeCursor(scope: string, key: PageKey): string {
  const payload: CursorPayload = { v: 1, s: scope, t: key.at, i: key.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Más reciente primero; a igual instante, el id desempata para que el orden sea total. */
function newestFirst(left: PageKey, right: PageKey): number {
  if (left.at !== right.at) return right.at - left.at;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

/**
 * `scope` identifica el listado y su filtro (por ejemplo `alerts:status=new`). Las filas
 * llegan ya filtradas por tenant y autorización; aquí solo se ordenan y se cortan.
 */
export function paginate<T>(
  rows: readonly T[],
  keyOf: (row: T) => PageKey,
  query: PageQuery,
  scope: string,
  correlationId: string,
): Page<T> {
  const size = pageSizeOf(query.pageSize, correlationId);
  const after = query.cursor ? decodeCursor(query.cursor, scope, correlationId) : undefined;
  const ordered = [...rows].sort((left, right) => newestFirst(keyOf(left), keyOf(right)));
  const remaining = after ? ordered.filter((row) => newestFirst(after, keyOf(row)) < 0) : ordered;
  const items = remaining.slice(0, size);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      remaining.length > size && last !== undefined ? encodeCursor(scope, keyOf(last)) : null,
  };
}
