/**
 * Sprint 5 · fase 4 — almacenamiento PostgreSQL de tareas y bitácora del incidente.
 *
 * Los stores con `Tx` participan en la transacción de `PrismaSocUnitOfWork`, así la tarea o
 * la nota entra junto con su AuditEvent o no entra ninguna. `PrismaIncidentWorkQueries` son
 * lecturas fuera de transacción para el BFF. Filas planas: la traducción al dominio vive en
 * el adapter de `modules/soc`.
 *
 * La bitácora no tiene `update` ni `delete`: la tabla los rechaza por trigger y el runtime
 * no tiene el permiso.
 */

import type { Prisma, PrismaClient } from '../generated/client/client.js';

type Tx = Prisma.TransactionClient;

/** Las claves son UUID: un identificador con otra forma no existe, sin consultar. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Tope de tareas o notas por incidente en una lectura. */
export const INCIDENT_WORK_QUERY_LIMIT = 500;

export interface IncidentTaskRow {
  readonly id: string;
  readonly tenantId: string;
  readonly incidentId: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly required: boolean;
  readonly assigneeId: string | null;
  readonly dueAt: Date | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
  readonly cancellationReason: string | null;
  readonly revision: number;
}

export interface IncidentNoteRow {
  readonly id: string;
  readonly tenantId: string;
  readonly incidentId: string;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt: Date;
  readonly correctsNoteId: string | null;
}

export class PrismaIncidentTaskStore {
  public constructor(private readonly tx: Tx) {}

  public async byId(tenantId: string, taskId: string): Promise<IncidentTaskRow | undefined> {
    if (!UUID_PATTERN.test(taskId)) return undefined;
    const row = await this.tx.incidentTask.findFirst({ where: { id: taskId, tenantId } });
    return row ?? undefined;
  }

  public async byIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<readonly IncidentTaskRow[]> {
    if (!UUID_PATTERN.test(incidentId)) return [];
    return this.tx.incidentTask.findMany({
      where: { tenantId, incidentId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: INCIDENT_WORK_QUERY_LIMIT,
    });
  }

  public async insert(task: IncidentTaskRow): Promise<void> {
    await this.tx.incidentTask.create({ data: { ...task } });
  }

  /** Compare-and-set: `false` si otra escritura se adelantó. */
  public async update(task: IncidentTaskRow, expectedRevision: number): Promise<boolean> {
    const updated = await this.tx.incidentTask.updateMany({
      where: { id: task.id, tenantId: task.tenantId, revision: expectedRevision },
      data: {
        title: task.title,
        description: task.description,
        status: task.status,
        required: task.required,
        assigneeId: task.assigneeId,
        dueAt: task.dueAt,
        updatedAt: task.updatedAt,
        completedAt: task.completedAt,
        cancellationReason: task.cancellationReason,
        revision: task.revision,
      },
    });
    return updated.count === 1;
  }
}

export class PrismaIncidentNoteStore {
  public constructor(private readonly tx: Tx) {}

  public async byId(tenantId: string, noteId: string): Promise<IncidentNoteRow | undefined> {
    if (!UUID_PATTERN.test(noteId)) return undefined;
    const row = await this.tx.incidentNote.findFirst({ where: { id: noteId, tenantId } });
    return row ?? undefined;
  }

  public async insert(note: IncidentNoteRow): Promise<void> {
    await this.tx.incidentNote.create({ data: { ...note } });
  }
}

export class PrismaIncidentWorkQueries {
  public constructor(private readonly client: PrismaClient) {}

  public async tasksByIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<readonly IncidentTaskRow[]> {
    if (!UUID_PATTERN.test(incidentId)) return [];
    return this.client.incidentTask.findMany({
      where: { tenantId, incidentId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: INCIDENT_WORK_QUERY_LIMIT,
    });
  }

  public async notesByIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<readonly IncidentNoteRow[]> {
    if (!UUID_PATTERN.test(incidentId)) return [];
    return this.client.incidentNote.findMany({
      where: { tenantId, incidentId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: INCIDENT_WORK_QUERY_LIMIT,
    });
  }
}
