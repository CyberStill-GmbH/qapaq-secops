/**
 * Puertos de C-17.
 *
 * `SocUnitOfWork.run` recibe el trabajo completo y lo ejecuta en una sola transacción.
 * Es el punto donde se cumple el contrato con C-19 y C-20: estado, AuditEvent y mensaje
 * de outbox entran juntos o no entra ninguno. Un adapter que abra tres transacciones
 * distintas incumple aunque los tres escriban.
 *
 * `SocReadModel`, `SocOutboxQueue` y `CorrelationWindowQuery` son lecturas o marcas
 * idempotentes fuera de la transacción de negocio. `SocPersistence` agrupa todo lo que un
 * runtime necesita de un adapter (memoria para specs y desarrollo, PostgreSQL para
 * cualquier ambiente donde el estado deba sobrevivir a un reinicio).
 */

import type { AuditStore } from '@qapaq/audit';
import type { CorrelationWindowQuery, DetectionCandidateStore } from '@qapaq/detection';

import type { Alert, AlertStatus } from './alert.js';
import type { Incident, IncidentStatus } from './incident.js';
import type { OutboxMessageDraft } from './events.js';

export interface AlertStore {
  byId(tenantId: string, alertId: string): Promise<Alert | undefined>;
  insertIfAbsent(alert: Alert): Promise<boolean>;
  /** Compare-and-set sobre `revision`; `false` si otra escritura se adelantó. */
  update(alert: Alert, expectedRevision: number): Promise<boolean>;
  byIncident(tenantId: string, incidentId: string): Promise<readonly Alert[]>;
}

export interface IncidentStore {
  byId(tenantId: string, incidentId: string): Promise<Incident | undefined>;
  insert(incident: Incident): Promise<void>;
  update(incident: Incident, expectedRevision: number): Promise<boolean>;
}

export interface OutboxStore {
  /** `false` si la `idempotencyKey` ya existía: el hecho ya se publicó una vez. */
  enqueueIfAbsent(message: OutboxMessageDraft): Promise<boolean>;
}

export interface SocTransactionContext {
  readonly alerts: AlertStore;
  readonly incidents: IncidentStore;
  readonly outbox: OutboxStore;
  readonly audit: AuditStore;
  /**
   * Candidatos de C-16. La alerta referencia a su candidato por FK en PostgreSQL, así que
   * ambos se escriben en la misma transacción.
   */
  readonly candidates: DetectionCandidateStore;
}

export interface SocUnitOfWork {
  run<T>(work: (context: SocTransactionContext) => Promise<T>): Promise<T>;
}

/* ------------------------------------------------------------------ Lecturas */

export interface AlertQuery {
  readonly tenantId: string;
  /** `open` = todo lo no cerrado. */
  readonly status?: AlertStatus | 'open';
  readonly priority?: Alert['priority'];
  /** Texto en minúsculas; busca en título, asignado e id. */
  readonly search?: string;
  /** Referencia opaca de entidad (`ent_…`, D-10b) para agrupar por usuario o IP. */
  readonly entityRef?: string;
}

export interface IncidentQuery {
  readonly tenantId: string;
  readonly statuses?: readonly IncidentStatus[];
  readonly search?: string;
}

/**
 * Resultado de un listado: filas ya filtradas por tenant (como máximo el tope del adapter)
 * y total exacto. La paginación por cursor ocurre en el BFF sobre estas filas.
 */
export interface QueryResult<T> {
  readonly items: readonly T[];
  readonly total: number;
}

export interface SocReadModel {
  alertById(tenantId: string, alertId: string): Promise<Alert | undefined>;
  /** Una alerta por evento: base de la idempotencia de la promoción en el runtime. */
  alertByEventRecordId(tenantId: string, eventRecordId: string): Promise<Alert | undefined>;
  listAlerts(query: AlertQuery): Promise<QueryResult<Alert>>;
  incidentById(tenantId: string, incidentId: string): Promise<Incident | undefined>;
  listIncidents(query: IncidentQuery): Promise<QueryResult<Incident>>;
}

/* -------------------------------------------------------------------- Outbox */

/**
 * Cola durable del outbox SOC que consume el despacho de C-20, sin copias intermedias.
 *
 * `claimOutbox` reclama con lease: el mensaje queda `processing` hasta `at + leaseMs`. Si
 * el despachador muere, el lease vence y otro lo reclama; por eso la entrega es "al menos
 * una vez" y la idempotencia del intento de notificación evita el duplicado. Publicar o
 * reprogramar solo actúa sobre mensajes en `processing`.
 */
export interface SocOutboxQueue {
  claimOutbox(at: Date, limit: number, leaseMs: number): Promise<readonly ClaimedOutboxMessage[]>;
  /** `false` si el claim ya no es el vigente (lease vencido y reclamado por otro). */
  markOutboxPublished(messageId: string, claimToken: string, at: Date): Promise<boolean>;
  scheduleOutboxRetry(
    messageId: string,
    claimToken: string,
    availableAt: Date,
    errorCode: string,
  ): Promise<boolean>;
}

/**
 * Mensaje reclamado. `claimToken` es el fencing token del claim: solo quien lo tiene puede
 * publicar o reprogramar, así un despachador que perdió su lease no pisa al nuevo dueño.
 */
export interface ClaimedOutboxMessage extends OutboxMessageDraft {
  readonly claimToken: string;
}

/* ------------------------------------------------------------------- Salud */

/** Estado agregado de la cola del outbox de un tenant, para `GET /api/operations/health`. */
export interface OutboxHealth {
  readonly pending: number;
  readonly processing: number;
  /** Disponibilidad del pendiente más antiguo; `null` si no hay pendientes. */
  readonly oldestPendingAt: Date | null;
}

export interface SocHealthQuery {
  /** Instante de la alerta más reciente del tenant; `null` si nunca hubo. */
  lastAlertAt(tenantId: string): Promise<Date | null>;
  outboxHealth(tenantId: string): Promise<OutboxHealth>;
}

/* ---------------------------------------------------------------- Agregado */

export interface SocPersistence
  extends SocUnitOfWork, SocReadModel, SocOutboxQueue, CorrelationWindowQuery, SocHealthQuery {
  /** Nombre estable del adapter para health y logs: `memory` o `postgres`. */
  readonly kind: 'memory' | 'postgres';
  /**
   * Auditoría para escritores fuera de una unidad de trabajo SOC (inicio de sesión,
   * despacho) y para la consulta de C-19. Es la misma cadena que escribe `run`.
   */
  readonly audit: AuditStore;
  /** Comprueba conectividad y esquema; lanza si el adapter no puede atender. */
  ready(): Promise<void>;
  close(): Promise<void>;
}
