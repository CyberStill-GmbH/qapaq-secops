/**
 * Historial de conversaciones de Qapaqzito en PostgreSQL. Filas planas: el dominio (topes, títulos,
 * aislamiento) vive en `modules/assistant`; aquí cada consulta filtra por (tenant, dueño) y los
 * mensajes viajan como JSON ya serializado por el adaptador del módulo.
 *
 * Un turno se agrega con compare-and-set sobre `message_count`: dos escrituras concurrentes no
 * pierden mensajes; la perdedora reintenta o falla con conflicto.
 */

import type { Prisma, PrismaClient } from '../generated/client/client.js';

export interface AssistantConversationSummaryRow {
  readonly id: string;
  readonly title: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly messageCount: number;
}

export interface AssistantConversationRow extends AssistantConversationSummaryRow {
  readonly tenantId: string;
  readonly ownerId: string;
  /** Arreglo JSON de mensajes. */
  readonly messages: unknown;
}

export interface AssistantConversationOwnerKey {
  readonly tenantId: string;
  readonly ownerId: string;
}

const SUMMARY_SELECT = {
  id: true,
  title: true,
  createdAt: true,
  updatedAt: true,
  messageCount: true,
} as const;

export class PrismaAssistantConversationStore {
  public constructor(private readonly client: PrismaClient) {}

  /** Más recientes primero; `after` es la última fila de la página anterior. */
  public async list(
    owner: AssistantConversationOwnerKey,
    limit: number,
    after?: { readonly updatedAt: Date; readonly id: string },
  ): Promise<readonly AssistantConversationSummaryRow[]> {
    return this.client.assistantConversation.findMany({
      where: {
        tenantId: owner.tenantId,
        ownerId: owner.ownerId,
        ...(after
          ? {
              OR: [
                { updatedAt: { lt: after.updatedAt } },
                { updatedAt: after.updatedAt, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: SUMMARY_SELECT,
    });
  }

  public async get(
    owner: AssistantConversationOwnerKey,
    id: string,
  ): Promise<AssistantConversationRow | undefined> {
    const row = await this.client.assistantConversation.findFirst({
      where: { id, tenantId: owner.tenantId, ownerId: owner.ownerId },
    });
    return row ?? undefined;
  }

  /**
   * Inserta la conversación y, en la misma transacción, descarta las menos recientes del dueño
   * hasta dejar `maxPerOwner` (incluida la nueva). Devuelve cuántas descartó.
   */
  public async create(row: AssistantConversationRow, maxPerOwner: number): Promise<number> {
    return this.client.$transaction(async (tx) => {
      const existing = await tx.assistantConversation.findMany({
        where: { tenantId: row.tenantId, ownerId: row.ownerId },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      const excess = existing.slice(Math.max(maxPerOwner - 1, 0)).map((entry) => entry.id);
      if (excess.length > 0) {
        await tx.assistantConversation.deleteMany({
          where: { tenantId: row.tenantId, ownerId: row.ownerId, id: { in: excess } },
        });
      }
      await tx.assistantConversation.create({
        data: {
          id: row.id,
          tenantId: row.tenantId,
          ownerId: row.ownerId,
          title: row.title,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          messageCount: row.messageCount,
          messages: row.messages as Prisma.InputJsonValue,
        },
      });
      return excess.length;
    });
  }

  /** Reemplaza los mensajes si nadie escribió desde la lectura (`expectedCount`). */
  public async replaceMessages(
    owner: AssistantConversationOwnerKey,
    id: string,
    expectedCount: number,
    messages: unknown,
    messageCount: number,
    updatedAt: Date,
  ): Promise<boolean> {
    const updated = await this.client.assistantConversation.updateMany({
      where: { id, tenantId: owner.tenantId, ownerId: owner.ownerId, messageCount: expectedCount },
      data: { messages: messages as Prisma.InputJsonValue, messageCount, updatedAt },
    });
    return updated.count === 1;
  }

  public async rename(
    owner: AssistantConversationOwnerKey,
    id: string,
    title: string,
  ): Promise<boolean> {
    const updated = await this.client.assistantConversation.updateMany({
      where: { id, tenantId: owner.tenantId, ownerId: owner.ownerId },
      data: { title },
    });
    return updated.count === 1;
  }

  public async delete(owner: AssistantConversationOwnerKey, id: string): Promise<boolean> {
    const deleted = await this.client.assistantConversation.deleteMany({
      where: { id, tenantId: owner.tenantId, ownerId: owner.ownerId },
    });
    return deleted.count === 1;
  }

  public async deleteAllByOwner(owner: AssistantConversationOwnerKey): Promise<number> {
    const deleted = await this.client.assistantConversation.deleteMany({
      where: { tenantId: owner.tenantId, ownerId: owner.ownerId },
    });
    return deleted.count;
  }

  public async purgeOlderThan(tenantId: string, cutoff: Date): Promise<number> {
    const deleted = await this.client.assistantConversation.deleteMany({
      where: { tenantId, updatedAt: { lt: cutoff } },
    });
    return deleted.count;
  }
}
