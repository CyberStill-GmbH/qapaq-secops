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
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const NOTIFICATION_CHANNELS = ['teams', 'fallback_email', 'manual_console'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

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
