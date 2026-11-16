/**
 * Archivos generados por Qapaqzito en PostgreSQL. Filas planas: las reglas (topes, vigencia) viven en
 * `modules/assistant`; aqui cada consulta filtra por (tenant, dueno). El contenido solo se lee
 * en la descarga: el listado no lo selecciona.
 */

import type { PrismaClient } from '../generated/client/client.js';

export interface AssistantArtifactMetaRow {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly conversationId: string | null;
  readonly filename: string;
  readonly contentType: string;
  readonly format: string;
  readonly title: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface AssistantArtifactRow extends AssistantArtifactMetaRow {
  readonly content: Uint8Array;
}

export interface AssistantArtifactOwnerKey {
  readonly tenantId: string;
  readonly ownerId: string;
}

const META_SELECT = {
  id: true,
  tenantId: true,
  ownerId: true,
  conversationId: true,
  filename: true,
  contentType: true,
  format: true,
  title: true,
  size: true,
  sha256: true,
  createdAt: true,
  expiresAt: true,
} as const;

export class PrismaAssistantArtifactStore {
  public constructor(private readonly client: PrismaClient) {}

  public async insert(row: AssistantArtifactRow): Promise<void> {
    await this.client.assistantArtifact.create({
      data: { ...row, content: Uint8Array.from(row.content) },
    });
  }

  /** Vigentes del dueno, mas recientes primero (sin contenido). */
  public async listValid(
    owner: AssistantArtifactOwnerKey,
    now: Date,
    limit: number,
  ): Promise<readonly AssistantArtifactMetaRow[]> {
    return this.client.assistantArtifact.findMany({
      where: { tenantId: owner.tenantId, ownerId: owner.ownerId, expiresAt: { gt: now } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: META_SELECT,
    });
  }

  public async getValid(
    owner: AssistantArtifactOwnerKey,
    id: string,
    now: Date,
  ): Promise<AssistantArtifactRow | undefined> {
    const row = await this.client.assistantArtifact.findFirst({
      where: { id, tenantId: owner.tenantId, ownerId: owner.ownerId, expiresAt: { gt: now } },
    });
    return row ?? undefined;
  }

  /** Archivos creados por el dueno desde `since` (vencidos o no): tope diario. */
  public async countCreatedSince(owner: AssistantArtifactOwnerKey, since: Date): Promise<number> {
    return this.client.assistantArtifact.count({
      where: { tenantId: owner.tenantId, ownerId: owner.ownerId, createdAt: { gte: since } },
    });
  }

  public async purgeExpired(now: Date): Promise<number> {
    const deleted = await this.client.assistantArtifact.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    return deleted.count;
  }
}
