/**
 * Sprint 5 · fase 1 — `GET /api/events`: explorador de eventos sobre el Indexer (S5-D5).
 *
 * Lectura directa: QAPAQ no guarda copia; Wazuh sigue siendo el dueño de la telemetría.
 *
 * - Exige `events.read`. El documento original (`raw`) solo viaja con `events.read_raw`.
 * - Rango: `from`/`to` ISO 8601 (por defecto, las últimas 24 h) y como máximo 31 días, que es
 *   el límite del proveedor. Página de 50 por defecto y 200 como máximo. Orden: más reciente
 *   primero, con cursor opaco del proveedor ligado a filtros y orden.
 * - Filtros del contrato: `severity` y `category` (multivalor, separados por coma) y
 *   `outcome` (`success | failure`). Nada de lenguaje de consulta del proveedor.
 * - Alternativa: `q` en la gramática `qapaq-events-v1` (`@qapaq/contracts`), que produce los
 *   mismos filtros. `q` y los filtros tipados son excluyentes: mandar ambos es 422 (no hay
 *   precedencia silenciosa). Un error de `q` es 422 sobre `q` sin repetir la consulta; la
 *   consola usa el mismo parser para mostrar posición y alternativas. La respuesta devuelve la
 *   forma canónica en `query`.
 * - Fuente deshabilitada: `200` con `status: "disabled"` y sin filas. No es un error ni un
 *   «sin eventos»: la UI debe decir que la fuente no está configurada.
 * - Falla del proveedor: `503 DEPENDENCY_DEGRADED`, sin consulta, host ni índice; un cursor
 *   vencido, alterado o de otra consulta: `422` sobre `cursor`.
 */

import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { projectFields } from '@qapaq/access';
import { SecurityEventProviderError } from '@qapaq/connectors';
import {
  EVENTS_QUERY_GRAMMAR,
  formatEventsQuery,
  parseEventsQuery,
  type EventsQueryFilters,
  type SecurityEvent,
} from '@qapaq/contracts';

import { ApiError } from '../http/api-error.js';
import type { IncomingRequest } from '../http/http-contracts.js';
import { readingActor } from './session-actor.js';
import { SECOPS_RUNTIME } from './tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';

export const EVENTS_LIMITS = Object.freeze({
  defaultWindowMs: 24 * 3_600_000,
  maximumRangeMs: 31 * 24 * 3_600_000,
  defaultPageSize: 50,
  maximumPageSize: 200,
  maximumFilterValues: 16,
});

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const LIST_VALUE = /^[a-z_]{2,32}$/u;
const CURSOR_ERRORS = new Set([
  'PROVIDER_CURSOR_INVALID',
  'PROVIDER_CURSOR_EXPIRED',
  'PROVIDER_CURSOR_INCOMPATIBLE',
]);

function list(value: string | undefined): string[] | undefined {
  if (value === undefined || value === '') return [];
  const items = [...new Set(value.split(',').map((item) => item.trim()))];
  if (
    items.length > EVENTS_LIMITS.maximumFilterValues ||
    !items.every((item) => LIST_VALUE.test(item))
  )
    return undefined;
  return items;
}

/** Vista pública del evento: el contrato normalizado, sin la prueba del crudo. */
function eventView(event: SecurityEvent, raw: unknown, capabilities: ReadonlySet<string>) {
  return projectFields(
    {
      recordId: event.recordId,
      eventUid: event.eventUid,
      occurredAt: event.occurredAt,
      receivedAt: event.receivedAt,
      kind: event.kind,
      severity: event.severity.normalized,
      category: event.category,
      outcome: event.outcome,
      action: event.action ?? null,
      title: event.detection?.rule.name ?? null,
      rule: event.detection
        ? { id: event.detection.rule.id, groups: event.detection.rule.groups }
        : null,
      identities: event.entities.identities,
      resources: event.entities.resources,
      source: event.source,
      extensions: event.extensions ?? null,
      // `raw` solo se proyecta con events.read_raw (FIELD_CAPABILITIES).
      raw,
    },
    capabilities as never,
  );
}

@Controller('api')
export class EventsController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  @Get('events')
  public async events(
    @Req() request: IncomingRequest,
    @Query()
    query: {
      from?: string;
      to?: string;
      q?: string;
      severity?: string;
      category?: string;
      outcome?: string;
      pageSize?: string;
      cursor?: string;
    },
  ) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    if (!actor.capabilities.has('events.read')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }

    const now = this.runtime.now();
    const invalid: string[] = [];
    const to = query.to ? new Date(query.to) : now;
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - EVENTS_LIMITS.defaultWindowMs);
    if (query.to && !ISO_PATTERN.test(query.to)) invalid.push('to');
    if (query.from && !ISO_PATTERN.test(query.from)) invalid.push('from');
    if (
      invalid.length === 0 &&
      (from.getTime() > to.getTime() ||
        to.getTime() - from.getTime() > EVENTS_LIMITS.maximumRangeMs)
    )
      invalid.push('from', 'to');
    const pageSize =
      query.pageSize === undefined || query.pageSize === ''
        ? EVENTS_LIMITS.defaultPageSize
        : /^\d{1,3}$/u.test(query.pageSize)
          ? Number(query.pageSize)
          : Number.NaN;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > EVENTS_LIMITS.maximumPageSize)
      invalid.push('pageSize');
    const severity = list(query.severity);
    const category = list(query.category);
    if (!severity) invalid.push('severity');
    if (!category) invalid.push('category');
    if (
      query.outcome !== undefined &&
      query.outcome !== '' &&
      !['success', 'failure'].includes(query.outcome)
    )
      invalid.push('outcome');
    if (query.cursor !== undefined && (query.cursor.length < 16 || query.cursor.length > 4_096))
      invalid.push('cursor');
    if (invalid.length > 0) throw new ApiError('VALIDATION_FAILED', correlationId, invalid);

    // `q` o filtros tipados, nunca ambos: una precedencia implícita ocultaría un filtro.
    const typedFilters = severity!.length > 0 || category!.length > 0 || Boolean(query.outcome);
    let filters: EventsQueryFilters;
    if (query.q !== undefined && query.q.trim() !== '') {
      if (typedFilters) {
        throw new ApiError('VALIDATION_FAILED', correlationId, [
          'q',
          'severity',
          'category',
          'outcome',
        ]);
      }
      const parsed = parseEventsQuery(query.q);
      if (!parsed.ok) throw new ApiError('VALIDATION_FAILED', correlationId, ['q']);
      filters = parsed.filters;
    } else {
      filters = {
        ...(severity!.length > 0 ? { severity: severity! } : {}),
        ...(category!.length > 0 ? { category: category! } : {}),
        ...(query.outcome ? { outcome: query.outcome } : {}),
      };
    }
    const queryView = { grammar: EVENTS_QUERY_GRAMMAR, canonical: formatEventsQuery(filters) };

    const reader = this.runtime.events;
    const window = { from: from.toISOString(), to: to.toISOString() };
    if (!reader) {
      return {
        correlationId,
        status: 'disabled' as const,
        window,
        query: queryView,
        items: [],
        unparsedCount: 0,
        nextCursor: null,
      };
    }
    try {
      const page = await reader.read({
        from,
        to,
        pageSize,
        filters,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });
      return {
        correlationId,
        status: 'ok' as const,
        window,
        query: queryView,
        items: page.items.map((item) => eventView(item.event, item.raw, actor.capabilities)),
        unparsedCount: page.unparsedCount,
        nextCursor: page.nextCursor,
      };
    } catch (error) {
      if (error instanceof SecurityEventProviderError) {
        if (CURSOR_ERRORS.has(error.code)) {
          throw new ApiError('VALIDATION_FAILED', correlationId, ['cursor']);
        }
        if (error.code === 'PROVIDER_QUERY_REJECTED') {
          // Un valor válido en la gramática que la fuente no puede filtrar (p. ej. una categoría
          // sin correspondencia en Wazuh): se rechaza antes que responder sin ese filtro.
          throw new ApiError('VALIDATION_FAILED', correlationId, [query.q ? 'q' : 'category']);
        }
      }
      throw new ApiError('DEPENDENCY_DEGRADED', correlationId);
    }
  }
}
