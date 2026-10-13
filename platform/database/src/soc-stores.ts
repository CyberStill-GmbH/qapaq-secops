/**
 * Adaptadores PostgreSQL de C-17, C-19 y C-20.
 *
 * Todo el trabajo de un caso de uso —estado, AuditEvent y mensaje de outbox— ocurre en
 * una sola transacción (`PrismaSocUnitOfWork`). Esa es la única forma de que la promesa
 * del dominio se cumpla: si el commit falla, no queda ni alerta huérfana, ni auditoría
 * de algo que no pasó, ni notificación de un hecho que se deshizo.
 *
 * Los `update` usan compare-and-set sobre `revision` y devuelven `false` en lugar de
 * lanzar: el conflicto por concurrencia es un resultado esperado del negocio, no un
 * error de infraestructura.
 *
 * Además del lado de escritura, este archivo expone `PrismaSocQueries`: lecturas fuera de
 * transacción para los listados del BFF, la ventana de correlación de C-16 y el relay del
 * outbox. Los tipos son filas planas; la traducción al dominio vive en el adapter del
 * módulo SOC, de modo que `platform` no depende de `modules`.
 */

import type { Prisma, PrismaClient } from '../generated/client/client.js';
import { PrismaIncidentNoteStore, PrismaIncidentTaskStore } from './incident-work-stores.js';
import { runDatabaseTransaction } from './transaction.js';

type Tx = Prisma.TransactionClient;

/* ------------------------------------------------------------------ Auditoría */

export interface SealedAuditRow {
  readonly id: string;
  readonly tenantId: string;
  readonly sequence: bigint;
  readonly occurredAt: Date;
  readonly actor: {
    readonly id: string;
    readonly type: 'user' | 'service' | 'system';
    readonly sessionId?: string;
    readonly ip?: string;
  };
  readonly action: string;
  readonly resource: { readonly type: string; readonly id: string };
  readonly outcome: 'allowed' | 'denied' | 'succeeded' | 'failed';
  readonly correlationId: string;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly previousHash: string;
  readonly hash: string;
}

interface AuditQueryShape {
  readonly tenantId: string;
  readonly from: Date;
  readonly to: Date;
  readonly pageSize: number;
  readonly cursor: string | null;
  readonly action: string | null;
  readonly actorId: string | null;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly outcome: readonly string[];
}

function toAuditRow(row: {
  id: string;
  tenantId: string;
  sequence: bigint;
  occurredAt: Date;
  actorId: string;
  actorType: string;
  actorSession: string | null;
  actorIp: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  outcome: string;
  correlationId: string;
  reason: string | null;
  metadata: unknown;
  previousHash: string;
  hash: string;
}): SealedAuditRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    sequence: row.sequence,
    occurredAt: row.occurredAt,
    actor: {
      id: row.actorId,
      type: row.actorType as 'user' | 'service' | 'system',
      ...(row.actorSession === null ? {} : { sessionId: row.actorSession }),
      ...(row.actorIp === null ? {} : { ip: row.actorIp }),
    },
    action: row.action,
    resource: { type: row.resourceType, id: row.resourceId },
    outcome: row.outcome as SealedAuditRow['outcome'],
    correlationId: row.correlationId,
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.metadata === null || row.metadata === undefined
      ? {}
      : { metadata: row.metadata as Record<string, unknown> }),
    previousHash: row.previousHash,
    hash: row.hash,
  };
}

export class PrismaAuditStore {
  public constructor(private readonly tx: Tx) {}

  public async head(
    tenantId: string,
  ): Promise<{ readonly sequence: bigint; readonly hash: string } | undefined> {
    // Dentro de una transacción, una violación de unicidad aborta la transacción completa
    // y el reintento de `recordAudit` ya no puede ejecutarse. Por eso la cabeza se lee
    // bajo un advisory lock por tenant: los escritores concurrentes de la misma cadena se
    // serializan hasta el commit y la unicidad `(tenant, sequence)` queda como red final.
    await this.tx
      .$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`audit:${tenantId}`}, 0))`;
    const last = await this.tx.auditEvent.findFirst({
      where: { tenantId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true, hash: true },
    });
    return last ?? undefined;
  }

  public async append(event: SealedAuditRow): Promise<void> {
    await this.tx.auditEvent.create({
      data: {
        id: event.id,
        tenantId: event.tenantId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        actorId: event.actor.id,
        actorType: event.actor.type,
        actorSession: event.actor.sessionId ?? null,
        actorIp: event.actor.ip ?? null,
        action: event.action,
        resourceType: event.resource.type,
        resourceId: event.resource.id,
        outcome: event.outcome,
        correlationId: event.correlationId,
        reason: event.reason ?? null,
        metadata: (event.metadata ?? null) as Prisma.InputJsonValue,
        previousHash: event.previousHash,
        hash: event.hash,
      },
    });
  }

  public async read(query: AuditQueryShape): Promise<{
    readonly events: readonly SealedAuditRow[];
    readonly nextCursor: string | null;
  }> {
    const rows = await this.tx.auditEvent.findMany({
      where: {
        tenantId: query.tenantId,
        occurredAt: { gte: query.from, lte: query.to },
        ...(query.cursor ? { sequence: { gt: BigInt(query.cursor) } } : {}),
        ...(query.action ? { action: query.action } : {}),
        ...(query.actorId ? { actorId: query.actorId } : {}),
        ...(query.resourceType ? { resourceType: query.resourceType } : {}),
        ...(query.resourceId ? { resourceId: query.resourceId } : {}),
        ...(query.outcome.length > 0 ? { outcome: { in: [...query.outcome] } } : {}),
      },
      orderBy: { sequence: 'asc' },
      take: query.pageSize + 1,
    });
    const page = rows.slice(0, query.pageSize).map(toAuditRow);
    const last = page.at(-1);
    return {
      events: page,
      nextCursor: rows.length > page.length && last ? last.sequence.toString() : null,
    };
  }

  public async range(
    tenantId: string,
    fromSequence: bigint,
    limit: number,
  ): Promise<readonly SealedAuditRow[]> {
    const rows = await this.tx.auditEvent.findMany({
      where: { tenantId, sequence: { gte: fromSequence } },
      orderBy: { sequence: 'asc' },
      take: limit,
    });
    return rows.map(toAuditRow);
  }
}

/* ----------------------------------------------------------------- Alertas */

export interface AlertRow {
  readonly id: string;
  readonly tenantId: string;
  readonly candidateId: string;
  readonly eventRecordId: string;
  readonly title: string;
  readonly priority: string;
  readonly score: number;
  readonly reasons: readonly {
    readonly code: string;
    readonly delta: number;
    readonly detail: string;
  }[];
  readonly status: string;
  readonly assigneeId: string | null;
  readonly verdict: string | null;
  readonly triageNote: string | null;
  readonly incidentId: string | null;
  readonly occurredAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly revision: number;
  readonly entityKeys: readonly string[];
  readonly entityRefs: readonly string[];
  readonly signal: string | null;
  readonly ruleId: string | null;
  readonly relatedAlertIds: readonly string[];
}

export class PrismaAlertStore {
  public constructor(private readonly tx: Tx) {}

  public async byId(tenantId: string, alertId: string): Promise<AlertRow | undefined> {
    const row = await this.tx.socAlert.findFirst({ where: { id: alertId, tenantId } });
    return row ? (row as unknown as AlertRow) : undefined;
  }

  public async insertIfAbsent(alert: AlertRow): Promise<boolean> {
    const created = await this.tx.socAlert.createMany({
      data: [
        {
          id: alert.id,
          tenantId: alert.tenantId,
          candidateId: alert.candidateId,
          eventRecordId: alert.eventRecordId,
          title: alert.title,
          priority: alert.priority,
          score: alert.score,
          reasons: alert.reasons as unknown as Prisma.InputJsonValue,
          status: alert.status,
          assigneeId: alert.assigneeId,
          verdict: alert.verdict,
          triageNote: alert.triageNote,
          incidentId: alert.incidentId,
          occurredAt: alert.occurredAt,
          createdAt: alert.createdAt,
          updatedAt: alert.updatedAt,
          revision: alert.revision,
          entityKeys: [...alert.entityKeys],
          entityRefs: [...alert.entityRefs],
          signal: alert.signal,
          ruleId: alert.ruleId,
          relatedAlertIds: [...alert.relatedAlertIds],
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }

  public async update(alert: AlertRow, expectedRevision: number): Promise<boolean> {
    const updated = await this.tx.socAlert.updateMany({
      where: { id: alert.id, tenantId: alert.tenantId, revision: expectedRevision },
      data: {
        status: alert.status,
        assigneeId: alert.assigneeId,
        verdict: alert.verdict,
        triageNote: alert.triageNote,
        incidentId: alert.incidentId,
        updatedAt: alert.updatedAt,
        revision: alert.revision,
      },
    });
    return updated.count === 1;
  }

  public async byIncident(tenantId: string, incidentId: string): Promise<readonly AlertRow[]> {
    const rows = await this.tx.socAlert.findMany({ where: { tenantId, incidentId } });
    return rows as unknown as readonly AlertRow[];
  }
}

/* --------------------------------------------------------------- Incidentes */

export interface IncidentRow {
  readonly id: string;
  readonly tenantId: string;
  readonly title: string;
  readonly severity: string;
  readonly status: string;
  readonly ownerId: string;
  readonly summary: string;
  readonly openedAt: Date;
  readonly updatedAt: Date;
  readonly closedAt: Date | null;
  readonly closureReason: string | null;
  readonly revision: number;
}

export class PrismaIncidentStore {
  public constructor(private readonly tx: Tx) {}

  public async byId(tenantId: string, incidentId: string): Promise<IncidentRow | undefined> {
    const row = await this.tx.socIncident.findFirst({ where: { id: incidentId, tenantId } });
    return row ?? undefined;
  }

  public async insert(incident: IncidentRow): Promise<void> {
    await this.tx.socIncident.create({ data: { ...incident } });
  }

  public async update(incident: IncidentRow, expectedRevision: number): Promise<boolean> {
    const updated = await this.tx.socIncident.updateMany({
      where: { id: incident.id, tenantId: incident.tenantId, revision: expectedRevision },
      data: {
        title: incident.title,
        severity: incident.severity,
        status: incident.status,
        ownerId: incident.ownerId,
        summary: incident.summary,
        updatedAt: incident.updatedAt,
        closedAt: incident.closedAt,
        closureReason: incident.closureReason,
        revision: incident.revision,
      },
    });
    return updated.count === 1;
  }
}

/* -------------------------------------------------------------- Unidad de trabajo */

/* --------------------------------------------------------------- Candidatos */

export interface CandidateRow {
  readonly id: string;
  readonly tenantId: string;
  readonly eventRecordId: string;
  readonly eventUid: string;
  readonly idempotencyKey: string;
  readonly priority: string;
  readonly score: number;
  readonly reasons: readonly {
    readonly code: string;
    readonly delta: number;
    readonly detail: string;
  }[];
  readonly rulesetId: string;
  readonly rulesetVersion: string;
  readonly occurredAt: Date;
  readonly createdAt: Date;
  readonly title: string;
  readonly entityKeys: readonly string[];
  readonly signal: string | null;
  readonly ruleId: string | null;
  readonly relatedAlertIds: readonly string[];
}

export class PrismaCandidateStore {
  public constructor(private readonly tx: Tx) {}

  public async byIdempotencyKey(tenantId: string, key: string): Promise<CandidateRow | undefined> {
    const row = await this.tx.detectionCandidate.findUnique({
      where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } },
    });
    return row ? (row as unknown as CandidateRow) : undefined;
  }

  /** La unicidad `(tenant, idempotency_key)` resuelve la carrera entre dos promotores. */
  public async insertIfAbsent(candidate: CandidateRow): Promise<boolean> {
    const created = await this.tx.detectionCandidate.createMany({
      data: [
        {
          id: candidate.id,
          tenantId: candidate.tenantId,
          eventRecordId: candidate.eventRecordId,
          eventUid: candidate.eventUid,
          idempotencyKey: candidate.idempotencyKey,
          priority: candidate.priority,
          score: candidate.score,
          reasons: candidate.reasons as unknown as Prisma.InputJsonValue,
          rulesetId: candidate.rulesetId,
          rulesetVersion: candidate.rulesetVersion,
          title: candidate.title,
          occurredAt: candidate.occurredAt,
          createdAt: candidate.createdAt,
          entityKeys: [...candidate.entityKeys],
          signal: candidate.signal,
          ruleId: candidate.ruleId,
          relatedAlertIds: [...candidate.relatedAlertIds],
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }
}

/* ------------------------------------------------------------- Outbox SOC */

/** Mensaje reclamado: el token identifica este claim y solo él puede cerrarlo. */
export interface ClaimedSocOutboxRow extends SocOutboxRow {
  readonly claimToken: string;
}

export interface SocOutboxRow {
  readonly messageId: string;
  readonly tenantId: string;
  readonly aggregateType: 'alert' | 'incident';
  readonly aggregateId: string;
  readonly messageType: string;
  readonly schemaVersion: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
  readonly availableAt: Date;
}

export class PrismaSocOutboxStore {
  public constructor(private readonly tx: Tx) {}

  /** `false` si el hecho ya estaba publicado: la unicidad de la clave lo decide. */
  public async enqueueIfAbsent(message: SocOutboxRow): Promise<boolean> {
    const created = await this.tx.socOutboxMessage.createMany({
      data: [
        {
          messageId: message.messageId,
          tenantId: message.tenantId,
          aggregateType: message.aggregateType,
          aggregateId: message.aggregateId,
          messageType: message.messageType,
          schemaVersion: message.schemaVersion,
          idempotencyKey: message.idempotencyKey,
          payload: message.payload as Prisma.InputJsonValue,
          availableAt: message.availableAt,
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }
}

/* -------------------------------------------------------------- Unidad de trabajo */

export interface SocStores {
  readonly alerts: PrismaAlertStore;
  readonly incidents: PrismaIncidentStore;
  readonly tasks: PrismaIncidentTaskStore;
  readonly notes: PrismaIncidentNoteStore;
  readonly audit: PrismaAuditStore;
  readonly candidates: PrismaCandidateStore;
  readonly outbox: PrismaSocOutboxStore;
  readonly tx: Tx;
}

export class PrismaSocUnitOfWork {
  public constructor(private readonly client: PrismaClient) {}

  public run<T>(work: (stores: SocStores) => Promise<T>): Promise<T> {
    return runDatabaseTransaction(this.client, (tx) =>
      work({
        alerts: new PrismaAlertStore(tx),
        incidents: new PrismaIncidentStore(tx),
        tasks: new PrismaIncidentTaskStore(tx),
        notes: new PrismaIncidentNoteStore(tx),
        audit: new PrismaAuditStore(tx),
        candidates: new PrismaCandidateStore(tx),
        outbox: new PrismaSocOutboxStore(tx),
        tx,
      }),
    );
  }
}

/* ------------------------------------------------------------------ Lecturas */

/**
 * Tope de filas por listado. Los listados del BFF paginan por cursor sobre el resultado
 * filtrado; este tope acota memoria y tiempo frente a un tenant con volumen anómalo. El
 * total (`count`) sí es exacto. Si el volumen medido lo exige, la paginación pasa a
 * keyset en SQL sin cambiar el contrato HTTP.
 */
export const SOC_QUERY_LIMITS = Object.freeze({
  maximumListRows: 2_000,
  maximumCorrelationRows: 500,
  maximumOutboxBatch: 200,
});

export interface AlertListFilter {
  readonly tenantId: string;
  /** `open` = todo lo no cerrado; un estado concreto filtra por igualdad. */
  readonly status?: string;
  readonly priority?: string;
  /** Texto ya normalizado a minúsculas por el llamador. */
  readonly search?: string;
  /** Referencia opaca `ent_…` (D-10b) para ver todas las alertas de una entidad. */
  readonly entityRef?: string;
}

export interface IncidentListFilter {
  readonly tenantId: string;
  readonly statuses?: readonly string[];
  readonly search?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function alertWhere(filter: AlertListFilter): Prisma.SocAlertWhereInput {
  const search = filter.search?.trim();
  return {
    tenantId: filter.tenantId,
    ...(filter.status === 'open'
      ? { status: { not: 'closed' } }
      : filter.status
        ? { status: filter.status }
        : {}),
    ...(filter.priority ? { priority: filter.priority } : {}),
    ...(filter.entityRef ? { entityRefs: { has: filter.entityRef } } : {}),
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { assigneeId: { contains: search, mode: 'insensitive' } },
            ...(UUID_PATTERN.test(search) ? [{ id: search }] : []),
          ],
        }
      : {}),
  };
}

export interface IncidentWithAlertsRow extends IncidentRow {
  readonly alertIds: readonly string[];
}

export class PrismaSocQueries {
  public constructor(private readonly client: PrismaClient) {}

  public async alertById(tenantId: string, alertId: string): Promise<AlertRow | undefined> {
    if (!UUID_PATTERN.test(alertId)) return undefined;
    const row = await this.client.socAlert.findFirst({ where: { id: alertId, tenantId } });
    return row ? (row as unknown as AlertRow) : undefined;
  }

  /**
   * Alertas vinculadas a un incidente en una sola consulta: las `limit` más recientes y el
   * total real de vínculos, para que el llamador sepa si recortó.
   */
  public async alertsByIncident(
    tenantId: string,
    incidentId: string,
    limit: number,
  ): Promise<{ readonly rows: readonly AlertRow[]; readonly total: number }> {
    if (!UUID_PATTERN.test(incidentId)) return { rows: [], total: 0 };
    const where = { tenantId, incidentId };
    const [rows, total] = await Promise.all([
      this.client.socAlert.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: Math.min(Math.max(limit, 1), SOC_QUERY_LIMITS.maximumListRows),
      }),
      this.client.socAlert.count({ where }),
    ]);
    return { rows: rows as unknown as readonly AlertRow[], total };
  }

  public async alertByEventRecordId(
    tenantId: string,
    eventRecordId: string,
  ): Promise<AlertRow | undefined> {
    if (!UUID_PATTERN.test(eventRecordId)) return undefined;
    const row = await this.client.socAlert.findFirst({
      where: { tenantId, eventRecordId },
      orderBy: { createdAt: 'asc' },
    });
    return row ? (row as unknown as AlertRow) : undefined;
  }

  public async listAlerts(
    filter: AlertListFilter,
  ): Promise<{ readonly rows: readonly AlertRow[]; readonly total: number }> {
    const where = alertWhere(filter);
    const [rows, total] = await Promise.all([
      this.client.socAlert.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: SOC_QUERY_LIMITS.maximumListRows,
      }),
      this.client.socAlert.count({ where }),
    ]);
    return { rows: rows as unknown as readonly AlertRow[], total };
  }

  public async incidentById(
    tenantId: string,
    incidentId: string,
  ): Promise<IncidentWithAlertsRow | undefined> {
    if (!UUID_PATTERN.test(incidentId)) return undefined;
    const row = await this.client.socIncident.findFirst({
      where: { id: incidentId, tenantId },
      include: { alerts: { select: { id: true }, orderBy: { occurredAt: 'asc' } } },
    });
    if (!row) return undefined;
    const { alerts, ...incident } = row;
    return { ...incident, alertIds: alerts.map((alert) => alert.id) };
  }

  public async listIncidents(
    filter: IncidentListFilter,
  ): Promise<{ readonly rows: readonly IncidentWithAlertsRow[]; readonly total: number }> {
    const search = filter.search?.trim();
    const where: Prisma.SocIncidentWhereInput = {
      tenantId: filter.tenantId,
      ...(filter.statuses && filter.statuses.length > 0
        ? { status: { in: [...filter.statuses] } }
        : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { ownerId: { contains: search, mode: 'insensitive' } },
              { summary: { contains: search, mode: 'insensitive' } },
              ...(UUID_PATTERN.test(search) ? [{ id: search }] : []),
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.client.socIncident.findMany({
        where,
        include: { alerts: { select: { id: true }, orderBy: { occurredAt: 'asc' } } },
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        take: SOC_QUERY_LIMITS.maximumListRows,
      }),
      this.client.socIncident.count({ where }),
    ]);
    return {
      rows: rows.map(({ alerts, ...incident }) => ({
        ...incident,
        alertIds: alerts.map((alert) => alert.id),
      })),
      total,
    };
  }

  /**
   * Ventana de correlación de C-16: alertas del tenant que comparten alguna clave de
   * entidad y ocurrieron desde `since`. Usa el índice GIN sobre `entity_keys`.
   */
  public async recentByEntities(
    tenantId: string,
    entityKeys: readonly string[],
    since: Date,
    limit: number,
  ): Promise<
    readonly {
      readonly id: string;
      readonly occurredAt: Date;
      readonly entityKeys: readonly string[];
      readonly signal: string | null;
      readonly ruleId: string | null;
    }[]
  > {
    if (entityKeys.length === 0) return [];
    return this.client.socAlert.findMany({
      where: { tenantId, occurredAt: { gte: since }, entityKeys: { hasSome: [...entityKeys] } },
      select: { id: true, occurredAt: true, entityKeys: true, signal: true, ruleId: true },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), SOC_QUERY_LIMITS.maximumCorrelationRows),
    });
  }

  /** Instante de la alerta más reciente del tenant (índice `soc_alerts_tenant_time_idx`). */
  public async lastAlertAt(tenantId: string): Promise<Date | null> {
    const row = await this.client.socAlert.findFirst({
      where: { tenantId },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      select: { occurredAt: true },
    });
    return row?.occurredAt ?? null;
  }

  /** Conteos de la cola del outbox del tenant y el pendiente más antiguo. */
  public async outboxHealth(tenantId: string): Promise<{
    readonly pending: number;
    readonly processing: number;
    readonly oldestPendingAt: Date | null;
  }> {
    const [pending, processing, oldest] = await Promise.all([
      this.client.socOutboxMessage.count({ where: { tenantId, status: 'pending' } }),
      this.client.socOutboxMessage.count({ where: { tenantId, status: 'processing' } }),
      this.client.socOutboxMessage.findFirst({
        where: { tenantId, status: 'pending' },
        orderBy: [{ availableAt: 'asc' }, { messageId: 'asc' }],
        select: { availableAt: true },
      }),
    ]);
    return { pending, processing, oldestPendingAt: oldest?.availableAt ?? null };
  }

  /**
   * Reclama un lote del outbox SOC con lease (C-20). Una sola sentencia atómica:
   *
   * - candidatos: `pending` ya disponibles, o `processing` cuyo lease venció (el
   *   despachador anterior murió a mitad de envío);
   * - `FOR UPDATE SKIP LOCKED` evita que dos réplicas reclamen la misma fila en el mismo
   *   instante; la exclusión durante el envío la da `lease_until`, que queda persistido en
   *   la fila y sobrevive al fin de la transacción.
   *
   * Entrega al menos una vez: tras un lease vencido el mensaje puede despacharse de nuevo y
   * la idempotencia del intento (C-20) evita la segunda notificación.
   *
   * Cada claim genera un `claim_id` nuevo (fencing): publicar o reprogramar exige ese
   * token, de modo que el despachador anterior, si revive, ya no puede cerrar el mensaje.
   */
  public async claimOutbox(
    at: Date,
    limit: number,
    leaseMs: number,
  ): Promise<readonly ClaimedSocOutboxRow[]> {
    const take = Math.min(Math.max(limit, 1), SOC_QUERY_LIMITS.maximumOutboxBatch);
    const leaseUntil = new Date(at.getTime() + Math.max(leaseMs, 1_000));
    const rows = await this.client.$queryRaw<
      {
        message_id: string;
        tenant_id: string;
        aggregate_type: 'alert' | 'incident';
        aggregate_id: string;
        message_type: string;
        schema_version: string;
        idempotency_key: string;
        payload: Readonly<Record<string, string | number | boolean | null>>;
        available_at: Date;
        claim_id: string;
      }[]
    >`
      UPDATE "soc_outbox_messages" AS target
         SET "status" = 'processing',
             "lease_until" = ${leaseUntil},
             "claim_id" = gen_random_uuid(),
             "attempt_count" = target."attempt_count" + 1
       WHERE target."message_id" IN (
         SELECT candidate."message_id"
           FROM "soc_outbox_messages" AS candidate
          WHERE (candidate."status" = 'pending' AND candidate."available_at" <= ${at})
             OR (candidate."status" = 'processing' AND candidate."lease_until" < ${at})
          ORDER BY candidate."available_at", candidate."message_id"
          LIMIT ${take}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING target."message_id", target."tenant_id", target."aggregate_type",
                target."aggregate_id", target."message_type", target."schema_version",
                target."idempotency_key", target."payload", target."available_at",
                target."claim_id"`;
    return rows
      .map((row) => ({
        messageId: row.message_id,
        tenantId: row.tenant_id,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        messageType: row.message_type,
        schemaVersion: row.schema_version,
        idempotencyKey: row.idempotency_key,
        payload: row.payload,
        availableAt: row.available_at,
        claimToken: row.claim_id,
      }))
      .sort(
        (left, right) =>
          left.availableAt.getTime() - right.availableAt.getTime() ||
          left.messageId.localeCompare(right.messageId),
      );
  }

  /**
   * Cierra el mensaje. Solo actúa sobre el claim vigente (`processing` + token): repetir la
   * marca o llegar con un token viejo no tiene efecto y devuelve `false`.
   */
  public async markOutboxPublished(
    messageId: string,
    claimToken: string,
    at: Date,
  ): Promise<boolean> {
    const updated = await this.client.socOutboxMessage.updateMany({
      where: { messageId, status: 'processing', claimId: claimToken },
      data: {
        status: 'published',
        publishedAt: at,
        leaseUntil: null,
        claimId: null,
        lastErrorCode: null,
      },
    });
    return updated.count === 1;
  }

  /** Devuelve el mensaje a la cola con nuevo instante de disponibilidad y la causa. */
  public async scheduleOutboxRetry(
    messageId: string,
    claimToken: string,
    availableAt: Date,
    errorCode: string,
  ): Promise<boolean> {
    const updated = await this.client.socOutboxMessage.updateMany({
      where: { messageId, status: 'processing', claimId: claimToken },
      data: {
        status: 'pending',
        availableAt,
        leaseUntil: null,
        claimId: null,
        lastErrorCode: errorCode.slice(0, 128),
      },
    });
    return updated.count === 1;
  }
}

/* --------------------------------------------- Auditoría fuera de transacción */

/**
 * Store de auditoría para escritores que no participan de una unidad de trabajo SOC:
 * inicio de sesión (C-18) y despacho de notificaciones (C-20). Cumple el mismo puerto
 * que `PrismaAuditStore`, pero cada operación es su propia transacción.
 *
 * `head()` lee sin bloquear; `append()` toma el lock del tenant y verifica que la cabeza
 * siga siendo la que se usó para sellar. Si otro escritor avanzó la cadena, lanza un
 * conflicto con el nombre que `recordAudit` reconoce y el evento se vuelve a sellar sobre
 * la cabeza nueva. Así no hay huecos ni bifurcaciones en la cadena de hash.
 */
export class PrismaStandaloneAuditStore {
  public constructor(private readonly client: PrismaClient) {}

  public head(
    tenantId: string,
  ): Promise<{ readonly sequence: bigint; readonly hash: string } | undefined> {
    return this.client.auditEvent
      .findFirst({
        where: { tenantId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true, hash: true },
      })
      .then((row) => row ?? undefined);
  }

  public append(event: SealedAuditRow): Promise<void> {
    return runDatabaseTransaction(this.client, async (tx) => {
      const store = new PrismaAuditStore(tx);
      const current = await store.head(event.tenantId);
      const expectedSequence = (current?.sequence ?? 0n) + 1n;
      if (event.sequence !== expectedSequence || (current && current.hash !== event.previousHash)) {
        const conflict = new Error('La cabeza de la cadena de auditoría cambió.');
        conflict.name = 'AuditAppendConflictError';
        throw conflict;
      }
      await store.append(event);
    });
  }

  public read(
    query: AuditQueryShape,
  ): Promise<{ readonly events: readonly SealedAuditRow[]; readonly nextCursor: string | null }> {
    return runDatabaseTransaction(this.client, (tx) => new PrismaAuditStore(tx).read(query));
  }

  public range(
    tenantId: string,
    fromSequence: bigint,
    limit: number,
  ): Promise<readonly SealedAuditRow[]> {
    return runDatabaseTransaction(this.client, (tx) =>
      new PrismaAuditStore(tx).range(tenantId, fromSequence, limit),
    );
  }
}
