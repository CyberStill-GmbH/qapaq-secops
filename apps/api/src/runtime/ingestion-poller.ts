/**
 * Sprint 5 · fase 0 — pasada de ingesta de una fuente hacia el SOC (S5-D1).
 *
 * Una pasada:
 * 1. toma el lease del cursor `(tenant, fuente, dataset)`; si otra réplica lo tiene, no hace
 *    nada (varias réplicas son seguras);
 * 2. calcula la ventana `[marca − solape, ahora − retraso]` (`planIngestionWindow`);
 * 3. lee página a página hasta `maximumPages`, convierte cada documento en `SecurityEvent`
 *    (`toEvent`) y lo promueve; la promoción es idempotente por evento, así releer el solape
 *    no duplica alertas;
 * 4. avanza la marca de agua al terminar cada página, nunca antes;
 * 5. registra la observación del poll (también si falló o no encontró nada) y libera el lease.
 *
 * Devuelve 1 si quedó trabajo pendiente (más páginas que el tope) para que el bucle encadene
 * otra pasada sin esperar el intervalo, y 0 si la fuente quedó al día.
 *
 * No conoce a Wazuh: recibe el proveedor, la conversión y la promoción desde el composition
 * root. Un error nunca sale con el mensaje del proveedor: se reduce a un código del catálogo.
 */

import { randomUUID } from 'node:crypto';

import type { EventQuery, ProviderRecord } from '@qapaq/connectors';
import type { SecurityEvent } from '@qapaq/contracts';
import {
  planIngestionWindow,
  type IngestionCursorKey,
  type IngestionStateStore,
  type IngestionWindowPolicy,
  type PollOutcome,
} from '@qapaq/soc';

export type RecordConversion =
  | { readonly status: 'normalized'; readonly event: SecurityEvent }
  | { readonly status: 'quarantined' };

export interface IngestionPassOptions {
  readonly key: IngestionCursorKey;
  readonly readPage: (query: EventQuery) => Promise<{
    readonly items: readonly ProviderRecord[];
    readonly nextCursor?: string;
    readonly hasMore: boolean;
  }>;
  readonly state: IngestionStateStore;
  readonly toEvent: (record: ProviderRecord) => RecordConversion;
  readonly promote: (event: SecurityEvent) => Promise<'promoted' | 'duplicate' | 'not_promoted'>;
  readonly window: IngestionWindowPolicy;
  readonly pageSize: number;
  readonly maximumPages: number;
  readonly leaseMs: number;
  readonly now: () => Date;
  /**
   * Observer al terminar cada pasada, con éxito o con error (p. ej. evaluar la salud de la
   * fuente). Un fallo aquí no tapa el error de una pasada fallida.
   */
  readonly afterPass?: () => Promise<void>;
}

/** Errores con `code` y `retryable` (p. ej. `SecurityEventProviderError`). */
function classify(error: unknown): { readonly outcome: PollOutcome; readonly errorClass: string } {
  const candidate = error as { code?: unknown; retryable?: unknown };
  const code =
    typeof candidate?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(candidate.code)
      ? candidate.code
      : 'INGESTION_INTERNAL_ERROR';
  const retryable = candidate?.retryable === false ? false : true;
  return { outcome: retryable ? 'retryable_error' : 'permanent_error', errorClass: code };
}

export function createIngestionPass(options: IngestionPassOptions): () => Promise<number> {
  return async () => {
    const attemptedAt = options.now();
    const claim = await options.state.claimCursor(options.key, attemptedAt, options.leaseMs);
    if (!claim) return 0;

    let recordsSeen = 0;
    let promoted = 0;
    let quarantined = 0;
    let newestEventAt: Date | null = null;
    let pending = false;
    let failure: ReturnType<typeof classify> | undefined;

    try {
      const window = planIngestionWindow(claim.watermark, attemptedAt, options.window);
      if (window) {
        let cursor: string | undefined;
        for (let page = 0; page < options.maximumPages; page += 1) {
          const result = await options.readPage({
            sourceId: options.key.sourceId,
            dataset: options.key.dataset,
            from: window.from.toISOString(),
            to: window.to.toISOString(),
            pageSize: options.pageSize,
            ...(cursor ? { cursor } : {}),
          });
          let pageNewest: Date | null = null;
          for (const record of result.items) {
            recordsSeen += 1;
            const occurredAt = record.occurredAt ? new Date(record.occurredAt) : null;
            if (occurredAt && (!pageNewest || occurredAt > pageNewest)) pageNewest = occurredAt;
            const converted = options.toEvent(record);
            if (converted.status === 'quarantined') {
              quarantined += 1;
              continue;
            }
            if ((await options.promote(converted.event)) === 'promoted') promoted += 1;
          }
          if (pageNewest) {
            if (!newestEventAt || pageNewest > newestEventAt) newestEventAt = pageNewest;
            // La marca avanza solo con la página completa procesada.
            await options.state.advanceCursor(claim, pageNewest, options.now());
          }
          if (!result.hasMore || !result.nextCursor) break;
          cursor = result.nextCursor;
          if (page === options.maximumPages - 1) pending = true;
        }
        // Ventana vacía y al día: la marca sube al borde de la ventana para no releer
        // indefinidamente desde la primera vez que se miró la fuente.
        if (recordsSeen === 0 && claim.watermark === null) {
          await options.state.advanceCursor(claim, window.from, options.now());
        }
      }
    } catch (error) {
      failure = classify(error);
    }

    try {
      await options.state.recordObservation({
        id: randomUUID(),
        ...options.key,
        attemptedAt,
        completedAt: options.now(),
        outcome: failure ? failure.outcome : 'success',
        recordsSeen,
        promoted,
        quarantined,
        newestEventAt,
        errorClass: failure ? failure.errorClass : null,
      });
    } finally {
      await options.state.releaseCursor(claim);
    }
    try {
      await options.afterPass?.();
    } catch (error) {
      // Si la pasada ya falló, ese es el error que importa; si no, el del observer sube al
      // `onError` del bucle.
      if (!failure) throw error;
    }
    if (failure) {
      const error = new Error(`Ingesta fallida: ${failure.errorClass}`);
      (error as Error & { code?: string }).code = failure.errorClass;
      throw error;
    }
    return pending ? 1 : 0;
  };
}
