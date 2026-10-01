/**
 * Unidad de trabajo en memoria de C-17, para unit specs y para el harness E2E.
 *
 * Implementa la propiedad que las specs deben poder comprobar: si el trabajo lanza, no
 * queda nada escrito —ni estado, ni auditoría, ni outbox—. Se consigue con copia previa
 * y restauración, que es lo que una transacción real hace por nosotros.
 */

import { InMemoryAuditStore } from '@qapaq/audit';
import type { AuditStore, SealedAuditEvent } from '@qapaq/audit';

import type { Alert } from './alert.js';
import type { Incident } from './incident.js';
import type { OutboxMessageDraft } from './events.js';
import type {
  AlertStore,
  IncidentStore,
  OutboxStore,
  SocTransactionContext,
  SocUnitOfWork,
} from './ports.js';

interface Snapshot {
  readonly alerts: ReadonlyMap<string, Alert>;
  readonly incidents: ReadonlyMap<string, Incident>;
  readonly outbox: ReadonlyMap<string, OutboxMessageDraft>;
  readonly audit: readonly SealedAuditEvent[];
}

export class InMemorySoc implements SocUnitOfWork {
  public readonly alertRows = new Map<string, Alert>();
  public readonly incidentRows = new Map<string, Incident>();
  public readonly outboxRows = new Map<string, OutboxMessageDraft>();
  private auditStoreRef = new InMemoryAuditStore();
  /** Fuerza el fallo del commit en la siguiente transacción, para specs de rollback. */
  public failNextCommit = false;

  private readonly alerts: AlertStore = {
    byId: (tenantId, alertId) => Promise.resolve(this.alertRows.get(`${tenantId}|${alertId}`)),
    insertIfAbsent: (alert) => {
      const key = `${alert.tenantId}|${alert.id}`;
      if (this.alertRows.has(key)) return Promise.resolve(false);
      this.alertRows.set(key, alert);
      return Promise.resolve(true);
    },
    update: (alert, expectedRevision) => {
      const key = `${alert.tenantId}|${alert.id}`;
      const current = this.alertRows.get(key);
      if (!current || current.revision !== expectedRevision) return Promise.resolve(false);
      this.alertRows.set(key, alert);
      return Promise.resolve(true);
    },
    byIncident: (tenantId, incidentId) =>
      Promise.resolve(
        [...this.alertRows.values()].filter(
          (alert) => alert.tenantId === tenantId && alert.incidentId === incidentId,
        ),
      ),
  };

  private readonly incidents: IncidentStore = {
    byId: (tenantId, incidentId) =>
      Promise.resolve(this.incidentRows.get(`${tenantId}|${incidentId}`)),
    insert: (incident) => {
      this.incidentRows.set(`${incident.tenantId}|${incident.id}`, incident);
      return Promise.resolve();
    },
    update: (incident, expectedRevision) => {
      const key = `${incident.tenantId}|${incident.id}`;
      const current = this.incidentRows.get(key);
      if (!current || current.revision !== expectedRevision) return Promise.resolve(false);
      this.incidentRows.set(key, incident);
      return Promise.resolve(true);
    },
  };

  private readonly outbox: OutboxStore = {
    enqueueIfAbsent: (message) => {
      if (this.outboxRows.has(message.idempotencyKey)) return Promise.resolve(false);
      this.outboxRows.set(message.idempotencyKey, message);
      return Promise.resolve(true);
    },
  };

  private snapshot(): Snapshot {
    return {
      alerts: new Map(this.alertRows),
      incidents: new Map(this.incidentRows),
      outbox: new Map(this.outboxRows),
      audit: [],
    };
  }

  public get auditStore(): InMemoryAuditStore {
    return this.auditStoreRef;
  }

  private restore(snapshot: Snapshot, auditBefore: readonly SealedAuditEvent[]): void {
    this.alertRows.clear();
    for (const [key, value] of snapshot.alerts) this.alertRows.set(key, value);
    this.incidentRows.clear();
    for (const [key, value] of snapshot.incidents) this.incidentRows.set(key, value);
    this.outboxRows.clear();
    for (const [key, value] of snapshot.outbox) this.outboxRows.set(key, value);
    this.auditRollback(auditBefore);
  }

  /**
   * La auditoría no admite borrado por contrato. Para restaurar el estado previo se
   * reconstruye el store completo, que es justo lo que hace un ROLLBACK: la fila nunca
   * llegó a existir.
   */
  private auditRollback(before: readonly SealedAuditEvent[]): void {
    const replacement = new InMemoryAuditStore();
    for (const event of before) void replacement.append(event);
    this.auditStoreRef = replacement;
  }

  public async run<T>(work: (context: SocTransactionContext) => Promise<T>): Promise<T> {
    const snapshot = this.snapshot();
    const auditBefore = await this.allAudit();
    try {
      const result = await work({
        alerts: this.alerts,
        incidents: this.incidents,
        outbox: this.outbox,
        audit: this.auditStoreRef as AuditStore,
      });
      if (this.failNextCommit) {
        this.failNextCommit = false;
        throw new Error('COMMIT_FAILED');
      }
      return result;
    } catch (error) {
      this.restore(snapshot, auditBefore);
      throw error;
    }
  }

  public async allAudit(): Promise<readonly SealedAuditEvent[]> {
    const events: SealedAuditEvent[] = [];
    for (const tenant of this.auditStoreRef.tenants()) {
      events.push(...(await this.auditStoreRef.range(tenant, 1n, 1_000)));
    }
    return events;
  }
}
