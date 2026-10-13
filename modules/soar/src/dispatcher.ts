/**
 * C-20 — consumidor del outbox y despacho de la notificación.
 *
 * Reglas que el consumidor sostiene:
 *
 * 1. **Un mensaje, un intento vivo**: el intento se deriva de la `idempotencyKey` del
 *    outbox, de modo que reprocesar el mismo mensaje no abre una segunda notificación.
 * 2. **El reenvío conserva el `clientRequestId`**: tras un fallo ambiguo se reintenta
 *    con el mismo identificador para que el destino deduplique.
 * 3. **Agotar no es callar**: cuando se agotan los intentos se pasa a `fallback`, que
 *    sigue exigiendo acuse humano en QAPAQ.
 */

import { recordAudit, type AuditStore } from '@qapaq/audit';
import type { OutboxMessageDraft } from '@qapaq/soc';

import { nextDelayMs, shouldRetry, type DeliveryFailure } from './delivery-policy.js';
import {
  createAttempt,
  type NotificationAttempt,
  type NotificationStatus,
} from './notification.js';
import {
  MAXIMUM_MENTIONS,
  rolesToNotify,
  type NotificationRecipient,
  type RecipientDirectory,
} from './notification-routing.js';
import { buildTeamsMessage } from './teams-payload.js';
import type { NotificationTransport } from './teams-adapter.js';
import type { AttemptStore, FallbackChannel, OutboxReader } from './ports.js';

export interface DispatchDependencies {
  readonly outbox: OutboxReader;
  readonly attempts: AttemptStore;
  readonly transport: NotificationTransport;
  readonly fallback: FallbackChannel;
  readonly audit: AuditStore;
  readonly clock: { now(): Date };
  readonly ids: { next(): string };
  readonly consoleBaseUrl: string;
  /**
   * Destinatarios por rol (Sprint 5). Sin directorio, la tarjeta sale al canal sin menciones:
   * el aviso llega igual, sin dirigirse a nadie en particular.
   */
  readonly recipients?: RecipientDirectory;
  /**
   * Aviso a los dispositivos de los destinatarios (Web Push, Sprint 5). Independiente de Teams:
   * se intenta en el primer intento de cada mensaje y nunca bloquea ni cambia su resultado.
   */
  readonly devices?: { notify(tenantId: string, subjectKeys: readonly string[]): Promise<number> };
}

export const DISPATCH_RESULTS = [
  'skipped_not_critical',
  'delivered',
  'already_delivered',
  'retry_scheduled',
  'indeterminate_retry',
  'fallback_used',
] as const;
export type DispatchResultCode = (typeof DISPATCH_RESULTS)[number];

export interface DispatchResult {
  readonly code: DispatchResultCode;
  readonly attempt?: NotificationAttempt;
  readonly failure?: DeliveryFailure;
}

async function auditDelivery(
  dependencies: DispatchDependencies,
  attempt: NotificationAttempt,
  status: NotificationStatus,
  at: Date,
  reason?: string,
): Promise<void> {
  await recordAudit(dependencies.audit, {
    id: dependencies.ids.next(),
    tenantId: attempt.tenantId,
    occurredAt: at,
    actor: { id: 'system:soar', type: 'service' },
    action: `soar.notification.${status}`,
    resource: { type: 'notification', id: attempt.id },
    outcome: status === 'sent' || status === 'fallback' ? 'succeeded' : 'failed',
    correlationId: attempt.idempotencyKey,
    ...(reason === undefined ? {} : { reason }),
    metadata: {
      channel: attempt.channel,
      attemptCount: attempt.attemptCount,
      destination: dependencies.transport.destinationRef,
    },
  });
}

export async function dispatchMessage(
  dependencies: DispatchDependencies,
  message: OutboxMessageDraft,
): Promise<DispatchResult> {
  const at = dependencies.clock.now();
  // La política de ruteo decide si el evento se notifica y a qué roles.
  const roles = rolesToNotify(message);
  if (roles.length === 0) {
    await dependencies.outbox.markPublished(message.messageId, at);
    return { code: 'skipped_not_critical' };
  }
  const existing = await dependencies.attempts.byIdempotencyKey(
    message.tenantId,
    message.idempotencyKey,
  );
  if (existing && ['sent', 'acknowledged', 'fallback'].includes(existing.status)) {
    // Reprocesar un mensaje ya entregado no vuelve a publicar en el canal.
    await dependencies.outbox.markPublished(message.messageId, at);
    return { code: 'already_delivered', attempt: existing };
  }
  const attempt =
    existing ??
    createAttempt({
      id: dependencies.ids.next(),
      tenantId: message.tenantId,
      messageId: message.messageId,
      idempotencyKey: message.idempotencyKey,
      at,
    });
  const sending: NotificationAttempt = {
    ...attempt,
    status: 'sending',
    attemptCount: attempt.attemptCount + 1,
    updatedAt: at,
  };
  await dependencies.attempts.save(sending);

  // Un directorio caído no bloquea el aviso: sale sin menciones antes que no salir.
  let mentions: readonly NotificationRecipient[] = [];
  try {
    mentions = dependencies.recipients
      ? (await dependencies.recipients.recipientsFor(message.tenantId, roles)).slice(
          0,
          MAXIMUM_MENTIONS,
        )
      : [];
  } catch {
    mentions = [];
  }
  // Dispositivos: una vez por mensaje (primer intento), en paralelo con Teams. Se espera antes
  // de terminar la pasada (el apagado ordenado lo incluye) y nunca cambia el resultado.
  const devicesNotified =
    dependencies.devices && sending.attemptCount === 1
      ? dependencies.devices
          .notify(
            message.tenantId,
            mentions.flatMap((recipient) => (recipient.subjectKey ? [recipient.subjectKey] : [])),
          )
          .catch(() => 0)
      : Promise.resolve(0);
  const payload = buildTeamsMessage({
    tenantId: message.tenantId,
    messageType: message.messageType,
    aggregateType: message.aggregateType,
    aggregateId: message.aggregateId,
    title: String(message.payload.title ?? message.messageType),
    severity: String(message.payload.severity ?? message.payload.priority ?? 'critical'),
    occurredAt: message.availableAt,
    consoleBaseUrl: dependencies.consoleBaseUrl,
    clientRequestId: sending.clientRequestId,
    mentions,
  });
  const [outcome] = await Promise.all([
    dependencies.transport.send(payload, sending.clientRequestId),
    devicesNotified,
  ]);

  if (outcome.delivered) {
    const sent: NotificationAttempt = {
      ...sending,
      status: 'sent',
      sentAt: at,
      updatedAt: at,
      lastFailureCode: null,
      lastFailureClass: null,
    };
    await dependencies.attempts.save(sent);
    await dependencies.outbox.markPublished(message.messageId, at);
    await auditDelivery(dependencies, sent, 'sent', at);
    return { code: 'delivered', attempt: sent };
  }

  const failure = outcome.failure ?? {
    class: 'transient' as const,
    code: 'UNKNOWN',
    detail: 'Fallo sin clasificar.',
  };
  if (shouldRetry(failure, sending.attemptCount)) {
    const retrying: NotificationAttempt = {
      ...sending,
      status: failure.class === 'ambiguous' ? 'indeterminate' : 'pending',
      availableAt: new Date(at.getTime() + nextDelayMs(sending.attemptCount)),
      lastFailureCode: failure.code,
      lastFailureClass: failure.class,
      updatedAt: at,
    };
    await dependencies.attempts.save(retrying);
    await dependencies.outbox.scheduleRetry(message.messageId, retrying.availableAt, failure.code);
    return {
      code: failure.class === 'ambiguous' ? 'indeterminate_retry' : 'retry_scheduled',
      attempt: retrying,
      failure,
    };
  }

  const fallbackRef = await dependencies.fallback.notify({
    tenantId: message.tenantId,
    aggregateType: message.aggregateType,
    aggregateId: message.aggregateId,
    title: String(message.payload.title ?? message.messageType),
    severity: String(message.payload.severity ?? message.payload.priority ?? 'critical'),
    reason: failure.code,
    at,
    recipients: mentions,
    link: `${dependencies.consoleBaseUrl.replace(/\/+$/u, '')}/${message.aggregateType === 'incident' ? 'incidents' : 'alerts'}/${encodeURIComponent(message.aggregateId)}`,
  });
  const fallen: NotificationAttempt = {
    ...sending,
    status: 'fallback',
    channel: fallbackRef.channel,
    lastFailureCode: failure.code,
    lastFailureClass: failure.class,
    updatedAt: at,
  };
  await dependencies.attempts.save(fallen);
  await dependencies.outbox.markPublished(message.messageId, at);
  await auditDelivery(dependencies, fallen, 'fallback', at, failure.code);
  return { code: 'fallback_used', attempt: fallen, failure };
}

export async function drainOutbox(
  dependencies: DispatchDependencies,
  limit = 20,
): Promise<readonly DispatchResult[]> {
  const now = dependencies.clock.now();
  const messages = await dependencies.outbox.claimPending(limit, now);
  const results: DispatchResult[] = [];
  for (const message of messages) results.push(await dispatchMessage(dependencies, message));
  return results;
}
