/**
 * C-20 — almacenamiento PostgreSQL de intentos SOAR.
 *
 * La capa de persistencia devuelve filas planas: el dominio y sus catálogos siguen en
 * `modules/soar`. La clave compuesta del esquema hace idempotente la creación frente a
 * reentregas del mismo mensaje.
 */

import type { PrismaClient } from '../generated/client/client.js';

export interface NotificationAttemptRow {
  readonly id: string;
  readonly tenantId: string;
  readonly messageId: string;
  readonly idempotencyKey: string;
  readonly clientRequestId: string;
  readonly channel: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly availableAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastFailureCode: string | null;
  readonly lastFailureClass: string | null;
  readonly sentAt: Date | null;
  readonly acknowledgedAt: Date | null;
  readonly acknowledgedBy: string | null;
}

/** Store de una fila actual por (tenant, clave idempotente). */
export class PrismaNotificationAttemptStore {
  public constructor(private readonly client: PrismaClient) {}

  private assertIdentity(existing: NotificationAttemptRow, attempt: NotificationAttemptRow): void {
    if (
      existing.id !== attempt.id ||
      existing.messageId !== attempt.messageId ||
      existing.clientRequestId !== attempt.clientRequestId
    ) {
      throw new Error('SOAR_ATTEMPT_IDENTITY_MISMATCH');
    }
  }

  public async byIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<NotificationAttemptRow | undefined> {
    const row = await this.client.notificationAttempt.findUnique({
      where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
    });
    return row ?? undefined;
  }

  public async byId(
    tenantId: string,
    attemptId: string,
  ): Promise<NotificationAttemptRow | undefined> {
    const row = await this.client.notificationAttempt.findFirst({
      where: { id: attemptId, tenantId },
    });
    return row ?? undefined;
  }

  /** Conteo por estado en la ventana `[since, ahora]`, agregado en la base. */
  public async countByStatusSince(
    tenantId: string,
    since: Date,
  ): Promise<Readonly<Record<string, number>>> {
    const groups = await this.client.notificationAttempt.groupBy({
      by: ['status'],
      where: { tenantId, createdAt: { gte: since } },
      _count: { _all: true },
    });
    return Object.fromEntries(groups.map((group) => [group.status, group._count._all]));
  }

  /** Bandeja de la consola: más recientes primero, acotada. */
  public async listByTenant(
    tenantId: string,
    limit: number,
  ): Promise<readonly NotificationAttemptRow[]> {
    return this.client.notificationAttempt.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 2_000),
    });
  }

  /**
   * Inserta el primer intento o guarda su estado más reciente. La identidad del intento,
   * mensaje e idempotency key no cambia al pasar por retries o acknowledgements.
   */
  public async save(attempt: NotificationAttemptRow): Promise<void> {
    const existing = await this.byIdempotencyKey(attempt.tenantId, attempt.idempotencyKey);
    const { tenantId, idempotencyKey } = attempt;
    const mutable = {
      messageId: attempt.messageId,
      clientRequestId: attempt.clientRequestId,
      channel: attempt.channel,
      status: attempt.status,
      attemptCount: attempt.attemptCount,
      availableAt: attempt.availableAt,
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt,
      lastFailureCode: attempt.lastFailureCode,
      lastFailureClass: attempt.lastFailureClass,
      sentAt: attempt.sentAt,
      acknowledgedAt: attempt.acknowledgedAt,
      acknowledgedBy: attempt.acknowledgedBy,
    };
    const where = { tenantId_idempotencyKey: { tenantId, idempotencyKey } };
    if (existing) {
      this.assertIdentity(existing, attempt);
      await this.client.notificationAttempt.update({ where, data: mutable });
      return;
    }

    try {
      await this.client.notificationAttempt.create({ data: attempt });
    } catch (error) {
      // Dos réplicas pueden crear el primer estado simultáneamente. La unicidad de
      // PostgreSQL decide al ganador; el perdedor solo puede continuar si era el mismo
      // mensaje/intento y entonces actualiza esa fila.
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'P2002'
      )
        throw error;
      const raced = await this.byIdempotencyKey(tenantId, idempotencyKey);
      if (!raced) throw error;
      this.assertIdentity(raced, attempt);
      await this.client.notificationAttempt.update({ where, data: mutable });
    }
  }
}
