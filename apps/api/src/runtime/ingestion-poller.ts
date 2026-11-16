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
  type IngestionContinuation,
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
  readonly promote: (
    event: SecurityEvent,
  ) => Promise<'promoted' | 'duplicate' | 'not_promoted' | 'below_threshold' | 'suppressed'>;
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
    let normalized = 0;
    let promoted = 0;
    let quarantined = 0;
    let duplicates = 0;
    let notPromoted = 0;
    let belowThreshold = 0;
    let suppressed = 0;
    let newestEventAt: Date | null = null;
    let pending = false;
    let failure: ReturnType<typeof classify> | undefined;

    try {
      const window = planIngestionWindow(claim.watermark, attemptedAt, options.window);
      /** Lee `[from, to]` hasta el tope de páginas; devuelve true si quedó trabajo. */
      const readWindow = async (from: Date, to: Date, initialCursor?: string): Promise<boolean> => {
        let cursor = initialCursor;
        for (let page = 0; page < options.maximumPages; page += 1) {
          let result: Awaited<ReturnType<IngestionPassOptions['readPage']>>;
          try {
            result = await options.readPage({
              sourceId: options.key.sourceId,
              dataset: options.key.dataset,
              from: from.toISOString(),
              to: to.toISOString(),
              pageSize: options.pageSize,
              ...(cursor ? { cursor } : {}),
            });
          } catch (error) {
            const code = (error as { code?: unknown } | undefined)?.code;
            if (
              page === 0 &&
              initialCursor &&
              cursor === initialCursor &&
              code === 'PROVIDER_CURSOR_EXPIRED'
            ) {
              if (!(await options.state.saveContinuation(claim, null, options.now()))) {
                throw Object.assign(new Error('ingestion claim lost'), {
                  code: 'INGESTION_CLAIM_LOST',
                  retryable: true,
                });
              }
              // El token opaco ya caducó: reinicia el mismo rango fijo. La promoción por
              // identidad es idempotente, y la nueva página deja un checkpoint fresco.
              return readWindow(from, to);
            }
            throw error;
          }
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
            normalized += 1;
            const outcome = await options.promote(converted.event);
            if (outcome === 'promoted') promoted += 1;
            else if (outcome === 'duplicate') duplicates += 1;
            else if (outcome === 'below_threshold') {
              notPromoted += 1;
              belowThreshold += 1;
            } else if (outcome === 'suppressed') {
              notPromoted += 1;
              suppressed += 1;
            } else notPromoted += 1;
          }
          const nextCursor = result.hasMore ? result.nextCursor : undefined;
          const continuation: IngestionContinuation | null = nextCursor
            ? { from, to, cursor: nextCursor }
            : null;
          // Guarda/limpia search_after después de procesar la página y antes de mover la
          // marca. Un fallo no pierde la posición dentro de muchos eventos empatados.
          if (!(await options.state.saveContinuation(claim, continuation, options.now()))) {
            throw Object.assign(new Error('ingestion claim lost'), {
              code: 'INGESTION_CLAIM_LOST',
              retryable: true,
            });
          }
          if (pageNewest) {
            if (!newestEventAt || pageNewest > newestEventAt) newestEventAt = pageNewest;
            // La marca avanza solo con la página completa y su checkpoint durable.
            await options.state.advanceCursor(claim, pageNewest, options.now());
          }
          if (!nextCursor) return false;
          cursor = nextCursor;
        }
        return true;
      };
      let activeWindow = window;
      if (claim.continuation) {
        // Reanuda el rango y search_after exactos guardados en la pasada anterior.
        activeWindow = { from: claim.continuation.from, to: claim.continuation.to };
        pending = await readWindow(activeWindow.from, activeWindow.to, claim.continuation.cursor);
      } else if (window) {
        pending = await readWindow(window.from, window.to);
        // Solape saturado: el tope de páginas se gastó entero en eventos que no superan la
        // marca (ráfaga de más de pageSize×maximumPages eventos en `overlapMs`). Sin esto cada
        // pasada relee el mismo solape y la marca no avanza nunca: lo posterior no llega al SOC
        // (incidente 2026-11-13: 1000 alertas en 120 s y 53 015 alertas sin ingerir). Se relee
        // desde la marca exacta, sin solape, con un tope nuevo; lo tardío ya se cubrió arriba.
        // `readWindow` muta `newestEventAt`; el cast evita que TS lo estreche a `null`.
        const newestRead = newestEventAt as Date | null;
        if (
          pending &&
          claim.watermark !== null &&
          (!newestRead || newestRead.getTime() <= claim.watermark.getTime())
        ) {
          activeWindow = { from: claim.watermark, to: window.to };
          pending = await readWindow(activeWindow.from, activeWindow.to);
        }
        // Ventana vacía y al día: la marca sube al borde de la ventana para no releer
        // indefinidamente desde la primera vez que se miró la fuente.
        if (recordsSeen === 0 && claim.watermark === null) {
          await options.state.advanceCursor(claim, window.from, options.now());
        }
        // Ventana recortada por `maximumWindowMs` y leída completa: la marca sube a su borde
        // aunque no hubiera eventos nuevos. Sin esto, un hueco de más de una ventana sin
        // eventos (p. ej. una noche sin alertas) deja la marca clavada en el último evento y
        // cada pasada relee la misma hora para siempre: lo posterior nunca llega al SOC.
        // El borde ya quedó atrás (`to` < ahora − retraso), así que el solape de la pasada
        // siguiente cubre lo indexado tarde. Queda trabajo: se pide otra pasada enseguida.
      }
      if (activeWindow) {
        const capped = activeWindow.to.getTime() < attemptedAt.getTime() - options.window.lagMs;
        if (capped && !pending) {
          await options.state.advanceCursor(claim, activeWindow.to, options.now());
          pending = true;
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
        normalized,
        promoted,
        quarantined,
        duplicates,
        notPromoted,
        belowThreshold,
        suppressed,
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
