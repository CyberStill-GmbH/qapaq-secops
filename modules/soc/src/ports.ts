/**
 * Puertos de C-17.
 *
 * `SocUnitOfWork.run` recibe el trabajo completo y lo ejecuta en una sola transacción.
 * Es el punto donde se cumple el contrato con C-19 y C-20: estado, AuditEvent y mensaje
 * de outbox entran juntos o no entra ninguno. Un adapter que abra tres transacciones
 * distintas incumple aunque los tres escriban.
 */

import type { AuditStore } from '@qapaq/audit';

import type { Alert } from './alert.js';
import type { Incident } from './incident.js';
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
}

export interface SocUnitOfWork {
  run<T>(work: (context: SocTransactionContext) => Promise<T>): Promise<T>;
}
