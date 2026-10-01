/**
 * C-17 — eventos de dominio y su mensaje de outbox.
 *
 * El SOC no llama a Teams ni conoce su existencia: publica un hecho. C-20 decide qué
 * hacer con él. Por eso el mensaje lleva una `idempotencyKey` derivada del hecho y no
 * del instante: reintentar la transacción no produce una segunda notificación.
 */

import { createHash } from 'node:crypto';

import type { Priority } from '@qapaq/detection';

import type { AlertStatus, TriageVerdict } from './alert.js';
import type { IncidentSeverity, IncidentStatus } from './incident.js';

export const SOC_EVENT_TYPES = [
  'soc.alert.created',
  'soc.alert.triaged',
  'soc.alert.escalated',
  'soc.alert.closed',
  'soc.incident.opened',
  'soc.incident.status_changed',
  'soc.incident.closed',
] as const;
export type SocEventType = (typeof SOC_EVENT_TYPES)[number];

export const SOC_EVENT_SCHEMA_VERSION = '1.0.0' as const;

export interface SocDomainEvent {
  readonly type: SocEventType;
  readonly tenantId: string;
  readonly aggregateType: 'alert' | 'incident';
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly actorId: string;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
}

export interface OutboxMessageDraft {
  readonly messageId: string;
  readonly tenantId: string;
  readonly aggregateType: 'alert' | 'incident';
  readonly aggregateId: string;
  readonly messageType: SocEventType;
  readonly schemaVersion: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
  readonly availableAt: Date;
}

/** Hechos que exigen notificación inmediata según la política aprobada de QAPAQ. */
export function requiresCriticalNotification(event: SocDomainEvent): boolean {
  if (event.type === 'soc.incident.opened') return event.payload.severity === 'critical';
  if (event.type === 'soc.alert.escalated') return event.payload.priority === 'P1';
  return false;
}

export function outboxIdempotencyKey(event: SocDomainEvent): string {
  return createHash('sha256')
    .update(
      [event.tenantId, event.type, event.aggregateId, JSON.stringify(event.payload)].join('\u0000'),
      'utf8',
    )
    .digest('hex');
}

export function toOutboxMessage(event: SocDomainEvent, messageId: string): OutboxMessageDraft {
  return {
    messageId,
    tenantId: event.tenantId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    messageType: event.type,
    schemaVersion: SOC_EVENT_SCHEMA_VERSION,
    idempotencyKey: outboxIdempotencyKey(event),
    payload: event.payload,
    availableAt: event.occurredAt,
  };
}

export function alertEvent(input: {
  readonly type: Extract<SocEventType, `soc.alert.${string}`>;
  readonly tenantId: string;
  readonly alertId: string;
  readonly actorId: string;
  readonly at: Date;
  readonly priority: Priority;
  readonly status: AlertStatus;
  readonly title: string;
  readonly verdict?: TriageVerdict | null;
  readonly incidentId?: string | null;
}): SocDomainEvent {
  return {
    type: input.type,
    tenantId: input.tenantId,
    aggregateType: 'alert',
    aggregateId: input.alertId,
    occurredAt: input.at,
    actorId: input.actorId,
    payload: {
      title: input.title,
      priority: input.priority,
      status: input.status,
      verdict: input.verdict ?? null,
      incidentId: input.incidentId ?? null,
    },
  };
}

export function incidentEvent(input: {
  readonly type: Extract<SocEventType, `soc.incident.${string}`>;
  readonly tenantId: string;
  readonly incidentId: string;
  readonly actorId: string;
  readonly at: Date;
  readonly severity: IncidentSeverity;
  readonly status: IncidentStatus;
  readonly title: string;
  readonly alertCount: number;
}): SocDomainEvent {
  return {
    type: input.type,
    tenantId: input.tenantId,
    aggregateType: 'incident',
    aggregateId: input.incidentId,
    occurredAt: input.at,
    actorId: input.actorId,
    payload: {
      title: input.title,
      severity: input.severity,
      status: input.status,
      alertCount: input.alertCount,
    },
  };
}
