/** Suscripciones de push en memoria (specs y desarrollo); misma semántica que PostgreSQL. */

import { PUSH_LIMITS, type PushSubscriptionRecord, type PushSubscriptionStore } from './push.js';

export class InMemoryPushSubscriptionStore implements PushSubscriptionStore {
  public readonly rows = new Map<string, PushSubscriptionRecord>();

  public upsert(record: PushSubscriptionRecord): Promise<PushSubscriptionRecord> {
    const existing = [...this.rows.values()].find(
      (row) => row.tenantId === record.tenantId && row.endpoint === record.endpoint,
    );
    const stored: PushSubscriptionRecord = existing
      ? {
          ...existing,
          ...record,
          id: existing.id,
          createdAt: existing.createdAt,
          revokedAt: null,
          revocationReason: null,
        }
      : record;
    this.rows.set(stored.id, stored);
    return Promise.resolve(stored);
  }

  public activeForSubject(
    tenantId: string,
    subjectKey: string,
  ): Promise<readonly PushSubscriptionRecord[]> {
    return this.activeForSubjects(tenantId, [subjectKey]);
  }

  public activeForSubjects(
    tenantId: string,
    subjectKeys: readonly string[],
  ): Promise<readonly PushSubscriptionRecord[]> {
    const keys = new Set(subjectKeys.map((key) => key.toLowerCase()));
    return Promise.resolve(
      [...this.rows.values()]
        .filter((row) => row.tenantId === tenantId && keys.has(row.subjectKey) && !row.revokedAt)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, PUSH_LIMITS.maximumPerSubject * Math.max(keys.size, 1)),
    );
  }

  public revoke(
    tenantId: string,
    id: string,
    subjectKey: string | null,
    reason: string,
    at: Date,
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId || row.revokedAt) return Promise.resolve(false);
    if (subjectKey !== null && row.subjectKey !== subjectKey.toLowerCase())
      return Promise.resolve(false);
    this.rows.set(id, { ...row, revokedAt: at, revocationReason: reason });
    return Promise.resolve(true);
  }

  public markDelivered(id: string, at: Date): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, lastSuccessAt: at });
    return Promise.resolve();
  }
}
