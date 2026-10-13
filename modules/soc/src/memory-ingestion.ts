/**
 * Estado de ingesta en memoria (specs y desarrollo). Misma semántica que PostgreSQL:
 * lease con fencing, marca de agua que nunca retrocede y observaciones idempotentes por id.
 */

import { randomUUID } from 'node:crypto';

import type {
  ClaimedIngestionCursor,
  IngestionCursorKey,
  IngestionStateStore,
  SourcePollObservation,
  StreamActivityRecord,
} from './ingestion.js';
import type { SourceHealthTransition } from './source-health.js';

interface CursorRow {
  watermark: Date | null;
  leaseUntil: Date | null;
  claimId: string | null;
}

const keyOf = (key: IngestionCursorKey) => `${key.tenantId}|${key.sourceId}|${key.dataset}`;

export class InMemoryIngestionState implements IngestionStateStore {
  public readonly cursors = new Map<string, CursorRow>();
  public readonly observations = new Map<string, SourcePollObservation>();
  public readonly transitions = new Map<string, SourceHealthTransition>();
  public readonly streams = new Map<string, Map<string, StreamActivityRecord>>();

  public claimCursor(
    key: IngestionCursorKey,
    at: Date,
    leaseMs: number,
  ): Promise<ClaimedIngestionCursor | undefined> {
    const row = this.cursors.get(keyOf(key)) ?? {
      watermark: null,
      leaseUntil: null,
      claimId: null,
    };
    if (row.leaseUntil && row.leaseUntil.getTime() > at.getTime())
      return Promise.resolve(undefined);
    const claimId = randomUUID();
    this.cursors.set(keyOf(key), {
      ...row,
      leaseUntil: new Date(at.getTime() + leaseMs),
      claimId,
    });
    return Promise.resolve({ key, watermark: row.watermark, claimId });
  }

  public advanceCursor(claim: ClaimedIngestionCursor, watermark: Date): Promise<boolean> {
    const row = this.cursors.get(keyOf(claim.key));
    if (!row || row.claimId !== claim.claimId) return Promise.resolve(false);
    if (!row.watermark || watermark.getTime() > row.watermark.getTime()) row.watermark = watermark;
    return Promise.resolve(true);
  }

  public releaseCursor(claim: ClaimedIngestionCursor): Promise<void> {
    const row = this.cursors.get(keyOf(claim.key));
    if (row && row.claimId === claim.claimId) {
      row.leaseUntil = null;
      row.claimId = null;
    }
    return Promise.resolve();
  }

  public recordObservation(observation: SourcePollObservation): Promise<void> {
    if (!this.observations.has(observation.id)) this.observations.set(observation.id, observation);
    return Promise.resolve();
  }

  public recentObservations(
    key: IngestionCursorKey,
    limit: number,
  ): Promise<readonly SourcePollObservation[]> {
    return Promise.resolve(
      [...this.observations.values()]
        .filter(
          (item) =>
            item.tenantId === key.tenantId &&
            item.sourceId === key.sourceId &&
            item.dataset === key.dataset,
        )
        .sort((left, right) => right.attemptedAt.getTime() - left.attemptedAt.getTime())
        .slice(0, limit),
    );
  }

  public recentTransitions(
    key: IngestionCursorKey,
    limit: number,
  ): Promise<readonly SourceHealthTransition[]> {
    return Promise.resolve(
      [...this.transitions.values()]
        .filter(
          (item) =>
            item.tenantId === key.tenantId &&
            item.sourceId === key.sourceId &&
            item.dataset === key.dataset,
        )
        .sort((left, right) => right.at.getTime() - left.at.getTime())
        .slice(0, limit),
    );
  }

  public appendTransition(transition: SourceHealthTransition): Promise<void> {
    if (!this.transitions.has(transition.id)) this.transitions.set(transition.id, transition);
    return Promise.resolve();
  }

  public saveActivity(
    key: IngestionCursorKey,
    records: readonly StreamActivityRecord[],
  ): Promise<void> {
    const current = this.streams.get(keyOf(key)) ?? new Map<string, StreamActivityRecord>();
    const measuredAt = records[0]?.measuredAt;
    if (measuredAt) {
      for (const [stream, record] of current) {
        current.set(stream, { ...record, eventsInWindow: 0, measuredAt });
      }
    }
    for (const record of records) current.set(record.stream, record);
    this.streams.set(keyOf(key), current);
    return Promise.resolve();
  }

  public activity(key: IngestionCursorKey): Promise<readonly StreamActivityRecord[]> {
    return Promise.resolve(
      [...(this.streams.get(keyOf(key))?.values() ?? [])].sort((a, b) =>
        a.stream.localeCompare(b.stream),
      ),
    );
  }
}
