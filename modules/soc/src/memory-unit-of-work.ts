/**
 * Adapter en memoria de C-17, para unit specs, desarrollo local y el harness E2E.
 *
 * Implementa la propiedad que las specs deben poder comprobar: si el trabajo lanza, no
 * queda nada escrito —ni estado, ni candidato, ni auditoría, ni outbox—. Se consigue con
 * copia previa y restauración, que es lo que una transacción real hace por nosotros.
 *
 * No sobrevive a un reinicio. Por eso el runtime lo rechaza en el perfil de producción
 * salvo declaración explícita, y la readiness informa el modo efectivo.
 */

import { randomUUID } from 'node:crypto';

import { InMemoryAuditStore } from '@qapaq/audit';
import type { AuditStore, SealedAuditEvent } from '@qapaq/audit';
import type {
  CorrelatableAlert,
  DetectionCandidate,
  DetectionCandidateStore,
} from '@qapaq/detection';

import type { Alert } from './alert.js';
import type { Incident } from './incident.js';
import type { IncidentNote, IncidentTask } from './incident-work.js';
import { InMemoryIngestionState } from './memory-ingestion.js';
import type { OutboxMessageDraft } from './events.js';
import type {
  AlertQuery,
  AlertStore,
  ClaimedOutboxMessage,
  OutboxHealth,
  IncidentNoteStore,
  IncidentQuery,
  IncidentStore,
  IncidentTaskStore,
  OutboxStore,
  QueryResult,
  SocPersistence,
  SocTransactionContext,
} from './ports.js';

interface Snapshot {
  readonly alerts: ReadonlyMap<string, Alert>;
  readonly incidents: ReadonlyMap<string, Incident>;
  readonly tasks: ReadonlyMap<string, IncidentTask>;
  readonly notes: ReadonlyMap<string, IncidentNote>;
  readonly outbox: ReadonlyMap<string, OutboxMessageDraft>;
  readonly candidates: ReadonlyMap<string, DetectionCandidate>;
}

interface OutboxQueueState {
  status: 'pending' | 'processing' | 'published';
  availableAt: Date;
  attemptCount: number;
  leaseUntil: Date | null;
  claimToken: string | null;
  lastErrorCode: string | null;
  publishedAt: Date | null;
}

function newestFirst(left: { at: Date; id: string }, right: { at: Date; id: string }): number {
  const delta = right.at.getTime() - left.at.getTime();
  if (delta !== 0) return delta;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

export class InMemorySoc implements SocPersistence {
  public readonly kind = 'memory' as const;
  public readonly alertRows = new Map<string, Alert>();
  public readonly incidentRows = new Map<string, Incident>();
  public readonly taskRows = new Map<string, IncidentTask>();
  public readonly noteRows = new Map<string, IncidentNote>();
  public readonly outboxRows = new Map<string, OutboxMessageDraft>();
  public readonly candidateRows = new Map<string, DetectionCandidate>();
  /** Estado de cola por `messageId`: equivale a las columnas de lease de PostgreSQL. */
  public readonly outboxState = new Map<string, OutboxQueueState>();
  private auditStoreRef = new InMemoryAuditStore();
  /** Estado de ingesta; fuera de la unidad de trabajo, como en PostgreSQL. */
  public readonly ingestion = new InMemoryIngestionState();
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

  private readonly tasks: IncidentTaskStore = {
    byId: (tenantId, taskId) => Promise.resolve(this.taskRows.get(`${tenantId}|${taskId}`)),
    byIncident: (tenantId, incidentId) =>
      Promise.resolve(
        [...this.taskRows.values()].filter(
          (task) => task.tenantId === tenantId && task.incidentId === incidentId,
        ),
      ),
    insert: (task) => {
      this.taskRows.set(`${task.tenantId}|${task.id}`, task);
      return Promise.resolve();
    },
    update: (task, expectedRevision) => {
      const key = `${task.tenantId}|${task.id}`;
      const current = this.taskRows.get(key);
      if (!current || current.revision !== expectedRevision) return Promise.resolve(false);
      this.taskRows.set(key, task);
      return Promise.resolve(true);
    },
  };

  /** Append-only, igual que la tabla: sin update ni borrado. */
  private readonly notes: IncidentNoteStore = {
    byId: (tenantId, noteId) => Promise.resolve(this.noteRows.get(`${tenantId}|${noteId}`)),
    insert: (note) => {
      const key = `${note.tenantId}|${note.id}`;
      if (this.noteRows.has(key)) return Promise.reject(new Error('NOTE_ALREADY_EXISTS'));
      this.noteRows.set(key, note);
      return Promise.resolve();
    },
  };

  private readonly outbox: OutboxStore = {
    enqueueIfAbsent: (message) => {
      if (this.outboxRows.has(message.idempotencyKey)) return Promise.resolve(false);
      this.outboxRows.set(message.idempotencyKey, message);
      return Promise.resolve(true);
    },
  };

  private readonly candidates: DetectionCandidateStore = {
    byIdempotencyKey: (tenantId, key) =>
      Promise.resolve(this.candidateRows.get(`${tenantId}|${key}`)),
    insertIfAbsent: (candidate) => {
      const key = `${candidate.tenantId}|${candidate.idempotencyKey}`;
      if (this.candidateRows.has(key)) return Promise.resolve(false);
      this.candidateRows.set(key, candidate);
      return Promise.resolve(true);
    },
  };

  private snapshot(): Snapshot {
    return {
      alerts: new Map(this.alertRows),
      incidents: new Map(this.incidentRows),
      tasks: new Map(this.taskRows),
      notes: new Map(this.noteRows),
      outbox: new Map(this.outboxRows),
      candidates: new Map(this.candidateRows),
    };
  }

  /** Siempre la instancia vigente: un rollback la reemplaza. */
  public get auditStore(): InMemoryAuditStore {
    return this.auditStoreRef;
  }

  public get audit(): AuditStore {
    return this.auditStoreRef;
  }

  private restore(snapshot: Snapshot, auditBefore: readonly SealedAuditEvent[]): void {
    const replace = <T>(target: Map<string, T>, source: ReadonlyMap<string, T>) => {
      target.clear();
      for (const [key, value] of source) target.set(key, value);
    };
    replace(this.alertRows, snapshot.alerts);
    replace(this.incidentRows, snapshot.incidents);
    replace(this.taskRows, snapshot.tasks);
    replace(this.noteRows, snapshot.notes);
    replace(this.outboxRows, snapshot.outbox);
    replace(this.candidateRows, snapshot.candidates);
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
        tasks: this.tasks,
        notes: this.notes,
        outbox: this.outbox,
        audit: this.auditStoreRef as AuditStore,
        candidates: this.candidates,
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

  /* ---------------------------------------------------------------- Lecturas */

  public alertById(tenantId: string, alertId: string): Promise<Alert | undefined> {
    return Promise.resolve(this.alertRows.get(`${tenantId}|${alertId}`));
  }

  public alertByEventRecordId(tenantId: string, eventRecordId: string): Promise<Alert | undefined> {
    return Promise.resolve(
      [...this.alertRows.values()].find(
        (alert) => alert.tenantId === tenantId && alert.eventRecordId === eventRecordId,
      ),
    );
  }

  public listAlerts(query: AlertQuery): Promise<QueryResult<Alert>> {
    const search = query.search?.trim();
    const items = [...this.alertRows.values()]
      .filter((alert) => alert.tenantId === query.tenantId)
      .filter((alert) =>
        query.status === 'open'
          ? alert.status !== 'closed'
          : !query.status || alert.status === query.status,
      )
      .filter((alert) => !query.priority || alert.priority === query.priority)
      .filter((alert) => !query.entityRef || alert.entityRefs.includes(query.entityRef))
      .filter(
        (alert) =>
          !search ||
          `${alert.title} ${alert.id} ${alert.assigneeId ?? ''}`
            .toLocaleLowerCase()
            .includes(search),
      )
      .sort((left, right) =>
        newestFirst({ at: left.occurredAt, id: left.id }, { at: right.occurredAt, id: right.id }),
      );
    return Promise.resolve({ items, total: items.length });
  }

  public incidentById(tenantId: string, incidentId: string): Promise<Incident | undefined> {
    return Promise.resolve(this.incidentRows.get(`${tenantId}|${incidentId}`));
  }

  public listIncidentAlerts(
    tenantId: string,
    incidentId: string,
    limit: number,
  ): Promise<QueryResult<Alert>> {
    const linked = [...this.alertRows.values()]
      .filter((alert) => alert.tenantId === tenantId && alert.incidentId === incidentId)
      .sort((left, right) =>
        newestFirst({ at: left.occurredAt, id: left.id }, { at: right.occurredAt, id: right.id }),
      );
    return Promise.resolve({ items: linked.slice(0, limit), total: linked.length });
  }

  public listIncidentTasks(tenantId: string, incidentId: string): Promise<readonly IncidentTask[]> {
    return Promise.resolve(
      [...this.taskRows.values()]
        .filter((task) => task.tenantId === tenantId && task.incidentId === incidentId)
        .sort((left, right) =>
          newestFirst({ at: left.createdAt, id: left.id }, { at: right.createdAt, id: right.id }),
        ),
    );
  }

  public listIncidentNotes(tenantId: string, incidentId: string): Promise<readonly IncidentNote[]> {
    return Promise.resolve(
      [...this.noteRows.values()]
        .filter((note) => note.tenantId === tenantId && note.incidentId === incidentId)
        .sort((left, right) =>
          newestFirst({ at: left.createdAt, id: left.id }, { at: right.createdAt, id: right.id }),
        ),
    );
  }

  public listIncidents(query: IncidentQuery): Promise<QueryResult<Incident>> {
    const search = query.search?.trim();
    const items = [...this.incidentRows.values()]
      .filter((incident) => incident.tenantId === query.tenantId)
      .filter(
        (incident) =>
          !query.statuses ||
          query.statuses.length === 0 ||
          query.statuses.includes(incident.status),
      )
      .filter(
        (incident) =>
          !search ||
          `${incident.title} ${incident.id} ${incident.ownerId} ${incident.summary}`
            .toLocaleLowerCase()
            .includes(search),
      )
      .sort((left, right) =>
        newestFirst({ at: left.openedAt, id: left.id }, { at: right.openedAt, id: right.id }),
      );
    return Promise.resolve({ items, total: items.length });
  }

  /* ------------------------------------------------------------ Correlación */

  public recentByEntities(
    tenantId: string,
    entityKeys: readonly string[],
    since: Date,
    limit: number,
  ): Promise<readonly CorrelatableAlert[]> {
    const wanted = new Set(entityKeys);
    const rows = [...this.alertRows.values()]
      .filter(
        (alert) =>
          alert.tenantId === tenantId &&
          alert.occurredAt.getTime() >= since.getTime() &&
          alert.entityKeys.some((key) => wanted.has(key)),
      )
      .sort((left, right) =>
        newestFirst({ at: left.occurredAt, id: left.id }, { at: right.occurredAt, id: right.id }),
      )
      .slice(0, Math.max(limit, 1))
      .map((alert) => ({
        id: alert.id,
        occurredAt: alert.occurredAt,
        entityKeys: alert.entityKeys,
        signal: alert.signal,
        ruleId: alert.ruleId,
      }));
    return Promise.resolve(rows);
  }

  /* ------------------------------------------------------------------ Outbox */

  private stateOf(message: OutboxMessageDraft): OutboxQueueState {
    let state = this.outboxState.get(message.messageId);
    if (!state) {
      state = {
        status: 'pending',
        availableAt: message.availableAt,
        attemptCount: 0,
        leaseUntil: null,
        claimToken: null,
        lastErrorCode: null,
        publishedAt: null,
      };
      this.outboxState.set(message.messageId, state);
    }
    return state;
  }

  /** Misma semántica que el claim con lease y fencing de PostgreSQL, en un solo hilo. */
  public claimOutbox(
    at: Date,
    limit: number,
    leaseMs: number,
  ): Promise<readonly ClaimedOutboxMessage[]> {
    const now = at.getTime();
    const claimable = [...this.outboxRows.values()]
      .filter((message) => {
        const state = this.stateOf(message);
        if (state.status === 'pending') return state.availableAt.getTime() <= now;
        return state.status === 'processing' && (state.leaseUntil?.getTime() ?? 0) < now;
      })
      .sort(
        (left, right) =>
          this.stateOf(left).availableAt.getTime() - this.stateOf(right).availableAt.getTime() ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, Math.max(limit, 1));
    return Promise.resolve(
      claimable.map((message) => {
        const state = this.stateOf(message);
        state.status = 'processing';
        state.leaseUntil = new Date(now + Math.max(leaseMs, 1_000));
        state.claimToken = randomUUID();
        state.attemptCount += 1;
        return { ...message, claimToken: state.claimToken };
      }),
    );
  }

  /** Solo el claim vigente (estado y token) puede cerrar el mensaje. */
  private ownedClaim(messageId: string, claimToken: string): OutboxQueueState | undefined {
    const state = this.outboxState.get(messageId);
    return state?.status === 'processing' && state.claimToken === claimToken ? state : undefined;
  }

  public markOutboxPublished(messageId: string, claimToken: string, at: Date): Promise<boolean> {
    const state = this.ownedClaim(messageId, claimToken);
    if (state) {
      state.status = 'published';
      state.publishedAt = at;
      state.leaseUntil = null;
      state.claimToken = null;
    }
    return Promise.resolve(state !== undefined);
  }

  public scheduleOutboxRetry(
    messageId: string,
    claimToken: string,
    availableAt: Date,
    errorCode: string,
  ): Promise<boolean> {
    const state = this.ownedClaim(messageId, claimToken);
    if (state) {
      state.status = 'pending';
      state.availableAt = availableAt;
      state.leaseUntil = null;
      state.claimToken = null;
      state.lastErrorCode = errorCode;
    }
    return Promise.resolve(state !== undefined);
  }

  /* ------------------------------------------------------------------- Salud */

  public lastAlertAt(tenantId: string): Promise<Date | null> {
    let latest: Date | null = null;
    for (const alert of this.alertRows.values()) {
      if (alert.tenantId !== tenantId) continue;
      if (!latest || alert.occurredAt.getTime() > latest.getTime()) latest = alert.occurredAt;
    }
    return Promise.resolve(latest);
  }

  public outboxHealth(tenantId: string): Promise<OutboxHealth> {
    let pending = 0;
    let processing = 0;
    let oldestPendingAt: Date | null = null;
    for (const message of this.outboxRows.values()) {
      if (message.tenantId !== tenantId) continue;
      const state = this.stateOf(message);
      if (state.status === 'processing') processing += 1;
      if (state.status !== 'pending') continue;
      pending += 1;
      if (!oldestPendingAt || state.availableAt.getTime() < oldestPendingAt.getTime()) {
        oldestPendingAt = state.availableAt;
      }
    }
    return Promise.resolve({ pending, processing, oldestPendingAt });
  }

  public ready(): Promise<void> {
    return Promise.resolve();
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}
