/**
 * Resúmenes periódicos de avisos (digest).
 *
 * - **Suprimidas** (agrupadas, atrasadas o por tope): cuando la más antigua sin resumir supera
 *   `digestFlushMs`, sale una sola tarjeta con los grupos, sus conteos y enlaces. Así una
 *   ráfaga tras una caída llega como un único resumen y no como 30 tarjetas.
 * - **P3/P4**: cada `digestIntervalMs`, un resumen de las alertas de baja prioridad nuevas.
 *
 * Cada resumen es a su vez un intento (`groupKey` `digest:*`) con su evidencia de entrega, de
 * modo que la consola lo muestra y el siguiente resumen sabe desde cuándo contar.
 */

import { randomUUID } from 'node:crypto';

import { recordAudit, type AuditStore } from '@qapaq/audit';

import { RETRY_POLICY } from './delivery-policy.js';
import {
  buildDigestCard,
  buildDigestEmail,
  DIGEST_REASON_LABELS,
  investigationLink,
  type DigestInput,
  type DigestLine,
} from './notification-content.js';
import { maskText, sourceFromTitle, type NotificationPriority } from './notification-context.js';
import {
  DEFAULT_NOTIFICATION_POLICY,
  type NotificationPolicyConfig,
} from './notification-policy.js';
import { createAttempt, type DeliveryEvidence, type NotificationAttempt } from './notification.js';
import type { NotificationRecipient, RecipientDirectory } from './notification-routing.js';
import type { AttemptStore, MailChannel } from './ports.js';
import type { NotificationTransport } from './teams-adapter.js';
import { contextOf } from './dispatcher.js';

export const DIGEST_GROUPS = Object.freeze({
  suppressed: 'digest:suppressed',
  lowPriority: 'digest:low_priority',
  aiAnalyst: 'digest:ai_analyst',
});

export interface LowPriorityAlert {
  readonly alertId: string;
  readonly title: string;
  readonly priority: NotificationPriority;
  readonly ruleId: string | null;
  readonly occurredAt: Date;
}

export interface DigestDependencies {
  readonly tenantId: string;
  readonly attempts: AttemptStore;
  readonly transport: NotificationTransport;
  readonly audit: AuditStore;
  readonly clock: { now(): Date };
  readonly consoleBaseUrl: string;
  readonly policy?: NotificationPolicyConfig;
  readonly recipients?: RecipientDirectory;
  readonly mail?: MailChannel;
  /** Alertas P3/P4 creadas desde `since` (acotado por el adapter) y el total real. */
  readonly lowPriorityAlerts?: (
    since: Date,
  ) => Promise<{ readonly items: readonly LowPriorityAlert[]; readonly total: number }>;
}

const UNDIGESTED_LIMIT = 500;

async function send(
  dependencies: DigestDependencies,
  digest: NotificationAttempt,
  input: DigestInput,
  roles: readonly ('qapaq.soc.lead' | 'qapaq.soc.analyst')[],
): Promise<NotificationAttempt> {
  const at = dependencies.clock.now();
  const outcome = await dependencies.transport.send(
    buildDigestCard(input, digest.clientRequestId),
    digest.clientRequestId,
  );
  const responseAt = outcome.delivered
    ? (outcome.responseAt ?? dependencies.clock.now().toISOString())
    : undefined;
  const delivery: DeliveryEvidence[] = [
    ...(digest.delivery ?? []),
    {
      channel: 'teams',
      outcome: outcome.delivered ? 'accepted' : 'failed',
      at: at.toISOString(),
      ...(responseAt ? { responseAt } : {}),
      httpStatus: outcome.httpStatus ?? null,
      providerMessageId: outcome.providerMessageId ?? null,
      providerLink: null,
      reason: outcome.delivered ? null : (outcome.failure?.code ?? 'UNKNOWN'),
    },
  ];
  if (dependencies.mail && digest.attemptCount === 0) {
    let recipients: readonly NotificationRecipient[] = [];
    try {
      recipients = dependencies.recipients
        ? await dependencies.recipients.recipientsFor(dependencies.tenantId, roles)
        : [];
    } catch {
      recipients = [];
    }
    if (recipients.length > 0) {
      delivery.push(
        await dependencies.mail
          .send({
            recipients,
            email: buildDigestEmail(input),
            clientRequestId: digest.clientRequestId,
          })
          .catch((): DeliveryEvidence => ({
            channel: 'email',
            outcome: 'failed',
            at: at.toISOString(),
            httpStatus: null,
            providerMessageId: null,
            providerLink: null,
            reason: 'GRAPH_MAIL_UNAVAILABLE',
          })),
      );
    }
  }
  const attemptCount = digest.attemptCount + 1;
  const exhausted = !outcome.delivered && attemptCount >= RETRY_POLICY.maximumAttempts;
  const acceptedAt = responseAt ? new Date(responseAt) : null;
  const saved: NotificationAttempt = {
    ...digest,
    attemptCount,
    status: outcome.delivered ? 'sent' : exhausted ? 'failed' : 'pending',
    sentAt: outcome.delivered ? acceptedAt : digest.sentAt,
    lastFailureCode: outcome.delivered ? null : (outcome.failure?.code ?? 'UNKNOWN'),
    lastFailureClass: outcome.delivered ? null : (outcome.failure?.class ?? 'transient'),
    updatedAt: at,
    delivery,
  };
  await dependencies.attempts.save(saved);
  await recordAudit(dependencies.audit, {
    id: randomUUID(),
    tenantId: dependencies.tenantId,
    occurredAt: at,
    actor: { id: 'system:soar', type: 'service' },
    action: `soar.notification.digest_${outcome.delivered ? 'sent' : 'failed'}`,
    resource: { type: 'notification', id: saved.id },
    outcome: outcome.delivered ? 'succeeded' : 'failed',
    correlationId: saved.idempotencyKey,
    metadata: {
      groupKey: saved.groupKey ?? '',
      total: input.total,
      ...(outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus }),
      ...(outcome.providerMessageId ? { providerMessageId: outcome.providerMessageId } : {}),
    },
  });
  return saved;
}

function digestAttempt(
  dependencies: DigestDependencies,
  existing: NotificationAttempt | undefined,
  idempotencyKey: string,
  groupKey: string,
  title: string,
  at: Date,
): NotificationAttempt {
  return (
    existing ?? {
      ...createAttempt({
        id: randomUUID(),
        tenantId: dependencies.tenantId,
        messageId: randomUUID(),
        idempotencyKey,
        at,
      }),
      groupKey,
      context: {
        kind: 'digest',
        title,
        alertId: null,
        incidentId: null,
        priority: null,
        occurredAt: at.toISOString(),
      },
    }
  );
}

/** Resume lo suprimido cuando lo más antiguo sin resumir supera `digestFlushMs`. */
export async function runSuppressedDigest(
  dependencies: DigestDependencies,
): Promise<NotificationAttempt | undefined> {
  const policy = dependencies.policy ?? DEFAULT_NOTIFICATION_POLICY;
  const now = dependencies.clock.now();
  const pending = await dependencies.attempts.listUndigested(
    dependencies.tenantId,
    UNDIGESTED_LIMIT,
  );
  if (pending.length === 0) return undefined;
  const oldest = pending[0]!;
  if (now.getTime() - oldest.createdAt.getTime() < policy.digestFlushMs) return undefined;
  const idempotencyKey = `digest:suppressed:${oldest.id}`;
  const existing = await dependencies.attempts.byIdempotencyKey(
    dependencies.tenantId,
    idempotencyKey,
  );
  if (existing && existing.status === 'pending' && existing.availableAt.getTime() > now.getTime()) {
    return undefined;
  }
  const groups = new Map<string, { items: NotificationAttempt[] }>();
  for (const item of pending) {
    const key = item.groupKey ?? item.id;
    const group = groups.get(key) ?? { items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const lines: DigestLine[] = [...groups.values()]
    .map(({ items }) => {
      const contexts = items.map((item) => contextOf(item)).filter((item) => item !== undefined);
      const latest = contexts.at(-1);
      const seen = contexts.map((context) => context.occurredAt).sort();
      const reasons = new Set(items.map((item) => item.suppressionReason ?? 'digest'));
      return {
        title: latest?.title ?? 'Alerta',
        priority: latest?.priority ?? null,
        source: latest?.source?.vendor ?? null,
        count: items.length,
        firstSeen: seen[0] ?? items[0]!.createdAt.toISOString(),
        lastSeen: seen.at(-1) ?? items.at(-1)!.createdAt.toISOString(),
        url: latest?.alertId
          ? investigationLink(dependencies.consoleBaseUrl, latest.alertId)
          : `${dependencies.consoleBaseUrl.replace(/\/+$/u, '')}/app/qapaq-alerts`,
        reason: [...reasons].map((reason) => DIGEST_REASON_LABELS[reason] ?? reason).join(', '),
      };
    })
    .sort(
      (left, right) =>
        (left.priority ?? 'P9').localeCompare(right.priority ?? 'P9') || right.count - left.count,
    );
  const total = pending.length;
  const digest = digestAttempt(
    dependencies,
    existing,
    idempotencyKey,
    DIGEST_GROUPS.suppressed,
    `Resumen de alertas agrupadas · ${total} ocurrencia(s)`,
    now,
  );
  const input: DigestInput = {
    digestId: digest.id,
    kind: 'suppressed',
    from: oldest.createdAt.toISOString(),
    to: now.toISOString(),
    lines,
    total,
    consoleBaseUrl: dependencies.consoleBaseUrl,
    timeZone: policy.timeZone,
  };
  const saved = await send(dependencies, digest, input, ['qapaq.soc.analyst', 'qapaq.soc.lead']);
  if (saved.status === 'pending') {
    await dependencies.attempts.save({
      ...saved,
      availableAt: new Date(now.getTime() + policy.digestFlushMs),
    });
    return saved;
  }
  // Entregado o agotado: cada suprimida queda vinculada al resumen (la consola lo muestra).
  for (const item of pending) {
    await dependencies.attempts.save({ ...item, digestId: saved.id, updatedAt: now });
  }
  return saved;
}

/** Resumen P3/P4 cada `digestIntervalMs` (0 = apagado). */
export async function runLowPriorityDigest(
  dependencies: DigestDependencies,
): Promise<NotificationAttempt | undefined> {
  const policy = dependencies.policy ?? DEFAULT_NOTIFICATION_POLICY;
  if (policy.digestIntervalMs <= 0 || !dependencies.lowPriorityAlerts) return undefined;
  const now = dependencies.clock.now();
  const last = await dependencies.attempts.lastNotifiedInGroup(
    dependencies.tenantId,
    DIGEST_GROUPS.lowPriority,
    new Date(now.getTime() - 30 * 86_400_000),
  );
  if (last?.sentAt && now.getTime() - last.sentAt.getTime() < policy.digestIntervalMs) {
    return undefined;
  }
  const from = last?.sentAt ?? new Date(now.getTime() - policy.digestIntervalMs);
  // La ventana se alinea al intervalo: reintentos del mismo periodo reutilizan el intento.
  const windowStart = new Date(Math.floor(from.getTime() / 60_000) * 60_000);
  const idempotencyKey = `digest:low:${windowStart.toISOString()}`;
  const existing = await dependencies.attempts.byIdempotencyKey(
    dependencies.tenantId,
    idempotencyKey,
  );
  if (
    existing &&
    (existing.availableAt.getTime() > now.getTime() ||
      (existing.status === 'failed' &&
        now.getTime() - existing.updatedAt.getTime() < policy.digestIntervalMs))
  ) {
    return undefined;
  }
  const alerts = await dependencies.lowPriorityAlerts(from);
  if (alerts.total === 0) return undefined;
  const byRule = new Map<string, LowPriorityAlert[]>();
  for (const alert of alerts.items) {
    const key = `${alert.priority}|${alert.ruleId ?? alert.title}`;
    byRule.set(key, [...(byRule.get(key) ?? []), alert]);
  }
  const lines: DigestLine[] = [...byRule.values()]
    .map((items) => {
      const sorted = [...items].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
      const latest = sorted.at(-1)!;
      return {
        title: maskText(latest.title).slice(0, 200),
        priority: latest.priority,
        source: sourceFromTitle(latest.title, latest.ruleId)?.vendor ?? null,
        count: items.length,
        firstSeen: sorted[0]!.occurredAt.toISOString(),
        lastSeen: latest.occurredAt.toISOString(),
        url: investigationLink(dependencies.consoleBaseUrl, latest.alertId),
        reason: latest.ruleId ? `regla ${latest.ruleId}` : DIGEST_REASON_LABELS['digest']!,
      };
    })
    .sort(
      (left, right) => left.priority!.localeCompare(right.priority!) || right.count - left.count,
    );
  const digest = digestAttempt(
    dependencies,
    existing,
    idempotencyKey,
    DIGEST_GROUPS.lowPriority,
    `Resumen P3/P4 · ${alerts.total} alerta(s)`,
    now,
  );
  const saved = await send(
    dependencies,
    digest,
    {
      digestId: digest.id,
      kind: 'low_priority',
      from: from.toISOString(),
      to: now.toISOString(),
      lines,
      total: alerts.total,
      consoleBaseUrl: dependencies.consoleBaseUrl,
      timeZone: policy.timeZone,
    },
    ['qapaq.soc.lead'],
  );
  if (saved.status === 'pending') {
    await dependencies.attempts.save({
      ...saved,
      availableAt: new Date(now.getTime() + 15 * 60_000),
    });
  }
  return saved;
}

/** Resumen diario del Analista IA ya armado por el host (sin texto de modelo). */
export interface AnalystDigestInput {
  /** Día local `AAAA-MM-DD` del resumen: clave de idempotencia (uno por día). */
  readonly date: string;
  readonly from: Date;
  readonly to: Date;
  readonly lines: readonly DigestLine[];
  /** Casos que esperan a una persona en la ventana. */
  readonly total: number;
}

/**
 * Envía el resumen diario del Analista IA por el mismo canal y con la misma evidencia que los
 * demás resúmenes. Idempotente por día: un resumen ya entregado (o agotado) no se repite; uno
 * pendiente de reintento espera su `availableAt`.
 */
export async function runAnalystDigest(
  dependencies: DigestDependencies,
  input: AnalystDigestInput,
): Promise<NotificationAttempt | undefined> {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.date)) return undefined;
  const policy = dependencies.policy ?? DEFAULT_NOTIFICATION_POLICY;
  const now = dependencies.clock.now();
  const idempotencyKey = `digest:ai:${input.date}`;
  const existing = await dependencies.attempts.byIdempotencyKey(
    dependencies.tenantId,
    idempotencyKey,
  );
  if (
    existing &&
    (existing.status !== 'pending' || existing.availableAt.getTime() > now.getTime())
  ) {
    return undefined;
  }
  const digest = digestAttempt(
    dependencies,
    existing,
    idempotencyKey,
    DIGEST_GROUPS.aiAnalyst,
    `Analista IA · resumen del ${input.date}`,
    now,
  );
  const saved = await send(
    dependencies,
    digest,
    {
      digestId: digest.id,
      kind: 'ai_analyst',
      from: input.from.toISOString(),
      to: input.to.toISOString(),
      lines: input.lines,
      total: input.total,
      consoleBaseUrl: dependencies.consoleBaseUrl,
      timeZone: policy.timeZone,
    },
    ['qapaq.soc.lead'],
  );
  if (saved.status === 'pending') {
    await dependencies.attempts.save({
      ...saved,
      availableAt: new Date(now.getTime() + 15 * 60_000),
    });
  }
  return saved;
}
