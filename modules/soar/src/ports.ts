/**
 * Puertos de C-20.
 *
 * `OutboxReader.claimPending` toma un lease: dos réplicas del worker no deben despachar
 * el mismo mensaje a la vez. La idempotencia del intento protege igualmente, pero un
 * lease evita gastar dos llamadas al destino por cada crítico.
 */

import type { OutboxMessageDraft } from '@qapaq/soc';
import type { AuditEventDraft, AuditStore } from '@qapaq/audit';

import type { RenderedEmail } from './notification-content.js';
import type { DeliveryEvidence, NotificationAttempt, NotificationChannel } from './notification.js';
import type { NotificationRecipient } from './notification-routing.js';

export interface OutboxReader {
  claimPending(limit: number, now: Date): Promise<readonly OutboxMessageDraft[]>;
  markPublished(messageId: string, at: Date): Promise<void>;
  scheduleRetry(messageId: string, availableAt: Date, errorCode: string): Promise<void>;
}

export interface AttemptStore {
  byIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<NotificationAttempt | undefined>;
  byId(tenantId: string, attemptId: string): Promise<NotificationAttempt | undefined>;
  save(attempt: NotificationAttempt): Promise<void>;
  /** Actualiza el acuse y agrega su evento en una sola unidad atómica. */
  acknowledgeWithAudit(
    tenantId: string,
    attemptId: string,
    actorId: string,
    at: Date,
    draft: (previousStatus: string) => AuditEventDraft,
    memoryAudit?: AuditStore,
  ): Promise<NotificationAttempt | undefined>;
  /** Bandeja de la consola: más recientes primero, acotada por `limit`. */
  listByTenant(tenantId: string, limit: number): Promise<readonly NotificationAttempt[]>;
  /**
   * Conteo por estado de los intentos creados desde `since` (ventana fija, no "las últimas N
   * filas"). Lo usa la salud operativa: la semántica debe ser estable entre llamadas.
   */
  countByStatusSince(tenantId: string, since: Date): Promise<Readonly<Record<string, number>>>;
  /**
   * Latencia desde la creación durable del outbox hasta la primera respuesta HTTP 2xx
   * registrada como `accepted` por un proveedor externo. Ventana fija y muestras acotadas.
   * En memoria devuelve NO_DATA: ese store no conserva el enlace outbox → intento.
   */
  providerAcceptanceLatencySince(
    tenantId: string,
    since: Date,
    through: Date,
  ): Promise<ProviderAcceptanceLatency>;
  /**
   * Último aviso publicado (enviado, por respaldo, reconocido o sustituido, con `sentAt`) del
   * grupo desde `since`. Base de la agrupación y del re-aviso silencioso.
   */
  lastNotifiedInGroup(
    tenantId: string,
    groupKey: string,
    since: Date,
  ): Promise<NotificationAttempt | undefined>;
  /** Suprimidas del grupo creadas después de `after`, más antiguas primero (acotado). */
  listSuppressedInGroup(
    tenantId: string,
    groupKey: string,
    after: Date,
    limit: number,
  ): Promise<readonly NotificationAttempt[]>;
  /**
   * Reserva atómicamente una plaza P2 en la ventana móvil de una hora. Repetir la misma
   * idempotency key devuelve true sin consumir otra plaza; los stores compartidos deben
   * serializar la decisión entre réplicas.
   */
  reserveP2ImmediateSlot(
    tenantId: string,
    idempotencyKey: string,
    at: Date,
    maximum: number,
  ): Promise<boolean>;
  /** Confirma la plaza al aceptar un canal; libera fallos conocidos y acota los ambiguos. */
  settleP2ImmediateSlot(
    tenantId: string,
    idempotencyKey: string,
    at: Date,
    result: 'delivered' | 'failed' | 'uncertain',
  ): Promise<void>;
  /**
   * Reclama el quiet window durable de un grupo. `fencingToken` debe ser nuevo por despacho;
   * el store serializa por tenant+grupo y devuelve el intento que cubre una denegación.
   */
  reserveGroupDispatchSlot(
    tenantId: string,
    groupKey: string,
    idempotencyKey: string,
    attemptId: string,
    fencingToken: string,
    at: Date,
    quietPeriodMs: number,
    leaseMs: number,
  ): Promise<{ readonly granted: boolean; readonly coveredBy: string | null }>;
  /** Entrega/fallback confirma el quiet window; fallo conocido libera; ambigüedad deja lease. */
  settleGroupDispatchSlot(
    tenantId: string,
    groupKey: string,
    idempotencyKey: string,
    fencingToken: string,
    at: Date,
    quietPeriodMs: number,
    leaseMs: number,
    result: 'delivered' | 'failed' | 'uncertain',
  ): Promise<void>;
  /** Suprimidas que ningún resumen incluyó todavía, más antiguas primero (acotado). */
  listUndigested(tenantId: string, limit: number): Promise<readonly NotificationAttempt[]>;
}

export interface ProviderAcceptanceLatency {
  readonly windowHours: 24;
  readonly sampleCount: number;
  readonly excludedClockSkewCount: number;
  readonly sampleCapReached: boolean;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
}

export interface FallbackNotification {
  readonly tenantId: string;
  readonly aggregateType: 'alert' | 'incident';
  readonly aggregateId: string;
  readonly title: string;
  readonly severity: string;
  readonly reason: string;
  readonly at: Date;
  /**
   * Personas del SOC que debían recibir el aviso en Teams (Sprint 5): el respaldo por correo se
   * dirige a ellas. Vacío si no hay padrón.
   */
  readonly recipients?: readonly NotificationRecipient[];
  /** Enlace a QAPAQ para abrir el recurso (requiere sesión). */
  readonly link?: string;
  /** Correo explicativo ya renderizado (asunto, HTML y texto). */
  readonly email?: RenderedEmail;
}

export interface FallbackChannel {
  notify(notification: FallbackNotification): Promise<{
    readonly channel: NotificationChannel;
    readonly reference: string;
    /** Evidencia del canal que finalmente aceptó (o de los que fallaron en el camino). */
    readonly evidence?: readonly DeliveryEvidence[];
  }>;
}

/** Correo directo (copia de P1 y resúmenes): Graph `sendMail`. */
export interface MailChannel {
  send(input: {
    readonly recipients: readonly NotificationRecipient[];
    readonly email: RenderedEmail;
    readonly clientRequestId: string;
  }): Promise<DeliveryEvidence>;
}
