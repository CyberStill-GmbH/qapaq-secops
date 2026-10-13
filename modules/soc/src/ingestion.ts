/**
 * Sprint 5 · fase 0 — estado durable de la ingesta de una fuente hacia el SOC (S5-D1, S5-D4).
 *
 * - **Cursor:** por `(tenant, fuente, dataset)` guarda la marca de agua (`watermark`: hora del
 *   evento más reciente ya procesado) y un lease con fencing (`claimId`). Solo quien tiene el
 *   claim vigente avanza la marca; si el proceso muere, el lease vence y otra réplica sigue.
 * - **Observación de poll:** cada pasada deja intento, resultado, filas vistas y error
 *   normalizado. Es la señal verificable de que QAPAQ consultó la fuente, incluso cuando no
 *   había nada (source-health §«Decisión aceptada»). La consume la salud por fuente (fase 2).
 *
 * El dominio no nombra proveedores (C-23): la fuente es un `sourceId` y un `dataset`.
 */

import type { SourceHealthTransition } from './source-health.js';

export interface IngestionCursorKey {
  readonly tenantId: string;
  readonly sourceId: string;
  readonly dataset: string;
}

export interface ClaimedIngestionCursor {
  readonly key: IngestionCursorKey;
  /** Hora del evento más reciente ya procesado; `null` en la primera pasada. */
  readonly watermark: Date | null;
  /** Fencing token del claim: sin él no se avanza ni se libera. */
  readonly claimId: string;
}

export const POLL_OUTCOMES = ['success', 'retryable_error', 'permanent_error'] as const;
export type PollOutcome = (typeof POLL_OUTCOMES)[number];

export interface SourcePollObservation {
  /** Estable por pasada: repetir el registro no duplica (idempotencia). */
  readonly id: string;
  readonly tenantId: string;
  readonly sourceId: string;
  readonly dataset: string;
  readonly attemptedAt: Date;
  readonly completedAt: Date;
  readonly outcome: PollOutcome;
  /** Documentos leídos; 0 en un poll exitoso vacío. */
  readonly recordsSeen: number;
  readonly promoted: number;
  readonly quarantined: number;
  /** Hora del evento más reciente visto en esta pasada; `null` si no vio ninguno. */
  readonly newestEventAt: Date | null;
  /** Código neutral del catálogo de errores; nunca el mensaje del proveedor. */
  readonly errorClass: string | null;
}

/**
 * Actividad medida por stream de la fuente (fase 2): informativa, nunca decide el estado. Un
 * stream esperado sin eventos en la ventana aparece con `eventsInWindow = 0`; uno que nunca tuvo
 * eventos, con `lastEventAt = null`.
 */
export interface StreamActivityRecord {
  readonly stream: string;
  readonly lastEventAt: Date | null;
  readonly eventsInWindow: number;
  readonly windowHours: number;
  readonly measuredAt: Date;
}

export interface IngestionStateStore {
  /**
   * Toma el lease del cursor (lo crea si no existe). `undefined` si otra réplica lo tiene
   * vigente: esta pasada no hace nada.
   */
  claimCursor(
    key: IngestionCursorKey,
    at: Date,
    leaseMs: number,
  ): Promise<ClaimedIngestionCursor | undefined>;
  /** Avanza la marca de agua; `false` si el claim ya no es el vigente. Nunca retrocede. */
  advanceCursor(claim: ClaimedIngestionCursor, watermark: Date, at: Date): Promise<boolean>;
  /** Libera el lease al terminar la pasada para que la siguiente no espere el vencimiento. */
  releaseCursor(claim: ClaimedIngestionCursor): Promise<void>;
  recordObservation(observation: SourcePollObservation): Promise<void>;
  /** Observaciones más recientes primero, como máximo `limit`. */
  recentObservations(
    key: IngestionCursorKey,
    limit: number,
  ): Promise<readonly SourcePollObservation[]>;
  /** Bitácora append-only de la salud de la fuente (fase 2); más recientes primero. */
  recentTransitions(
    key: IngestionCursorKey,
    limit: number,
  ): Promise<readonly SourceHealthTransition[]>;
  /** Agrega una transición; idempotente por `id`. Nunca se edita ni se borra. */
  appendTransition(transition: SourceHealthTransition): Promise<void>;
  /**
   * Guarda una medición de actividad: actualiza los streams medidos y conserva el último evento
   * conocido de los demás (con cero eventos en la ventana).
   */
  saveActivity(key: IngestionCursorKey, records: readonly StreamActivityRecord[]): Promise<void>;
  activity(key: IngestionCursorKey): Promise<readonly StreamActivityRecord[]>;
}

export interface IngestionWindowPolicy {
  /** Retraso respecto de ahora: deja al índice de la fuente terminar de publicar. */
  readonly lagMs: number;
  /** Solape hacia atrás desde la marca: recoge eventos que llegaron tarde con hora vieja. */
  readonly overlapMs: number;
  /** Ventana inicial cuando todavía no hay marca de agua. */
  readonly initialLookbackMs: number;
  /** Ancho máximo de una ventana; una marca muy atrasada se recupera por tramos. */
  readonly maximumWindowMs: number;
}

/**
 * Ventana `[from, to]` de la próxima pasada, o `undefined` si todavía no hay nada que leer.
 * Releer el solape es seguro porque la promoción es idempotente por evento.
 */
export function planIngestionWindow(
  watermark: Date | null,
  now: Date,
  policy: IngestionWindowPolicy,
): { readonly from: Date; readonly to: Date } | undefined {
  const ceiling = now.getTime() - policy.lagMs;
  const start =
    watermark === null
      ? now.getTime() - policy.initialLookbackMs
      : watermark.getTime() - policy.overlapMs;
  const to = Math.min(ceiling, start + policy.maximumWindowMs);
  if (to <= start) return undefined;
  return { from: new Date(start), to: new Date(to) };
}
