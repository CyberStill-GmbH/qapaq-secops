/** Adapter PostgreSQL de `FileReputationStore`: caché de 24 h y cuota compartida por tenant. */

import {
  closeDatabaseClient,
  createDatabaseClient,
  type DatabaseConnectionOptions,
} from '@qapaq/database';
import {
  PrismaFileReputationStore,
  type FileReputationCacheRow,
} from '@qapaq/database/file-reputation-stores';
import { isFileHash, type FileHash, type FileReputation } from '@qapaq/contracts';

import type {
  CachedFileReputation,
  FileReputationStore,
  QuotaUsage,
  QuotaWindows,
} from '../../application/file-reputation-enrichment.js';

/** Una fila que no se puede leer como resultado válido se trata como caché vacía. */
function fromRow(row: FileReputationCacheRow): CachedFileReputation | undefined {
  if (!isFileHash(row.algorithm, row.hash)) return undefined;
  const hash: FileHash = { algorithm: row.algorithm, value: row.hash };
  const base = {
    tenantId: row.tenantId,
    providerId: row.provider,
    hash,
    checkedAt: row.checkedAt,
    expiresAt: row.expiresAt,
  };
  if (row.status === 'unknown') return { ...base, lookup: { status: 'unknown' } };
  const result = row.result as Partial<FileReputation> | null;
  if (
    row.status !== 'found' ||
    !result ||
    typeof result.detections !== 'number' ||
    typeof result.engines !== 'number' ||
    typeof result.reportUrl !== 'string' ||
    !Array.isArray(result.threatLabels)
  ) {
    return undefined;
  }
  return {
    ...base,
    lookup: {
      status: 'found',
      reputation: {
        detections: result.detections,
        engines: result.engines,
        firstSeenAt: result.firstSeenAt ?? null,
        lastAnalysisAt: result.lastAnalysisAt ?? null,
        threatLabels: result.threatLabels.filter((label) => typeof label === 'string'),
        reportUrl: result.reportUrl,
      },
    },
  };
}

export class PostgresFileReputationStore implements FileReputationStore {
  private constructor(
    private readonly store: PrismaFileReputationStore,
    private readonly closeClient: () => Promise<void>,
  ) {}

  public static connect(options: DatabaseConnectionOptions): PostgresFileReputationStore {
    const client = createDatabaseClient(options);
    return new PostgresFileReputationStore(new PrismaFileReputationStore(client), () =>
      closeDatabaseClient(client),
    );
  }

  public async cached(
    tenantId: string,
    providerId: string,
    hash: FileHash,
    now: Date,
  ): Promise<CachedFileReputation | undefined> {
    const row = await this.store.cached(tenantId, providerId, hash.value, now);
    return row ? fromRow(row) : undefined;
  }

  public remember(entry: CachedFileReputation): Promise<void> {
    return this.store.remember({
      tenantId: entry.tenantId,
      provider: entry.providerId,
      algorithm: entry.hash.algorithm,
      hash: entry.hash.value,
      status: entry.lookup.status,
      result: entry.lookup.status === 'found' ? entry.lookup.reputation : null,
      checkedAt: entry.checkedAt,
      expiresAt: entry.expiresAt,
    });
  }

  public consume(
    tenantId: string,
    providerId: string,
    windows: QuotaWindows,
  ): Promise<{ readonly granted: boolean; readonly usage: QuotaUsage }> {
    return this.store.consume(
      {
        tenantId,
        provider: providerId,
        at: windows.at,
        minuteSince: windows.minuteSince,
        daySince: windows.daySince,
      },
      windows.limits,
    );
  }

  public usage(tenantId: string, providerId: string, windows: QuotaWindows): Promise<QuotaUsage> {
    return this.store.usage({
      tenantId,
      provider: providerId,
      at: windows.at,
      minuteSince: windows.minuteSince,
      daySince: windows.daySince,
    });
  }

  public close(): Promise<void> {
    return this.closeClient();
  }
}
