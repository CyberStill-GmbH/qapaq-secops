/**
 * C-20 — almacenamiento PostgreSQL de intentos SOAR.
 *
 * La capa de persistencia devuelve filas planas: el dominio y sus catálogos siguen en
 * `modules/soar`. La clave compuesta del esquema hace idempotente la creación frente a
 * reentregas del mismo mensaje.
 */

import { Prisma, type PrismaClient } from '../generated/client/client.js';

export interface ProviderAcceptanceLatencyRow {
  readonly sampleCount: bigint;
  readonly excludedClockSkewCount: bigint;
  readonly sampleCapReached: boolean;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
}

/** Máximo fijo de mensajes outbox inspeccionados por consulta de salud. */
export const PROVIDER_ACCEPTANCE_LATENCY_SAMPLE_CAP = 10_000;

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
  readonly groupKey?: string | null;
  readonly context?: unknown;
  readonly delivery?: unknown;
  readonly suppressionReason?: string | null;
  readonly supersededBy?: string | null;
  readonly digestId?: string | null;
}

/** Estados en que el aviso se publicó (tiene `sentAt`). */
const NOTIFIED_STATUSES = ['sent', 'fallback', 'acknowledged', 'superseded'];

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

  /**
   * Desde `soc_outbox_messages.created_at` hasta la primera respuesta HTTP 2xx de Teams.
   * El CTE lee como máximo 10 001 filas del tenant para poder informar truncamiento; el
   * join exige tenant_id en ambos lados. JSON inválido no rompe health y evidencia sin
   * 2xx no se interpreta como aceptación del proveedor.
   */
  public async providerAcceptanceLatencySince(
    tenantId: string,
    since: Date,
    through: Date,
  ): Promise<ProviderAcceptanceLatencyRow> {
    const [row] = await this.client.$queryRaw<readonly ProviderAcceptanceLatencyRow[]>`
      WITH eligible AS MATERIALIZED (
        SELECT message_id, tenant_id, created_at
          FROM soc_outbox_messages
         WHERE tenant_id = ${tenantId}
           AND created_at >= ${since}
           AND created_at <= ${through}
         ORDER BY created_at DESC, message_id DESC
         LIMIT ${PROVIDER_ACCEPTANCE_LATENCY_SAMPLE_CAP + 1}
      ), sampled AS MATERIALIZED (
        SELECT message_id, tenant_id, created_at
          FROM eligible
         ORDER BY created_at DESC, message_id DESC
         LIMIT ${PROVIDER_ACCEPTANCE_LATENCY_SAMPLE_CAP}
      ), first_acceptance AS (
        SELECT s.message_id,
               s.created_at,
               MIN(CASE
                     WHEN evidence.item ->> 'channel' = 'teams'
                      AND pg_input_is_valid(evidence.item ->> 'responseAt', 'timestamptz')
                     THEN (evidence.item ->> 'responseAt')::timestamptz
                   END) AS accepted_at
          FROM sampled s
          JOIN notification_attempts a
            ON a.tenant_id = s.tenant_id
           AND a.message_id = s.message_id
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(a.delivery) = 'array' THEN a.delivery ELSE '[]'::jsonb END
          ) AS evidence(item)
         WHERE evidence.item ->> 'outcome' = 'accepted'
           AND evidence.item ->> 'channel' = 'teams'
           AND evidence.item ? 'responseAt'
           AND evidence.item ->> 'httpStatus' ~ '^[0-9]{3}$'
           AND (evidence.item ->> 'httpStatus')::integer BETWEEN 200 AND 299
         GROUP BY s.message_id, s.created_at
      ), latency AS (
        SELECT EXTRACT(EPOCH FROM (accepted_at - created_at))::double precision
                 * 1000.0::double precision AS latency_ms,
               created_at,
               accepted_at
          FROM first_acceptance
         WHERE accepted_at IS NOT NULL
      )
      SELECT COUNT(*) FILTER (
                 WHERE accepted_at >= created_at AND accepted_at <= ${through}
               )::bigint AS "sampleCount",
             COUNT(*) FILTER (
                 WHERE accepted_at < created_at OR accepted_at > ${through}
               )::bigint AS "excludedClockSkewCount",
             (SELECT COUNT(*) FROM eligible) > ${PROVIDER_ACCEPTANCE_LATENCY_SAMPLE_CAP}
               AS "sampleCapReached",
             percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms) FILTER (
                 WHERE accepted_at >= created_at AND accepted_at <= ${through}
               ) AS "p50",
             percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (
                 WHERE accepted_at >= created_at AND accepted_at <= ${through}
               ) AS "p95",
             percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms) FILTER (
                 WHERE accepted_at >= created_at AND accepted_at <= ${through}
               ) AS "p99"
        FROM latency
    `;
    return (
      row ?? {
        sampleCount: 0n,
        excludedClockSkewCount: 0n,
        sampleCapReached: false,
        p50: null,
        p95: null,
        p99: null,
      }
    );
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

  /** Último aviso publicado del grupo desde `since`. */
  public async lastNotifiedInGroup(
    tenantId: string,
    groupKey: string,
    since: Date,
  ): Promise<NotificationAttemptRow | undefined> {
    const row = await this.client.notificationAttempt.findFirst({
      where: { tenantId, groupKey, sentAt: { gte: since }, status: { in: NOTIFIED_STATUSES } },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
    });
    return row ?? undefined;
  }

  public listSuppressedInGroup(
    tenantId: string,
    groupKey: string,
    after: Date,
    limit: number,
  ): Promise<readonly NotificationAttemptRow[]> {
    return this.client.notificationAttempt.findMany({
      where: { tenantId, groupKey, status: 'suppressed', createdAt: { gt: after } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: Math.min(Math.max(limit, 1), 2_000),
    });
  }

  /**
   * Reserva una plaza P2 en ventana móvil de una hora. El advisory lock serializa
   * solicitudes del tenant y la clave idempotente evita consumir dos plazas por alerta.
   */
  public reserveP2ImmediateSlot(
    tenantId: string,
    idempotencyKey: string,
    at: Date,
    maximum: number,
  ): Promise<boolean> {
    const since = new Date(at.getTime() - 3_600_000);
    const leaseUntil = new Date(at.getTime() + 120_000);
    return this.client.$transaction(async (transaction) => {
      // PostgreSQL reports advisory lock functions as `void`; Prisma 7's queryRaw
      // cannot deserialize that value. executeRaw waits for the SELECT to complete
      // without attempting to materialize its result, while the xact lock remains held
      // until this transaction commits or rolls back.
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))
      `;
      const existing = await transaction.$queryRaw<readonly { readonly reservedAt: Date }[]>`
        SELECT "reserved_at" AS "reservedAt"
          FROM "notification_p2_rate_reservations"
         WHERE "tenant_id" = ${tenantId}
           AND "idempotency_key" = ${idempotencyKey}
           AND (("confirmed_at" >= ${since} AND "confirmed_at" <= ${at})
             OR ("confirmed_at" IS NULL AND "reserved_at" >= ${since}
                 AND "reserved_at" <= ${at} AND "lease_until" > ${at}))
         LIMIT 1
      `;
      if (existing.length > 0) {
        await transaction.$executeRaw`
          UPDATE "notification_p2_rate_reservations"
             SET "reserved_at" = ${at}, "lease_until" = ${leaseUntil}
           WHERE "tenant_id" = ${tenantId} AND "idempotency_key" = ${idempotencyKey}
             AND "confirmed_at" IS NULL
        `;
        return true;
      }

      await transaction.$executeRaw`
        DELETE FROM "notification_p2_rate_reservations"
         WHERE "tenant_id" = ${tenantId}
           AND (("confirmed_at" IS NOT NULL AND "confirmed_at" < ${since})
             OR ("confirmed_at" IS NULL AND "lease_until" <= ${at}))
      `;
      const rows = await transaction.$queryRaw<readonly { readonly slotCount: bigint }[]>`
        SELECT COUNT(*)::bigint AS "slotCount"
          FROM (
            SELECT "idempotency_key"
              FROM "notification_attempts"
             WHERE "tenant_id" = ${tenantId}
               AND "sent_at" >= ${since}
               AND "sent_at" <= ${at}
               AND "status" IN ('sent', 'fallback', 'acknowledged', 'superseded')
               AND "context" ->> 'priority' = 'P2'
            UNION
            SELECT "idempotency_key"
              FROM "notification_p2_rate_reservations"
             WHERE "tenant_id" = ${tenantId}
               AND (("confirmed_at" >= ${since} AND "confirmed_at" <= ${at})
                 OR ("confirmed_at" IS NULL AND "reserved_at" >= ${since}
                     AND "reserved_at" <= ${at} AND "lease_until" > ${at}))
          ) AS "active_slots"
      `;
      if (maximum <= 0 || Number(rows[0]?.slotCount ?? 0n) >= maximum) return false;

      await transaction.$executeRaw`
        INSERT INTO "notification_p2_rate_reservations" (
          "tenant_id", "idempotency_key", "reserved_at", "lease_until", "confirmed_at"
        ) VALUES (${tenantId}, ${idempotencyKey}, ${at}, ${leaseUntil}, NULL)
        ON CONFLICT ("tenant_id", "idempotency_key")
        DO UPDATE SET "reserved_at" = EXCLUDED."reserved_at",
                      "lease_until" = EXCLUDED."lease_until",
                      "confirmed_at" = NULL
      `;
      return true;
    });
  }

  /** Finaliza, libera o mantiene brevemente una plaza según el resultado del canal. */
  public settleP2ImmediateSlot(
    tenantId: string,
    idempotencyKey: string,
    at: Date,
    result: 'delivered' | 'failed' | 'uncertain',
  ): Promise<void> {
    return this.client.$transaction(async (transaction) => {
      // See reserveP2ImmediateSlot: do not deserialize PostgreSQL's `void` result.
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))
      `;
      if (result === 'failed') {
        await transaction.$executeRaw`
          DELETE FROM "notification_p2_rate_reservations"
           WHERE "tenant_id" = ${tenantId} AND "idempotency_key" = ${idempotencyKey}
             AND "confirmed_at" IS NULL
        `;
        return;
      }
      if (result === 'delivered') {
        await transaction.$executeRaw`
          UPDATE "notification_p2_rate_reservations"
             SET "reserved_at" = ${at}, "lease_until" = ${at}, "confirmed_at" = ${at}
           WHERE "tenant_id" = ${tenantId} AND "idempotency_key" = ${idempotencyKey}
        `;
        return;
      }
      const leaseUntil = new Date(at.getTime() + 120_000);
      await transaction.$executeRaw`
        UPDATE "notification_p2_rate_reservations"
           SET "lease_until" = ${leaseUntil}
         WHERE "tenant_id" = ${tenantId} AND "idempotency_key" = ${idempotencyKey}
           AND "confirmed_at" IS NULL
      `;
    });
  }

  /** Reserva el quiet window por grupo; el advisory xact lock serializa réplicas por tenant+grupo. */
  public reserveGroupDispatchSlot(
    tenantId: string,
    groupKey: string,
    idempotencyKey: string,
    attemptId: string,
    fencingToken: string,
    at: Date,
    quietPeriodMs: number,
    leaseMs: number,
  ): Promise<{ readonly granted: boolean; readonly coveredBy: string | null }> {
    const since = new Date(at.getTime() - quietPeriodMs);
    const leaseUntil = new Date(at.getTime() + leaseMs);
    const quietUntil = new Date(at.getTime() + quietPeriodMs);
    return this.client.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([tenantId, groupKey])}, 0))
      `;

      const notified = await transaction.$queryRaw<readonly { readonly id: string }[]>`
        SELECT "id"
          FROM "notification_attempts"
         WHERE "tenant_id" = ${tenantId}
           AND "group_key" = ${groupKey}
           AND "sent_at" >= ${since}
           AND "sent_at" <= ${at}
           AND "status" IN ('sent', 'fallback', 'acknowledged', 'superseded')
         ORDER BY "sent_at" DESC, "id" DESC
         LIMIT 1
      `;
      if (notified.length > 0) {
        return { granted: false, coveredBy: notified[0]!.id };
      }

      const existing = await transaction.$queryRaw<
        readonly {
          readonly idempotencyKey: string;
          readonly attemptId: string;
          readonly state: string;
          readonly leaseUntil: Date;
          readonly quietUntil: Date;
        }[]
      >`
        SELECT "idempotency_key" AS "idempotencyKey",
               "attempt_id" AS "attemptId",
               "state",
               "lease_until" AS "leaseUntil",
               "quiet_until" AS "quietUntil"
          FROM "notification_group_dispatch_reservations"
         WHERE "tenant_id" = ${tenantId} AND "group_key" = ${groupKey}
         FOR UPDATE
      `;
      const row = existing[0];
      if (row) {
        const active =
          (row.state === 'confirmed' && row.quietUntil > at) ||
          ((row.state === 'leased' || row.state === 'uncertain') && row.leaseUntil > at);
        if (active && (row.state !== 'uncertain' || row.idempotencyKey !== idempotencyKey)) {
          return { granted: false, coveredBy: row.attemptId };
        }
      }

      await transaction.$executeRaw`
        INSERT INTO "notification_group_dispatch_reservations" (
          "tenant_id", "group_key", "idempotency_key", "attempt_id", "fencing_token",
          "state", "reserved_at", "lease_until", "confirmed_at", "quiet_until"
        ) VALUES (
          ${tenantId}, ${groupKey}, ${idempotencyKey}, ${attemptId}, ${fencingToken},
          'leased', ${at}, ${leaseUntil}, NULL, ${quietUntil}
        )
        ON CONFLICT ("tenant_id", "group_key")
        DO UPDATE SET "idempotency_key" = EXCLUDED."idempotency_key",
                      "attempt_id" = EXCLUDED."attempt_id",
                      "fencing_token" = EXCLUDED."fencing_token",
                      "state" = 'leased',
                      "reserved_at" = EXCLUDED."reserved_at",
                      "lease_until" = EXCLUDED."lease_until",
                      "confirmed_at" = NULL,
                      "quiet_until" = EXCLUDED."quiet_until"
      `;
      return { granted: true, coveredBy: null };
    });
  }

  /** Settlement solo afecta al dueño del fencing token actual. */
  public settleGroupDispatchSlot(
    tenantId: string,
    groupKey: string,
    idempotencyKey: string,
    fencingToken: string,
    at: Date,
    quietPeriodMs: number,
    leaseMs: number,
    result: 'delivered' | 'failed' | 'uncertain',
  ): Promise<void> {
    return this.client.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([tenantId, groupKey])}, 0))
      `;
      if (result === 'failed') {
        await transaction.$executeRaw`
          DELETE FROM "notification_group_dispatch_reservations"
           WHERE "tenant_id" = ${tenantId} AND "group_key" = ${groupKey}
             AND "idempotency_key" = ${idempotencyKey} AND "fencing_token" = ${fencingToken}
             AND "state" <> 'confirmed'
        `;
        return;
      }
      if (result === 'delivered') {
        await transaction.$executeRaw`
          UPDATE "notification_group_dispatch_reservations"
             SET "state" = 'confirmed', "confirmed_at" = ${at}, "lease_until" = ${at},
                 "quiet_until" = ${new Date(at.getTime() + quietPeriodMs)}
           WHERE "tenant_id" = ${tenantId} AND "group_key" = ${groupKey}
             AND "idempotency_key" = ${idempotencyKey} AND "fencing_token" = ${fencingToken}
        `;
        return;
      }
      await transaction.$executeRaw`
        UPDATE "notification_group_dispatch_reservations"
           SET "state" = 'uncertain', "lease_until" = ${new Date(at.getTime() + leaseMs)}
         WHERE "tenant_id" = ${tenantId} AND "group_key" = ${groupKey}
           AND "idempotency_key" = ${idempotencyKey} AND "fencing_token" = ${fencingToken}
           AND "state" <> 'confirmed'
      `;
    });
  }

  public listUndigested(
    tenantId: string,
    limit: number,
  ): Promise<readonly NotificationAttemptRow[]> {
    return this.client.notificationAttempt.findMany({
      where: { tenantId, status: 'suppressed', digestId: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: Math.min(Math.max(limit, 1), 2_000),
    });
  }

  /**
   * Inserta el primer intento o guarda su estado más reciente. La identidad del intento,
   * mensaje e idempotency key no cambia al pasar por retries o acknowledgements.
   */
  public async save(attempt: NotificationAttemptRow): Promise<void> {
    if (attempt.status === 'acknowledged') {
      throw new Error('NOTIFICATION_ACKNOWLEDGEMENT_REQUIRES_ATOMIC_WRITE');
    }
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
      groupKey: attempt.groupKey ?? null,
      context:
        attempt.context === undefined || attempt.context === null
          ? Prisma.DbNull
          : (attempt.context as Prisma.InputJsonValue),
      delivery: (attempt.delivery ?? []) as Prisma.InputJsonValue,
      suppressionReason: attempt.suppressionReason ?? null,
      supersededBy: attempt.supersededBy ?? null,
      digestId: attempt.digestId ?? null,
    };
    // updateMany accepts the scalar WhereInput (not WhereUniqueInput), so keep the
    // composite identity as its constituent equality predicates.
    const where = { tenantId, idempotencyKey };
    if (existing) {
      this.assertIdentity(existing, attempt);
      // The dispatcher can hold a stale snapshot across provider I/O. Once a human
      // acknowledges the attempt, that snapshot must not revert its terminal status.
      await this.client.notificationAttempt.updateMany({
        where: { ...where, status: { not: 'acknowledged' } },
        data: mutable,
      });
      return;
    }

    try {
      await this.client.notificationAttempt.create({
        data: { ...mutable, id: attempt.id, tenantId, idempotencyKey },
      });
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
      await this.client.notificationAttempt.updateMany({
        where: { ...where, status: { not: 'acknowledged' } },
        data: mutable,
      });
    }
  }

  /** CAS del estado y callback de auditoría en la misma transacción Prisma. */
  public acknowledgeWithAudit(
    tenantId: string,
    attemptId: string,
    actorId: string,
    at: Date,
    appendAudit: (tx: Prisma.TransactionClient, previousStatus: string) => Promise<void>,
  ): Promise<NotificationAttemptRow | undefined> {
    return this.client.$transaction(async (tx) => {
      const current = await tx.notificationAttempt.findFirst({
        where: { tenantId, id: attemptId },
      });
      if (!current || !['sent', 'indeterminate', 'fallback'].includes(current.status)) {
        return undefined;
      }
      const changed = await tx.notificationAttempt.updateMany({
        where: {
          tenantId,
          id: attemptId,
          status: { in: ['sent', 'indeterminate', 'fallback'] },
        },
        data: {
          status: 'acknowledged',
          acknowledgedAt: at,
          acknowledgedBy: actorId,
          updatedAt: at,
        },
      });
      if (changed.count !== 1) return undefined;
      await appendAudit(tx, current.status);
      return (
        (await tx.notificationAttempt.findFirst({ where: { tenantId, id: attemptId } })) ??
        undefined
      );
    });
  }
}

export interface NotificationChannelRow {
  readonly tenantId: string;
  readonly channelId: string;
  readonly enabled: boolean;
  readonly secretCiphertext: string | null;
  readonly secretHint: string | null;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly lastHttpStatus: number | null;
  readonly lastFailureReason: string | null;
  readonly lastTestAt: Date | null;
  readonly lastTestOutcome: string | null;
  readonly lastTestHttpStatus: number | null;
  readonly lastTestProviderId: string | null;
  /** Revisión de la configuración; la salud no la mueve. */
  readonly revision: number;
}

export type NotificationChannelHealthRow = Pick<
  NotificationChannelRow,
  | 'lastSuccessAt'
  | 'lastFailureAt'
  | 'lastHttpStatus'
  | 'lastFailureReason'
  | 'lastTestAt'
  | 'lastTestOutcome'
  | 'lastTestHttpStatus'
  | 'lastTestProviderId'
>;

/** Canales de aviso administrables: una fila por (tenant, canal). */
export class PrismaNotificationChannelStore {
  public constructor(private readonly client: PrismaClient) {}

  public list(tenantId: string): Promise<readonly NotificationChannelRow[]> {
    return this.client.notificationChannel.findMany({
      where: { tenantId },
      orderBy: { channelId: 'asc' },
    });
  }

  public async get(
    tenantId: string,
    channelId: string,
  ): Promise<NotificationChannelRow | undefined> {
    const row = await this.client.notificationChannel.findUnique({
      where: { tenantId_channelId: { tenantId, channelId } },
    });
    return row ?? undefined;
  }

  /** Inserta solo si no existe (`ON CONFLICT DO NOTHING`): la fila guardada nunca se pisa. */
  public async create(row: NotificationChannelRow): Promise<boolean> {
    const created = await this.client.notificationChannel.createMany({
      data: [row],
      skipDuplicates: true,
    });
    return created.count === 1;
  }

  /**
   * Compare-and-set de la configuración: escribe la fila completa solo si la revisión guardada
   * es `expectedRevision` (`0` = la fila no existe todavía y se inserta).
   */
  public async saveConfig(row: NotificationChannelRow, expectedRevision: number): Promise<boolean> {
    if (expectedRevision === 0) return this.create(row);
    const { tenantId, channelId, ...data } = row;
    const changed = await this.client.notificationChannel.updateMany({
      where: { tenantId, channelId, revision: expectedRevision },
      data,
    });
    return changed.count === 1;
  }

  /** Solo columnas de salud: no toca `enabled`, el secreto ni `revision`. */
  public async saveHealth(
    tenantId: string,
    channelId: string,
    health: NotificationChannelHealthRow,
    expectedRevision?: number,
  ): Promise<boolean> {
    const changed = await this.client.notificationChannel.updateMany({
      where: { tenantId, channelId, ...(expectedRevision === undefined ? {} : { revision: expectedRevision }) },
      data: {
        lastSuccessAt: health.lastSuccessAt,
        lastFailureAt: health.lastFailureAt,
        lastHttpStatus: health.lastHttpStatus,
        lastFailureReason: health.lastFailureReason,
        lastTestAt: health.lastTestAt,
        lastTestOutcome: health.lastTestOutcome,
        lastTestHttpStatus: health.lastTestHttpStatus,
        lastTestProviderId: health.lastTestProviderId,
      },
    });
    return changed.count === 1;
  }
}
