/**
 * Adapter PostgreSQL de C-17: implementa `SocPersistence` sobre los stores Prisma de
 * `@qapaq/database`.
 *
 * Responsabilidades de este archivo, y solo estas:
 *
 * 1. Traducir filas planas a tipos de dominio y viceversa. Los stores de `platform` no
 *    conocen `Alert` ni `Incident`; aquí se valida que los catálogos leídos (estado,
 *    prioridad, señal) sigan siendo los del dominio. Una fila con un valor desconocido es
 *    un error de integridad y se reporta, no se adivina.
 * 2. Componer la unidad de trabajo: alertas, incidentes, candidatos, outbox y auditoría
 *    comparten la misma transacción (`PrismaSocUnitOfWork`).
 * 3. Exponer lecturas, ventana de correlación y relay del outbox fuera de transacción.
 *
 * Se publica como subpath (`@qapaq/soc/postgres`) para que un runtime en memoria no cargue
 * Prisma ni el driver de PostgreSQL.
 */

import type { AuditStore, SealedAuditEvent } from '@qapaq/audit';
import {
  closeDatabaseClient,
  createDatabaseClient,
  PrismaAuditStore,
  PrismaSocQueries,
  PrismaSocUnitOfWork,
  PrismaStandaloneAuditStore,
  type AlertRow,
  type CandidateRow,
  type DatabaseConnectionOptions,
  type IncidentRow,
  type IncidentWithAlertsRow,
  type SealedAuditRow,
} from '@qapaq/database';
import {
  PRIORITIES,
  SIGNAL_CLASSES,
  type CorrelatableAlert,
  type DetectionCandidate,
  type DetectionCandidateStore,
  type Priority,
  type Reason,
  type SignalClass,
} from '@qapaq/detection';

import { ALERT_STATUSES, TRIAGE_VERDICTS, type Alert } from '../alert.js';
import { INCIDENT_SEVERITIES, INCIDENT_STATUSES, type Incident } from '../incident.js';
import type { OutboxMessageDraft, SocEventType } from '../events.js';
import type {
  AlertQuery,
  AlertStore,
  ClaimedOutboxMessage,
  OutboxHealth,
  IncidentQuery,
  IncidentStore,
  OutboxStore,
  QueryResult,
  SocPersistence,
  SocTransactionContext,
} from '../ports.js';

/** Fila con un valor fuera del catálogo del dominio: la base y el código divergieron. */
export class SocIntegrityError extends Error {
  public constructor(
    public readonly table: string,
    public readonly column: string,
  ) {
    super(`Valor fuera de catálogo en ${table}.${column}.`);
    this.name = 'SocIntegrityError';
  }
}

function oneOf<T extends string>(
  catalog: readonly T[],
  value: string,
  table: string,
  column: string,
): T {
  if (!(catalog as readonly string[]).includes(value)) throw new SocIntegrityError(table, column);
  return value as T;
}

function optionalOneOf<T extends string>(
  catalog: readonly T[],
  value: string | null,
  table: string,
  column: string,
): T | null {
  return value === null ? null : oneOf(catalog, value, table, column);
}

/* --------------------------------------------------------------- Traducción */

function toAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    tenantId: row.tenantId,
    candidateId: row.candidateId,
    eventRecordId: row.eventRecordId,
    title: row.title,
    priority: oneOf(PRIORITIES, row.priority, 'soc_alerts', 'priority'),
    score: row.score,
    reasons: row.reasons as readonly Reason[],
    status: oneOf(ALERT_STATUSES, row.status, 'soc_alerts', 'status'),
    assigneeId: row.assigneeId,
    verdict: optionalOneOf(TRIAGE_VERDICTS, row.verdict, 'soc_alerts', 'verdict'),
    triageNote: row.triageNote,
    incidentId: row.incidentId,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision,
    entityKeys: [...row.entityKeys],
    entityRefs: [...row.entityRefs],
    signal: optionalOneOf(SIGNAL_CLASSES, row.signal, 'soc_alerts', 'signal'),
    ruleId: row.ruleId,
    relatedAlertIds: [...row.relatedAlertIds],
  };
}

function fromAlert(alert: Alert): AlertRow {
  return { ...alert, reasons: alert.reasons };
}

function toIncident(row: IncidentWithAlertsRow): Incident {
  return {
    id: row.id,
    tenantId: row.tenantId,
    title: row.title,
    severity: oneOf(INCIDENT_SEVERITIES, row.severity, 'soc_incidents', 'severity'),
    status: oneOf(INCIDENT_STATUSES, row.status, 'soc_incidents', 'status'),
    ownerId: row.ownerId,
    alertIds: [...row.alertIds],
    summary: row.summary,
    openedAt: row.openedAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt,
    closureReason: row.closureReason,
    revision: row.revision,
  };
}

/** `alertIds` no es columna: la relación vive en `soc_alerts.incident_id`. */
function fromIncident(incident: Incident): IncidentRow {
  const { alertIds: _alertIds, ...row } = incident;
  return row;
}

function toCandidate(row: CandidateRow): DetectionCandidate {
  return {
    id: row.id,
    tenantId: row.tenantId,
    eventRecordId: row.eventRecordId,
    eventUid: row.eventUid,
    idempotencyKey: row.idempotencyKey,
    priority: oneOf(PRIORITIES, row.priority, 'detection_candidates', 'priority') as Priority,
    score: row.score,
    reasons: row.reasons as readonly Reason[],
    rulesetId: row.rulesetId,
    rulesetVersion: row.rulesetVersion,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
    title: row.title,
    entityKeys: [...row.entityKeys],
    signal: (optionalOneOf(SIGNAL_CLASSES, row.signal, 'detection_candidates', 'signal') ??
      'other') as SignalClass,
    ruleId: row.ruleId,
    relatedAlertIds: [...row.relatedAlertIds],
  };
}

function toOutboxDraft(row: {
  readonly messageId: string;
  readonly tenantId: string;
  readonly aggregateType: 'alert' | 'incident';
  readonly aggregateId: string;
  readonly messageType: string;
  readonly schemaVersion: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
  readonly availableAt: Date;
}): OutboxMessageDraft {
  return { ...row, messageType: row.messageType as SocEventType };
}

/**
 * La fila de auditoría y el evento sellado del puerto tienen la misma forma; solo difiere
 * el tipo de `metadata` (`unknown` en la fila, valor canónico en el puerto). Lo que la
 * base devuelve se escribió a través de este mismo puerto, por eso la conversión es segura
 * y queda concentrada aquí.
 */
function auditPort(store: PrismaAuditStore | PrismaStandaloneAuditStore): AuditStore {
  return {
    head: (tenantId) => store.head(tenantId),
    append: (event: SealedAuditEvent) => store.append(event as SealedAuditRow),
    read: async (query) => {
      const page = await store.read(query);
      return { events: page.events as readonly SealedAuditEvent[], nextCursor: page.nextCursor };
    },
    range: async (tenantId, fromSequence, limit) =>
      (await store.range(tenantId, fromSequence, limit)) as readonly SealedAuditEvent[],
  };
}

/* ------------------------------------------------------------------ Adapter */

export class PostgresSocPersistence implements SocPersistence {
  public readonly kind = 'postgres' as const;
  public readonly audit: AuditStore;
  private readonly unitOfWork: PrismaSocUnitOfWork;
  private readonly queries: PrismaSocQueries;

  private constructor(private readonly client: ReturnType<typeof createDatabaseClient>) {
    this.unitOfWork = new PrismaSocUnitOfWork(client);
    this.queries = new PrismaSocQueries(client);
    this.audit = auditPort(new PrismaStandaloneAuditStore(client));
  }

  public static connect(options: DatabaseConnectionOptions): PostgresSocPersistence {
    return new PostgresSocPersistence(createDatabaseClient(options));
  }

  public run<T>(work: (context: SocTransactionContext) => Promise<T>): Promise<T> {
    return this.unitOfWork.run((stores) => {
      const alerts: AlertStore = {
        byId: async (tenantId, alertId) => {
          const row = await stores.alerts.byId(tenantId, alertId);
          return row ? toAlert(row) : undefined;
        },
        insertIfAbsent: (alert) => stores.alerts.insertIfAbsent(fromAlert(alert)),
        update: (alert, expectedRevision) =>
          stores.alerts.update(fromAlert(alert), expectedRevision),
        byIncident: async (tenantId, incidentId) =>
          (await stores.alerts.byIncident(tenantId, incidentId)).map(toAlert),
      };
      const incidents: IncidentStore = {
        byId: async (tenantId, incidentId) => {
          const row = await stores.incidents.byId(tenantId, incidentId);
          if (!row) return undefined;
          const linked = await stores.alerts.byIncident(tenantId, incidentId);
          return toIncident({ ...row, alertIds: linked.map((alert) => alert.id) });
        },
        insert: (incident) => stores.incidents.insert(fromIncident(incident)),
        update: (incident, expectedRevision) =>
          stores.incidents.update(fromIncident(incident), expectedRevision),
      };
      const outbox: OutboxStore = {
        enqueueIfAbsent: (message) => stores.outbox.enqueueIfAbsent(message),
      };
      const candidates: DetectionCandidateStore = {
        byIdempotencyKey: async (tenantId, key) => {
          const row = await stores.candidates.byIdempotencyKey(tenantId, key);
          return row ? toCandidate(row) : undefined;
        },
        insertIfAbsent: (candidate) => stores.candidates.insertIfAbsent(candidate),
      };
      return work({
        alerts,
        incidents,
        outbox,
        candidates,
        audit: auditPort(stores.audit),
      });
    });
  }

  public async alertById(tenantId: string, alertId: string): Promise<Alert | undefined> {
    const row = await this.queries.alertById(tenantId, alertId);
    return row ? toAlert(row) : undefined;
  }

  public async alertByEventRecordId(
    tenantId: string,
    eventRecordId: string,
  ): Promise<Alert | undefined> {
    const row = await this.queries.alertByEventRecordId(tenantId, eventRecordId);
    return row ? toAlert(row) : undefined;
  }

  public async listAlerts(query: AlertQuery): Promise<QueryResult<Alert>> {
    const result = await this.queries.listAlerts({
      tenantId: query.tenantId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(query.entityRef ? { entityRef: query.entityRef } : {}),
    });
    return { items: result.rows.map(toAlert), total: result.total };
  }

  public async incidentById(tenantId: string, incidentId: string): Promise<Incident | undefined> {
    const row = await this.queries.incidentById(tenantId, incidentId);
    return row ? toIncident(row) : undefined;
  }

  public async listIncidents(query: IncidentQuery): Promise<QueryResult<Incident>> {
    const result = await this.queries.listIncidents({
      tenantId: query.tenantId,
      ...(query.statuses ? { statuses: query.statuses } : {}),
      ...(query.search ? { search: query.search } : {}),
    });
    return { items: result.rows.map(toIncident), total: result.total };
  }

  public async recentByEntities(
    tenantId: string,
    entityKeys: readonly string[],
    since: Date,
    limit: number,
  ): Promise<readonly CorrelatableAlert[]> {
    const rows = await this.queries.recentByEntities(tenantId, entityKeys, since, limit);
    return rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt,
      entityKeys: [...row.entityKeys],
      signal: optionalOneOf(SIGNAL_CLASSES, row.signal, 'soc_alerts', 'signal'),
      ruleId: row.ruleId,
    }));
  }

  public async claimOutbox(
    at: Date,
    limit: number,
    leaseMs: number,
  ): Promise<readonly ClaimedOutboxMessage[]> {
    return (await this.queries.claimOutbox(at, limit, leaseMs)).map((row) => ({
      ...toOutboxDraft(row),
      claimToken: row.claimToken,
    }));
  }

  public markOutboxPublished(messageId: string, claimToken: string, at: Date): Promise<boolean> {
    return this.queries.markOutboxPublished(messageId, claimToken, at);
  }

  public scheduleOutboxRetry(
    messageId: string,
    claimToken: string,
    availableAt: Date,
    errorCode: string,
  ): Promise<boolean> {
    return this.queries.scheduleOutboxRetry(messageId, claimToken, availableAt, errorCode);
  }

  public lastAlertAt(tenantId: string): Promise<Date | null> {
    return this.queries.lastAlertAt(tenantId);
  }

  public outboxHealth(tenantId: string): Promise<OutboxHealth> {
    return this.queries.outboxHealth(tenantId);
  }

  /**
   * Readiness: conectividad y presencia de la última migración que este código necesita.
   * Arrancar contra un esquema viejo produciría errores en la primera alerta, no al inicio.
   */
  public async ready(): Promise<void> {
    // `lease_until` es la última columna que este código necesita: si existe, el esquema
    // está al día con la migración 20261011120000.
    const rows = await this.client.$queryRaw<{ readonly present: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'soc_outbox_messages'
           AND column_name = 'lease_until'
      ) AS present`;
    if (!rows[0]?.present) {
      throw new Error('SOC_SCHEMA_OUTDATED: falta la migración 20261011120000.');
    }
  }

  public close(): Promise<void> {
    return closeDatabaseClient(this.client);
  }
}
