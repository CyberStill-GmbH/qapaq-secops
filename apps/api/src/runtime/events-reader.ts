/**
 * Sprint 5 · fase 1 — lectura directa de eventos para el explorador (S5-D5).
 *
 * Une el proveedor de C-28 (con el compilador de filtros) y la normalización: el BFF recibe
 * `SecurityEvent` ya normalizados, nunca el documento del Indexer salvo que el lector tenga
 * `events.read_raw` (eso lo decide el controller). No guarda copia de nada.
 *
 * Un documento que no se puede normalizar no se descarta en silencio: se cuenta en
 * `unparsedCount` para que la UI diga que la página tiene registros que no se pudieron mostrar.
 */

import type { EventFilters, ProviderRecord, SecurityEventProvider } from '@qapaq/connectors';
import type { SecurityEvent } from '@qapaq/contracts';

import type { RecordConversion } from './ingestion-poller.js';

export interface EventsReadRequest {
  readonly from: Date;
  readonly to: Date;
  readonly filters: EventFilters;
  readonly pageSize: number;
  readonly cursor?: string;
}

export interface EventsReadResult {
  readonly items: readonly { readonly event: SecurityEvent; readonly raw: ProviderRecord['raw'] }[];
  readonly unparsedCount: number;
  readonly nextCursor: string | null;
}

export interface EventsReader {
  read(request: EventsReadRequest): Promise<EventsReadResult>;
}

export function createEventsReader(options: {
  readonly provider: SecurityEventProvider;
  readonly sourceId: string;
  readonly dataset: string;
  readonly toEvent: (record: ProviderRecord) => RecordConversion;
}): EventsReader {
  return {
    async read(request) {
      const page = await options.provider.readPage({
        sourceId: options.sourceId,
        dataset: options.dataset,
        from: request.from.toISOString(),
        to: request.to.toISOString(),
        pageSize: request.pageSize,
        filters: request.filters,
        // El explorador muestra primero lo más reciente; la ingesta lee en orden ascendente.
        order: 'desc',
        ...(request.cursor ? { cursor: request.cursor } : {}),
      });
      const items: { event: SecurityEvent; raw: ProviderRecord['raw'] }[] = [];
      let unparsedCount = 0;
      for (const record of page.items) {
        const converted = options.toEvent(record);
        if (converted.status === 'normalized')
          items.push({ event: converted.event, raw: record.raw });
        else unparsedCount += 1;
      }
      return { items, unparsedCount, nextCursor: page.nextCursor ?? null };
    },
  };
}
