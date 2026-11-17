/**
 * Adaptador PostgreSQL de los archivos de Qapaqzito (`@qapaq/assistant/postgres`).
 */

import {
  closeDatabaseClient,
  createDatabaseClient,
  type DatabaseConnectionOptions,
} from '@qapaq/database';
import {
  PrismaAssistantArtifactStore,
  type AssistantArtifactMetaRow,
} from '@qapaq/database/assistant-artifact-stores';

import {
  ARTIFACT_CONTENT_TYPES,
  ARTIFACT_FORMATS,
  type ArtifactFormat,
  type ArtifactMeta,
  type ArtifactOwner,
  type ArtifactStore,
  type StoredArtifact,
} from '../artifacts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export class ArtifactIntegrityError extends Error {
  public constructor() {
    super('Fila fuera de forma en assistant_artifacts.');
    this.name = 'ArtifactIntegrityError';
  }
}

function toMeta(row: AssistantArtifactMetaRow): ArtifactMeta {
  if (!(ARTIFACT_FORMATS as readonly string[]).includes(row.format)) {
    throw new ArtifactIntegrityError();
  }
  const format = row.format as ArtifactFormat;
  return {
    id: row.id,
    tenantId: row.tenantId,
    ownerId: row.ownerId,
    ...(row.conversationId ? { conversationId: row.conversationId } : {}),
    filename: row.filename,
    contentType: ARTIFACT_CONTENT_TYPES[format],
    format,
    title: row.title,
    size: row.size,
    sha256: row.sha256,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export class PostgresArtifactStore implements ArtifactStore {
  private constructor(
    private readonly store: PrismaAssistantArtifactStore,
    private readonly closeClient: () => Promise<void>,
  ) {}

  public static connect(options: DatabaseConnectionOptions): PostgresArtifactStore {
    const client = createDatabaseClient(options);
    return new PostgresArtifactStore(new PrismaAssistantArtifactStore(client), () =>
      closeDatabaseClient(client),
    );
  }

  public insert(artifact: StoredArtifact): Promise<void> {
    return this.store.insert({
      ...artifact,
      conversationId: artifact.conversationId ?? null,
    });
  }

  public async listValid(
    owner: ArtifactOwner,
    now: Date,
    limit: number,
  ): Promise<readonly ArtifactMeta[]> {
    return (await this.store.listValid(owner, now, limit)).map(toMeta);
  }

  public async getValid(
    owner: ArtifactOwner,
    id: string,
    now: Date,
  ): Promise<StoredArtifact | undefined> {
    if (!UUID.test(id)) return undefined;
    const row = await this.store.getValid(owner, id, now);
    return row ? { ...toMeta(row), content: row.content } : undefined;
  }

  public countCreatedSince(owner: ArtifactOwner, since: Date): Promise<number> {
    return this.store.countCreatedSince(owner, since);
  }

  public purgeExpired(now: Date): Promise<number> {
    return this.store.purgeExpired(now);
  }

  public close(): Promise<void> {
    return this.closeClient();
  }
}
