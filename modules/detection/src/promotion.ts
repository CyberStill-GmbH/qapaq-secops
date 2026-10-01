/**
 * C-16 — promoción idempotente de SecurityEvent a candidato de alerta.
 *
 * El pipeline reintenta: un replay de C-13, un reinicio del worker o una reentrega
 * vuelven a presentar el mismo evento. La promoción debe ser idempotente *por
 * construcción*, no por suerte: la clave es determinista sobre `(tenant, evento,
 * versión del ruleset)` y la segunda vez el resultado es `duplicate`, nunca una segunda
 * alerta.
 *
 * Incluir la versión del ruleset en la clave es deliberado: si la priorización cambia de
 * versión, el mismo evento puede volver a evaluarse y producir un candidato nuevo y
 * trazable, en lugar de quedar silenciosamente congelado con la decisión antigua.
 */

import { createHash } from 'node:crypto';

import type { SecurityEvent } from '@qapaq/contracts';

import {
  prioritize,
  PROMOTION_THRESHOLD,
  type PrioritizationContext,
  type PrioritizationOutcome,
  type Priority,
  type Reason,
} from './prioritization.js';

export const PROMOTION_OUTCOMES = ['promoted', 'duplicate', 'not_promoted'] as const;
export type PromotionOutcomeCode = (typeof PROMOTION_OUTCOMES)[number];

export interface DetectionCandidate {
  readonly id: string;
  readonly tenantId: string;
  readonly eventRecordId: string;
  readonly eventUid: string;
  readonly idempotencyKey: string;
  readonly priority: Priority;
  readonly score: number;
  readonly reasons: readonly Reason[];
  readonly rulesetId: string;
  readonly rulesetVersion: string;
  readonly occurredAt: Date;
  readonly createdAt: Date;
  readonly title: string;
}

export type PromotionDecision =
  | {
      readonly outcome: 'promoted';
      readonly candidate: DetectionCandidate;
      readonly evaluation: PrioritizationOutcome;
    }
  | {
      readonly outcome: 'duplicate';
      readonly existing: DetectionCandidate;
      readonly evaluation: PrioritizationOutcome;
    }
  | {
      readonly outcome: 'not_promoted';
      readonly reasonCode: 'BELOW_THRESHOLD' | 'SUPPRESSED';
      readonly evaluation: PrioritizationOutcome;
    };

export function promotionKey(
  tenantId: string,
  eventRecordId: string,
  rulesetVersion: string,
): string {
  return createHash('sha256')
    .update(`${tenantId}\u0000${eventRecordId}\u0000${rulesetVersion}`, 'utf8')
    .digest('hex');
}

/** UUIDv7 derivado del instante del evento y de la clave: estable entre reintentos. */
export function candidateId(key: string, occurredAt: Date): string {
  const millis = occurredAt.getTime();
  if (!Number.isSafeInteger(millis) || millis < 0 || millis >= 2 ** 48) {
    throw new RangeError('El instante del evento no es representable como UUIDv7.');
  }
  const bytes = Buffer.from(createHash('sha256').update(key, 'utf8').digest().subarray(0, 16));
  const time = BigInt(millis);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number((time >> BigInt((5 - index) * 8)) & 0xffn);
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function titleFor(event: SecurityEvent): string {
  const rule = event.detection?.rule;
  if (rule) return `${rule.name} (${rule.provider} ${rule.id})`;
  return `${event.source.product} · ${event.action ?? event.category[0]}`;
}

export function decidePromotion(
  event: SecurityEvent,
  context: PrioritizationContext,
  existing: DetectionCandidate | undefined,
  now: Date,
): PromotionDecision {
  const evaluation = prioritize(event, context);
  const key = promotionKey(event.tenant.id, event.recordId, evaluation.rulesetVersion);
  // La idempotencia se resuelve antes que el umbral: un candidato ya creado no se
  // revoca porque el contexto haya cambiado entre dos pasadas.
  if (existing && existing.idempotencyKey === key) {
    return { outcome: 'duplicate', existing, evaluation };
  }
  if (evaluation.suppressed) {
    return { outcome: 'not_promoted', reasonCode: 'SUPPRESSED', evaluation };
  }
  if (evaluation.score < PROMOTION_THRESHOLD) {
    return { outcome: 'not_promoted', reasonCode: 'BELOW_THRESHOLD', evaluation };
  }
  const occurredAt = new Date(event.occurredAt);
  return {
    outcome: 'promoted',
    evaluation,
    candidate: {
      id: candidateId(key, occurredAt),
      tenantId: event.tenant.id,
      eventRecordId: event.recordId,
      eventUid: event.eventUid,
      idempotencyKey: key,
      priority: evaluation.priority,
      score: evaluation.score,
      reasons: evaluation.reasons,
      rulesetId: evaluation.rulesetId,
      rulesetVersion: evaluation.rulesetVersion,
      occurredAt,
      createdAt: now,
      title: titleFor(event),
    },
  };
}
