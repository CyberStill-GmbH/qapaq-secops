/**
 * C-20 — NotificationAttempt y su máquina de estados.
 *
 * `SENT` significa "el destino aceptó el mensaje", no "una persona lo leyó". El acuse
 * humano es un estado aparte (`acknowledged`) que solo avanza cuando alguien lo registra
 * en QAPAQ; confundir ambos haría creer que un crítico fue atendido porque Teams
 * respondió 200.
 */

import { createHash } from 'node:crypto';

export const NOTIFICATION_STATUSES = [
  'pending',
  'sending',
  'sent',
  'indeterminate',
  'failed',
  'fallback',
  'acknowledged',
  /**
   * No se publicó en el canal por política de ruido: agrupada en un aviso previo del mismo grupo,
   * atrasada (backlog tras una caída), por tope de avisos o destinada al resumen periódico. El
   * motivo queda en `suppressionReason`; el resumen la marca en `delivery` al incluirla.
   */
  'suppressed',
  /** Un aviso posterior o una decisión registrada la reemplaza; ya no requiere acuse. */
  'superseded',
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const NOTIFICATION_CHANNELS = ['teams', 'fallback_email', 'manual_console'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const SUPPRESSION_REASONS = ['grouped', 'stale_backlog', 'rate_limited', 'digest'] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/**
 * Evidencia de entrega por canal e intento. Nunca contiene el contenido del aviso ni la URL del
 * destino: solo el resultado HTTP y los identificadores que el proveedor devolvió.
 *
 * - `accepted`: M365 aceptó el mensaje (Workflows 202 / Graph sendMail 202). No prueba que una
 *   persona lo haya visto ni, para Workflows, que el flujo haya publicado la tarjeta.
 * - `failed`: el canal rechazó o no respondió; `reason` lleva el código.
 */
export interface DeliveryEvidence {
  readonly channel: 'teams' | 'email' | 'console' | 'push';
  readonly outcome: 'accepted' | 'failed';
  /** Start of the attempt; retained for compatibility with historical evidence. */
  readonly at: string;
  /** Provider response time. Historical evidence without it is excluded from latency metrics. */
  readonly responseAt?: string;
  readonly httpStatus: number | null;
  /** Identificador del proveedor: run id del Workflow, request-id de Graph… */
  readonly providerMessageId: string | null;
  /** Enlace del proveedor si lo devolvió (no se fabrica). */
  readonly providerLink: string | null;
  readonly reason: string | null;
  /** Destinatarios (solo cantidad) del correo. */
  readonly recipients?: number;
}

export interface NotificationAttempt {
  readonly id: string;
  readonly tenantId: string;
  readonly messageId: string;
  readonly idempotencyKey: string;
  /**
   * Identificador que viaja al destino en cada intento del mismo mensaje. Se mantiene
   * estable entre reintentos justamente para que el destino pueda deduplicar.
   */
  readonly clientRequestId: string;
  readonly channel: NotificationChannel;
  readonly status: NotificationStatus;
  readonly attemptCount: number;
  readonly availableAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastFailureCode: string | null;
  readonly lastFailureClass: string | null;
  readonly sentAt: Date | null;
  readonly acknowledgedAt: Date | null;
  readonly acknowledgedBy: string | null;
  /** Clave opaca del grupo de ruido (hash de incidente/correlación o regla+entidad). */
  readonly groupKey?: string | null;
  /** Resumen enmascarado de la alerta o incidente avisado (lo que la consola muestra). */
  readonly context?: Readonly<Record<string, unknown>> | null;
  /** Evidencia de entrega por canal e intento, en orden. */
  readonly delivery?: readonly DeliveryEvidence[];
  readonly suppressionReason?: SuppressionReason | null;
  /** Aviso que la contiene (agrupada) o que la reemplaza (sustituida). */
  readonly supersededBy?: string | null;
  /** Resumen periódico que ya incluyó esta notificación suprimida. */
  readonly digestId?: string | null;
}

export function clientRequestIdFor(tenantId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${tenantId}\u0000${idempotencyKey}`, 'utf8')
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

export function createAttempt(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly messageId: string;
  readonly idempotencyKey: string;
  readonly at: Date;
}): NotificationAttempt {
  return {
    id: input.id,
    tenantId: input.tenantId,
    messageId: input.messageId,
    idempotencyKey: input.idempotencyKey,
    clientRequestId: clientRequestIdFor(input.tenantId, input.idempotencyKey),
    channel: 'teams',
    status: 'pending',
    attemptCount: 0,
    availableAt: input.at,
    createdAt: input.at,
    updatedAt: input.at,
    lastFailureCode: null,
    lastFailureClass: null,
    sentAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    groupKey: null,
    context: null,
    delivery: [],
    suppressionReason: null,
    supersededBy: null,
    digestId: null,
  };
}

export const ACKNOWLEDGEMENT_ERROR_CODES = ['NOT_DELIVERED', 'ALREADY_ACKNOWLEDGED'] as const;
export type AcknowledgementErrorCode = (typeof ACKNOWLEDGEMENT_ERROR_CODES)[number];

export type AcknowledgementResult =
  | { readonly ok: true; readonly attempt: NotificationAttempt }
  | { readonly ok: false; readonly code: AcknowledgementErrorCode };

/**
 * Acuse humano registrado en QAPAQ. Se admite sobre `sent`, `indeterminate` y `fallback`:
 * si una persona confirma haberlo visto, la entrega dudosa queda resuelta por la vía que
 * importa, que es la atención del caso.
 */
export function acknowledge(
  attempt: NotificationAttempt,
  actorId: string,
  at: Date,
): AcknowledgementResult {
  if (attempt.status === 'acknowledged') return { ok: false, code: 'ALREADY_ACKNOWLEDGED' };
  if (!['sent', 'indeterminate', 'fallback'].includes(attempt.status)) {
    return { ok: false, code: 'NOT_DELIVERED' };
  }
  return {
    ok: true,
    attempt: {
      ...attempt,
      status: 'acknowledged',
      acknowledgedAt: at,
      acknowledgedBy: actorId,
      updatedAt: at,
    },
  };
}

/** Estados de entrega que aún esperan acuse humano. */
export const AWAITING_ACKNOWLEDGEMENT: readonly NotificationStatus[] = Object.freeze([
  'sent',
  'indeterminate',
  'fallback',
]);

/**
 * Marca un aviso sin acuse como sustituido (no lo borra: la historia y la evidencia de entrega se
 * conservan). Solo aplica a lo entregado y sin acuse.
 */
export function supersede(
  attempt: NotificationAttempt,
  by: string | null,
  at: Date,
): AcknowledgementResult {
  if (attempt.status === 'acknowledged') return { ok: false, code: 'ALREADY_ACKNOWLEDGED' };
  if (!AWAITING_ACKNOWLEDGEMENT.includes(attempt.status))
    return { ok: false, code: 'NOT_DELIVERED' };
  return {
    ok: true,
    attempt: { ...attempt, status: 'superseded', supersededBy: by, updatedAt: at },
  };
}

/** Etiqueta para la consola: «enviado» (aceptado por M365) no es «entregado» ni «reconocido». */
export function deliveryLabel(attempt: NotificationAttempt): string {
  switch (attempt.status) {
    case 'acknowledged':
      return 'Reconocido';
    case 'sent':
      return 'Enviado (aceptado por M365)';
    case 'fallback':
      return attempt.channel === 'fallback_email'
        ? 'Enviado por correo (aceptado por M365)'
        : 'En bandeja de la consola';
    case 'indeterminate':
      return 'Indeterminado (sin respuesta del canal)';
    case 'failed':
      return 'Fallido';
    case 'suppressed':
      return attempt.suppressionReason === 'grouped'
        ? 'Agrupado en un aviso anterior'
        : attempt.digestId
          ? 'Incluido en un resumen'
          : 'En espera de resumen';
    case 'superseded':
      return 'Sustituido';
    case 'pending':
    case 'sending':
      return 'Pendiente';
  }
}
