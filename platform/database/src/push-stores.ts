/**
 * Sprint 5 — suscripciones Web Push en PostgreSQL. Filas planas; el dominio vive en
 * `modules/soar`. Registrar un endpoint existente lo reactiva (no duplica). Sin DELETE.
 */

import type { PrismaClient } from '../generated/client/client.js';

export interface PushSubscriptionRow {
  readonly id: string;
  readonly tenantId: string;
  readonly subjectKey: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly label: string;
  readonly createdAt: Date;
  readonly lastSuccessAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revocationReason: string | null;
}

/** Tope de filas por consulta de destinatarios. */
const LIST_LIMIT = 500;

export class PrismaPushSubscriptionStore {
  public constructor(private readonly client: PrismaClient) {}

  public async upsert(row: PushSubscriptionRow): Promise<PushSubscriptionRow> {
    return this.client.pushSubscription.upsert({
      where: { tenantId_endpoint: { tenantId: row.tenantId, endpoint: row.endpoint } },
      create: { ...row },
      update: {
        subjectKey: row.subjectKey,
        p256dh: row.p256dh,
        auth: row.auth,
        label: row.label,
        revokedAt: null,
        revocationReason: null,
      },
    });
  }

  public async activeForSubjects(
    tenantId: string,
    subjectKeys: readonly string[],
  ): Promise<readonly PushSubscriptionRow[]> {
    if (subjectKeys.length === 0) return [];
    return this.client.pushSubscription.findMany({
      where: { tenantId, subjectKey: { in: [...subjectKeys] }, revokedAt: null },
      orderBy: [{ createdAt: 'desc' }],
      take: LIST_LIMIT,
    });
  }

  public async revoke(
    tenantId: string,
    id: string,
    subjectKey: string | null,
    reason: string,
    at: Date,
  ): Promise<boolean> {
    const updated = await this.client.pushSubscription.updateMany({
      where: { id, tenantId, revokedAt: null, ...(subjectKey === null ? {} : { subjectKey }) },
      data: { revokedAt: at, revocationReason: reason },
    });
    return updated.count === 1;
  }

  public async markDelivered(id: string, at: Date): Promise<void> {
    await this.client.pushSubscription.updateMany({ where: { id }, data: { lastSuccessAt: at } });
  }
}
