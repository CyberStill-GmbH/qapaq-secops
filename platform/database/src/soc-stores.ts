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
 */

import type { Prisma, PrismaClient } from '../generated/client/client.js';
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
    // `FOR UPDATE` no aplica a una tabla append-only: el conflicto lo resuelve la
    // unicidad `(tenant, sequence)` y el reintento del escritor.
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
          updatedAt: alert.updatedAt,
          revision: alert.revision,
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

export interface SocStores {
  readonly alerts: PrismaAlertStore;
  readonly incidents: PrismaIncidentStore;
  readonly audit: PrismaAuditStore;
  readonly tx: Tx;
}

export class PrismaSocUnitOfWork {
  public constructor(private readonly client: PrismaClient) {}

  public run<T>(work: (stores: SocStores) => Promise<T>): Promise<T> {
    return runDatabaseTransaction(this.client, (tx) =>
      work({
        alerts: new PrismaAlertStore(tx),
        incidents: new PrismaIncidentStore(tx),
        audit: new PrismaAuditStore(tx),
        tx,
      }),
    );
  }
}
