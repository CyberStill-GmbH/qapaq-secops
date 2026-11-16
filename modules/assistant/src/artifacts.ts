/**
 * Archivos generados por Qapaqzito (informes PDF/XLSX/CSV): dominio sin frameworks.
 *
 * Reglas que cualquier adaptador debe cumplir:
 * - **Aislamiento absoluto por dueño** (`tenantId` + `ownerId`): un archivo ajeno o vencido se
 *   comporta como inexistente (ni siquiera un administrador lo descarga).
 * - **Efímeros**: vencen a las 24 h (`expiresAt`); el API purga las filas vencidas.
 * - **Topes**: 25 MB por archivo y 20 archivos por persona en las últimas 24 h.
 * - El contenido nunca va a auditoría ni a logs; solo ids, formato, tamaño y hash.
 */

import { createHash, randomUUID } from 'node:crypto';

export const ARTIFACT_FORMATS = ['pdf', 'xlsx', 'csv'] as const;
export type ArtifactFormat = (typeof ARTIFACT_FORMATS)[number];

export const ARTIFACT_LIMITS = Object.freeze({
  /** Tamaño máximo de un archivo. */
  maxBytes: 25 * 1024 * 1024,
  /** Archivos que una persona puede generar por día (ventana móvil de 24 h). */
  maxPerOwnerPerDay: 20,
  /** Vigencia de un archivo. */
  ttlMs: 24 * 60 * 60 * 1000,
  /** Máximo de archivos vigentes que devuelve el listado. */
  maxListed: 50,
});

export const ARTIFACT_CONTENT_TYPES: Readonly<Record<ArtifactFormat, string>> = Object.freeze({
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
});

export interface ArtifactOwner {
  readonly tenantId: string;
  /** `subjectId` de la sesión. */
  readonly ownerId: string;
}

export interface ArtifactMeta {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly conversationId?: string | undefined;
  readonly filename: string;
  readonly contentType: string;
  readonly format: ArtifactFormat;
  readonly title: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface StoredArtifact extends ArtifactMeta {
  readonly content: Uint8Array;
}

/** Referencia que ve la interfaz (ver el contrato de informes de Qapaqzito). */
export interface ArtifactRef {
  readonly id: string;
  readonly filename: string;
  readonly format: ArtifactFormat;
  readonly title: string;
  readonly size: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Ruta relativa, mismo origen: `/api/assistant/artifacts/<id>`. */
  readonly url: string;
}

export const ARTIFACT_URL_PREFIX = '/api/assistant/artifacts';

export function artifactRefOf(meta: ArtifactMeta): ArtifactRef {
  return {
    id: meta.id,
    filename: meta.filename,
    format: meta.format,
    title: meta.title,
    size: meta.size,
    createdAt: meta.createdAt.toISOString(),
    expiresAt: meta.expiresAt.toISOString(),
    url: `${ARTIFACT_URL_PREFIX}/${meta.id}`,
  };
}

export type ArtifactErrorCode = 'TOO_LARGE' | 'EMPTY' | 'QUOTA' | 'INVALID_FORMAT';

export class ArtifactError extends Error {
  public constructor(public readonly code: ArtifactErrorCode) {
    super(code);
    this.name = 'ArtifactError';
  }
}

/** Puerto de almacenamiento. Toda operación está acotada al dueño. */
export interface ArtifactStore {
  insert(artifact: StoredArtifact): Promise<void>;
  /** Vigentes del dueño (`expiresAt > now`), más recientes primero, sin contenido. */
  listValid(owner: ArtifactOwner, now: Date, limit: number): Promise<readonly ArtifactMeta[]>;
  /** El archivo si es del dueño y sigue vigente; si no, `undefined` (misma respuesta). */
  getValid(owner: ArtifactOwner, id: string, now: Date): Promise<StoredArtifact | undefined>;
  /** Archivos creados por el dueño desde `since` (vencidos o no). */
  countCreatedSince(owner: ArtifactOwner, since: Date): Promise<number>;
  /** Borra los vencidos de todos los tenants; devuelve cuántos. */
  purgeExpired(now: Date): Promise<number>;
  close?(): Promise<void>;
}

export interface NewArtifact {
  readonly filename: string;
  readonly format: ArtifactFormat;
  readonly title: string;
  readonly content: Uint8Array;
  readonly conversationId?: string | undefined;
}

/** Nombre de archivo seguro: ASCII, sin separadores de ruta ni caracteres de control. */
export function safeArtifactFilename(name: string, format: ArtifactFormat): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '')
    .slice(0, 120);
  const stem = base.toLowerCase().endsWith(`.${format}`)
    ? base.slice(0, -(format.length + 1))
    : base;
  return `${stem === '' ? 'QAPAQ-informe' : stem}.${format}`;
}

/** Reglas de negocio sobre el almacén: topes, vigencia, hash. */
export class ArtifactVault {
  public constructor(
    public readonly store: ArtifactStore,
    private readonly now: () => Date = () => new Date(),
    private readonly limits: typeof ARTIFACT_LIMITS = ARTIFACT_LIMITS,
  ) {}

  public async create(owner: ArtifactOwner, draft: NewArtifact): Promise<ArtifactMeta> {
    if (!(ARTIFACT_FORMATS as readonly string[]).includes(draft.format)) {
      throw new ArtifactError('INVALID_FORMAT');
    }
    if (draft.content.byteLength === 0) throw new ArtifactError('EMPTY');
    if (draft.content.byteLength > this.limits.maxBytes) throw new ArtifactError('TOO_LARGE');
    const createdAt = this.now();
    const since = new Date(createdAt.getTime() - 24 * 60 * 60 * 1000);
    if ((await this.store.countCreatedSince(owner, since)) >= this.limits.maxPerOwnerPerDay) {
      throw new ArtifactError('QUOTA');
    }
    const meta: ArtifactMeta = {
      id: randomUUID(),
      tenantId: owner.tenantId,
      ownerId: owner.ownerId,
      ...(draft.conversationId ? { conversationId: draft.conversationId } : {}),
      filename: safeArtifactFilename(draft.filename, draft.format),
      contentType: ARTIFACT_CONTENT_TYPES[draft.format],
      format: draft.format,
      title: draft.title.slice(0, 160),
      size: draft.content.byteLength,
      sha256: createHash('sha256').update(draft.content).digest('hex'),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + this.limits.ttlMs),
    };
    await this.store.insert({ ...meta, content: draft.content });
    return meta;
  }

  public list(owner: ArtifactOwner): Promise<readonly ArtifactMeta[]> {
    return this.store.listValid(owner, this.now(), this.limits.maxListed);
  }

  public get(owner: ArtifactOwner, id: string): Promise<StoredArtifact | undefined> {
    return this.store.getValid(owner, id, this.now());
  }

  public purgeExpired(): Promise<number> {
    return this.store.purgeExpired(this.now());
  }
}

/** Adaptador en memoria (desarrollo y pruebas). Mismas reglas que el durable. */
export class InMemoryArtifactStore implements ArtifactStore {
  private readonly rows = new Map<string, StoredArtifact>();

  private owns(owner: ArtifactOwner, row: ArtifactMeta): boolean {
    return row.tenantId === owner.tenantId && row.ownerId === owner.ownerId;
  }

  public async insert(artifact: StoredArtifact): Promise<void> {
    this.rows.set(artifact.id, { ...artifact, content: Uint8Array.from(artifact.content) });
  }

  public async listValid(
    owner: ArtifactOwner,
    now: Date,
    limit: number,
  ): Promise<readonly ArtifactMeta[]> {
    return [...this.rows.values()]
      .filter((row) => this.owns(owner, row) && row.expiresAt > now)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map(({ content: _content, ...meta }) => meta);
  }

  public async getValid(
    owner: ArtifactOwner,
    id: string,
    now: Date,
  ): Promise<StoredArtifact | undefined> {
    const row = this.rows.get(id);
    return row && this.owns(owner, row) && row.expiresAt > now ? row : undefined;
  }

  public async countCreatedSince(owner: ArtifactOwner, since: Date): Promise<number> {
    return [...this.rows.values()].filter((row) => this.owns(owner, row) && row.createdAt >= since)
      .length;
  }

  public async purgeExpired(now: Date): Promise<number> {
    let purged = 0;
    for (const [id, row] of this.rows) {
      if (row.expiresAt <= now) {
        this.rows.delete(id);
        purged += 1;
      }
    }
    return purged;
  }

  public async close(): Promise<void> {}
}
