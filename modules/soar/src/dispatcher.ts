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
 * 4. **Sin inundar el canal** (`notification-policy.ts`): agrupación por incidente,
 *    correlación o regla+entidad, re-aviso silencioso, atraso al resumen y tope por hora.
 * 5. **Evidencia por canal**: cada intento guarda el estado HTTP y el identificador que M365
 *    devolvió (run del Workflow, request-id de Graph), nunca el contenido ni la URL.
 */

import { recordAudit, type AuditStore } from '@qapaq/audit';
import type { OutboxMessageDraft } from '@qapaq/soc';

import { nextDelayMs, shouldRetry, type DeliveryFailure } from './delivery-policy.js';
import {
  buildAlertCard,
  buildAlertEmail,
  linksFor,
  type AlertNotificationInput,
} from './notification-content.js';
import {
  contextFromMessage,
  groupKeyFor,
  type NotificationContext,
  type NotificationEnricher,
} from './notification-context.js';
import {
  DEFAULT_NOTIFICATION_POLICY,
  decideNotification,
  type NotificationPolicyConfig,
} from './notification-policy.js';
import {
  createAttempt,
  type DeliveryEvidence,
  type NotificationAttempt,
  type NotificationStatus,
} from './notification.js';
import {
  MAXIMUM_MENTIONS,
  rolesToNotify,
  type NotificationRecipient,
  type RecipientDirectory,
} from './notification-routing.js';
import type { NotificationTransport } from './teams-adapter.js';
import type { AttemptStore, FallbackChannel, MailChannel, OutboxReader } from './ports.js';

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
  /** Contexto explicativo (alerta, catálogo, correlador). Sin él, lo mínimo del outbox. */
  readonly enricher?: NotificationEnricher;
  /** Copia por correo de P1/incidentes críticos (Graph `sendMail`), además de Teams. */
  readonly mail?: MailChannel;
  readonly policy?: NotificationPolicyConfig;
}

export const DISPATCH_RESULTS = [
  'skipped_not_critical',
  'delivered',
  'already_delivered',
  'retry_scheduled',
  'indeterminate_retry',
  'fallback_used',
  'suppressed',
] as const;
export type DispatchResultCode = (typeof DISPATCH_RESULTS)[number];

export interface DispatchResult {
  readonly code: DispatchResultCode;
  readonly attempt?: NotificationAttempt;
  readonly failure?: DeliveryFailure;
}

/** Ventana máxima hacia atrás para encontrar el último aviso de un grupo (re-aviso). */
const GROUP_LOOKBACK_MS = 24 * 3_600_000;
const GROUP_SUPPRESSED_LIMIT = 500;
const GROUP_DISPATCH_LEASE_MS = 120_000;

async function auditDelivery(
  dependencies: DispatchDependencies,
  attempt: NotificationAttempt,
  status: NotificationStatus,
  at: Date,
  reason?: string,
): Promise<void> {
  const last = attempt.delivery?.at(-1);
  await recordAudit(dependencies.audit, {
    id: dependencies.ids.next(),
    tenantId: attempt.tenantId,
    occurredAt: at,
    actor: { id: 'system:soar', type: 'service' },
    action: `soar.notification.${status}`,
    resource: { type: 'notification', id: attempt.id },
    outcome:
      status === 'sent' || status === 'fallback' || status === 'suppressed'
        ? 'succeeded'
        : 'failed',
    correlationId: attempt.idempotencyKey,
    ...(reason === undefined ? {} : { reason }),
    metadata: {
      channel: attempt.channel,
      attemptCount: attempt.attemptCount,
      destination: dependencies.transport.destinationRef,
      ...(last?.httpStatus == null ? {} : { httpStatus: last.httpStatus }),
      ...(last?.providerMessageId ? { providerMessageId: last.providerMessageId } : {}),
      ...(attempt.groupKey ? { groupKey: attempt.groupKey } : {}),
    },
  });
}

interface Notice {
  readonly occurrences: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly reminder: boolean;
  readonly late: boolean;
}

function noticeOf(attempt: NotificationAttempt): Notice | undefined {
  const notice = attempt.context?.['notice'];
  if (!notice || typeof notice !== 'object') return undefined;
  const value = notice as Record<string, unknown>;
  return {
    occurrences: typeof value['occurrences'] === 'number' ? value['occurrences'] : 1,
    firstSeen: String(value['firstSeen'] ?? ''),
    lastSeen: String(value['lastSeen'] ?? ''),
    reminder: value['reminder'] === true,
    late: value['late'] === true,
  };
}

/** Contexto guardado en un intento (sin el bloque `notice`). */
export function contextOf(attempt: NotificationAttempt): NotificationContext | undefined {
  const context = attempt.context;
  if (!context || typeof context['title'] !== 'string') return undefined;
  const { notice: _notice, ...rest } = context;
  return rest as unknown as NotificationContext;
}

function evidence(
  channel: DeliveryEvidence['channel'],
  at: Date,
  outcome: {
    readonly delivered: boolean;
    readonly httpStatus?: number;
    readonly providerMessageId?: string;
    readonly responseAt?: string;
    readonly failure?: DeliveryFailure;
  },
): DeliveryEvidence {
  return {
    channel,
    outcome: outcome.delivered ? 'accepted' : 'failed',
    at: at.toISOString(),
    ...(outcome.delivered && outcome.responseAt ? { responseAt: outcome.responseAt } : {}),
    httpStatus: outcome.httpStatus ?? null,
    providerMessageId: outcome.providerMessageId ?? null,
    providerLink: null,
    reason: outcome.delivered ? null : (outcome.failure?.code ?? 'UNKNOWN'),
  };
}

export async function dispatchMessage(
  dependencies: DispatchDependencies,
  message: OutboxMessageDraft,
): Promise<DispatchResult> {
  const at = dependencies.clock.now();
  const policy = dependencies.policy ?? DEFAULT_NOTIFICATION_POLICY;
  // La política de ruteo decide si el evento se notifica y a qué roles. P3/P4 no abren intento:
  // los resume el digest periódico leyendo las alertas.
  const roles = rolesToNotify(message);
  if (roles.length === 0) {
    await dependencies.outbox.markPublished(message.messageId, at);
    return { code: 'skipped_not_critical' };
  }
  const existing = await dependencies.attempts.byIdempotencyKey(
    message.tenantId,
    message.idempotencyKey,
  );
  if (
    existing &&
    ['sent', 'acknowledged', 'fallback', 'suppressed', 'superseded'].includes(existing.status)
  ) {
    // Reprocesar un mensaje ya resuelto no vuelve a publicar en el canal.
    await dependencies.outbox.markPublished(message.messageId, at);
    return { code: 'already_delivered', attempt: existing };
  }

  // Pedido de revisión del Analista IA: texto fijo del outbox (sin enriquecer con la alerta), grupo
  // propio y, si es `digest`, directo al resumen de lo suprimido (un mensaje por ventana).
  const review = message.messageType === 'soc.alert.review_requested';
  const reviewGroup =
    review && typeof message.payload['groupKey'] === 'string'
      ? `ai-review:${message.payload['groupKey']}`
      : undefined;
  const reviewDigest = review && message.payload['urgency'] !== 'immediate';

  // Contexto: en el primer intento se arma (y se guarda); en reintentos se reutiliza tal cual.
  let context = existing ? contextOf(existing) : undefined;
  let entityKeys: readonly string[] = [];
  let occurredAt = message.availableAt;
  if (context) {
    occurredAt = new Date(context.occurredAt);
  } else {
    try {
      const enriched =
        dependencies.enricher && !review
          ? await dependencies.enricher.contextFor(message)
          : undefined;
      if (enriched) {
        context = enriched.context;
        entityKeys = enriched.entityKeys;
        occurredAt = enriched.occurredAt;
      }
    } catch {
      // Un enriquecedor caído no bloquea el aviso: sale con lo mínimo.
      context = undefined;
    }
    context ??= review
      ? {
          ...contextFromMessage(message),
          nextStep: 'Abre el expediente del Analista IA desde la alerta y decide el siguiente paso.',
        }
      : contextFromMessage(message);
  }
  const groupKey =
    existing?.groupKey ??
    reviewGroup ??
    groupKeyFor({
      messageType: message.messageType,
      aggregateType: message.aggregateType,
      aggregateId: message.aggregateId,
      incidentId: context.kind === 'alert' ? context.incidentId : null,
      ruleId: context.correlation ? `corr:${context.correlation.patternId}` : context.ruleId,
      entityKeys,
      title: context.title,
      sourceId: context.source?.id ?? null,
      priority: context.priority,
    });
  const effectivePriority = message.aggregateType === 'incident' ? 'P1' : context.priority;
  const quietPeriodMs =
    effectivePriority === 'P2' ? policy.quietPeriodMs.P2 : policy.quietPeriodMs.P1;

  const base =
    existing ??
    createAttempt({
      id: dependencies.ids.next(),
      tenantId: message.tenantId,
      messageId: message.messageId,
      idempotencyKey: message.idempotencyKey,
      at,
    });

  let notice = existing ? noticeOf(existing) : undefined;
  const usesP2Slot = context.priority === 'P2' && !reviewDigest;
  let p2SlotReserved = false;
  if (!notice) {
    const last = await dependencies.attempts.lastNotifiedInGroup(
      message.tenantId,
      groupKey,
      new Date(at.getTime() - GROUP_LOOKBACK_MS),
    );
    const since = last ? (last.sentAt ?? last.createdAt) : null;
    const suppressed = since
      ? await dependencies.attempts.listSuppressedInGroup(
          message.tenantId,
          groupKey,
          since,
          GROUP_SUPPRESSED_LIMIT,
        )
      : [];
    let decision = decideNotification({
      // Un pedido `digest` se trata como baja prioridad: el resumen periódico lo agrupa.
      priority: reviewDigest ? null : context.priority,
      incident: message.aggregateType === 'incident',
      occurredAt,
      now: at,
      history: {
        lastNotified: last && since ? { id: last.id, at: since } : null,
        suppressedSinceLast: suppressed.length,
        // P2 quota is reserved atomically below; a count-then-send check races across replicas.
        immediateLastHour: 0,
      },
      config: policy,
    });
    if (decision.kind === 'notify' && context.priority === 'P2') {
      const reserved = await dependencies.attempts.reserveP2ImmediateSlot(
        message.tenantId,
        message.idempotencyKey,
        at,
        policy.maxImmediatePerHour,
      );
      if (!reserved) decision = { kind: 'suppress', reason: 'rate_limited', coveredBy: null };
      else p2SlotReserved = true;
    }
    if (decision.kind === 'suppress') {
      const held: NotificationAttempt = {
        ...base,
        status: 'suppressed',
        suppressionReason: decision.reason,
        supersededBy: decision.coveredBy,
        // Agrupada: ya la cubre un aviso enviado; no vuelve a salir en el resumen de suprimidas.
        ...(decision.reason === 'grouped' && decision.coveredBy
          ? { digestId: decision.coveredBy }
          : {}),
        groupKey,
        context: { ...context },
        updatedAt: at,
      };
      await dependencies.attempts.save(held);
      await dependencies.outbox.markPublished(message.messageId, at);
      await auditDelivery(dependencies, held, 'suppressed', at, decision.reason);
      return { code: 'suppressed', attempt: held };
    }
    const seen = suppressed
      .map((item) => contextOf(item)?.occurredAt)
      .filter((value): value is string => Boolean(value))
      .sort();
    notice = {
      occurrences: decision.occurrences,
      firstSeen: seen[0] ?? occurredAt.toISOString(),
      lastSeen: occurredAt.toISOString(),
      reminder: decision.reminderOf !== null,
      late: decision.late,
    };
  }

  // Los reintentos ya tienen notice/context persistidos; renuevan la misma plaza antes de enviar.
  if (usesP2Slot && !p2SlotReserved) {
    const reserved = await dependencies.attempts.reserveP2ImmediateSlot(
      message.tenantId,
      message.idempotencyKey,
      at,
      policy.maxImmediatePerHour,
    );
    if (!reserved) {
      const held: NotificationAttempt = {
        ...base,
        status: 'suppressed',
        suppressionReason: 'rate_limited',
        supersededBy: null,
        groupKey,
        context: { ...context },
        updatedAt: at,
      };
      await dependencies.attempts.save(held);
      await dependencies.outbox.markPublished(message.messageId, at);
      await auditDelivery(dependencies, held, 'suppressed', at, 'rate_limited');
      return { code: 'suppressed', attempt: held };
    }
    p2SlotReserved = true;
  }

  // The group check and its reservation are one cross-replica decision. Without this lease, two
  // different outbox rows for the same incident/rule can both observe no recent sent attempt.
  const groupFence = dependencies.ids.next();
  const groupReservation = await dependencies.attempts.reserveGroupDispatchSlot(
    message.tenantId,
    groupKey,
    message.idempotencyKey,
    base.id,
    groupFence,
    at,
    quietPeriodMs,
    GROUP_DISPATCH_LEASE_MS,
  );
  if (!groupReservation.granted) {
    if (p2SlotReserved) {
      await dependencies.attempts.settleP2ImmediateSlot(
        message.tenantId,
        message.idempotencyKey,
        at,
        'failed',
      );
    }
    const held: NotificationAttempt = {
      ...base,
      status: 'suppressed',
      suppressionReason: 'grouped',
      supersededBy: groupReservation.coveredBy,
      // Cubierta por el aviso en curso del grupo: no se repite en el resumen de suprimidas.
      ...(groupReservation.coveredBy ? { digestId: groupReservation.coveredBy } : {}),
      groupKey,
      context: { ...context, ...(notice ? { notice } : {}) },
      updatedAt: at,
    };
    await dependencies.attempts.save(held);
    await dependencies.outbox.markPublished(message.messageId, at);
    await auditDelivery(dependencies, held, 'suppressed', at, 'grouped');
    return { code: 'suppressed', attempt: held };
  }
  const settleGroup = (result: 'delivered' | 'failed' | 'uncertain') =>
    dependencies.attempts.settleGroupDispatchSlot(
      message.tenantId,
      groupKey,
      message.idempotencyKey,
      groupFence,
      dependencies.clock.now(),
      quietPeriodMs,
      GROUP_DISPATCH_LEASE_MS,
      result,
    );

  const sending: NotificationAttempt = {
    ...base,
    status: 'sending',
    attemptCount: base.attemptCount + 1,
    groupKey,
    context: { ...context, notice },
    updatedAt: at,
  };
  await dependencies.attempts.save(sending);

  // Un directorio caído no bloquea el aviso: sale sin menciones antes que no salir.
  let allRecipients: readonly NotificationRecipient[] = [];
  try {
    allRecipients = dependencies.recipients
      ? await dependencies.recipients.recipientsFor(message.tenantId, roles)
      : [];
  } catch {
    allRecipients = [];
  }
  const mentions = allRecipients.slice(0, MAXIMUM_MENTIONS);
  const firstAttempt = sending.attemptCount === 1;
  // Dispositivos: una vez por mensaje (primer intento), en paralelo con Teams. Se espera antes
  // de terminar la pasada (el apagado ordenado lo incluye) y nunca cambia el resultado.
  const devicesNotified =
    dependencies.devices && firstAttempt
      ? dependencies.devices
          .notify(
            message.tenantId,
            allRecipients.flatMap((recipient) =>
              recipient.subjectKey ? [recipient.subjectKey] : [],
            ),
          )
          .catch(() => 0)
      : Promise.resolve(0);
  const content: AlertNotificationInput = {
    context,
    links: linksFor(dependencies.consoleBaseUrl, context, sending.id),
    timeZone: policy.timeZone,
    occurrences: notice.occurrences,
    firstSeen: notice.firstSeen,
    lastSeen: notice.lastSeen,
    reminder: notice.reminder,
    late: notice.late,
    mentions,
    attemptId: sending.id,
  };
  const payload = buildAlertCard({
    ...content,
    clientRequestId: sending.clientRequestId,
    aggregateId: message.aggregateId,
  });
  // Copia por correo de lo crítico (P1 o incidente), una sola vez por mensaje.
  const critical = context.priority === 'P1' || message.aggregateType === 'incident';
  const mailed: Promise<DeliveryEvidence | undefined> =
    dependencies.mail && critical && firstAttempt && mentions.length > 0
      ? dependencies.mail
          .send({
            recipients: mentions,
            email: buildAlertEmail(content),
            clientRequestId: sending.clientRequestId,
          })
          .catch(() => undefined)
      : Promise.resolve(undefined);
  const [outcome, , mailEvidence] = await Promise.all([
    dependencies.transport.send(payload, sending.clientRequestId),
    devicesNotified,
    mailed,
  ]);
  const measuredOutcome =
    outcome.delivered && !outcome.responseAt
      ? { ...outcome, responseAt: dependencies.clock.now().toISOString() }
      : outcome;
  const delivery = [
    ...(sending.delivery ?? []),
    evidence('teams', at, measuredOutcome),
    ...(mailEvidence ? [mailEvidence] : []),
  ];

  if (outcome.delivered) {
    const acceptedAt = new Date(measuredOutcome.responseAt!);
    const completedAt = dependencies.clock.now();
    const sent: NotificationAttempt = {
      ...sending,
      status: 'sent',
      sentAt: acceptedAt,
      updatedAt: completedAt,
      lastFailureCode: null,
      lastFailureClass: null,
      delivery,
    };
    await dependencies.attempts.save(sent);
    await settleGroup('delivered');
    if (usesP2Slot) {
      await dependencies.attempts.settleP2ImmediateSlot(
        message.tenantId,
        message.idempotencyKey,
        at,
        'delivered',
      );
    }
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
    // A slow failure must not consume its own backoff while the request is in flight.
    const failedAt = dependencies.clock.now();
    const retrying: NotificationAttempt = {
      ...sending,
      status: failure.class === 'ambiguous' ? 'indeterminate' : 'pending',
      availableAt: new Date(failedAt.getTime() + nextDelayMs(sending.attemptCount)),
      lastFailureCode: failure.code,
      lastFailureClass: failure.class,
      updatedAt: failedAt,
      delivery,
    };
    await dependencies.attempts.save(retrying);
    await settleGroup(failure.class === 'ambiguous' ? 'uncertain' : 'failed');
    if (usesP2Slot) {
      await dependencies.attempts.settleP2ImmediateSlot(
        message.tenantId,
        message.idempotencyKey,
        failedAt,
        failure.class === 'ambiguous' ? 'uncertain' : 'failed',
      );
    }
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
    title: context.title,
    severity: context.priority ?? context.severity ?? 'critical',
    reason: failure.code,
    at,
    recipients: mentions,
    link: content.links.primary.url,
    email: buildAlertEmail(content),
  });
  const fallen: NotificationAttempt = {
    ...sending,
    status: 'fallback',
    channel: fallbackRef.channel,
    lastFailureCode: failure.code,
    lastFailureClass: failure.class,
    updatedAt: at,
    delivery: [...delivery, ...(fallbackRef.evidence ?? [])],
  };
  await dependencies.attempts.save(fallen);
  await settleGroup('delivered');
  if (usesP2Slot) {
    await dependencies.attempts.settleP2ImmediateSlot(
      message.tenantId,
      message.idempotencyKey,
      at,
      'delivered',
    );
  }
  await dependencies.outbox.markPublished(message.messageId, at);
  await auditDelivery(dependencies, fallen, 'fallback', at, failure.code);
  return { code: 'fallback_used', attempt: fallen, failure };
}

export async function drainOutbox(
  dependencies: DispatchDependencies,
  limit = 20,
  concurrency = 1,
): Promise<readonly DispatchResult[]> {
  const batchLimit = Math.min(Math.max(Math.floor(limit), 1), 5);
  const workerCount = Math.min(Math.max(Math.floor(concurrency), 1), batchLimit);
  const now = dependencies.clock.now();
  const messages = await dependencies.outbox.claimPending(batchLimit, now);
  const results: DispatchResult[] = [];
  let nextIndex = 0;
  let failure: { readonly error: unknown } | undefined;
  const worker = async () => {
    while (nextIndex < messages.length) {
      const index = nextIndex++;
      try {
        results[index] = await dispatchMessage(dependencies, messages[index]!);
      } catch (error) {
        // Finish every claimed message, even with one worker. Otherwise a single failure
        // abandons healthy notifications until their leases expire. Keep the error visible.
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  if (failure !== undefined) throw failure.error;
  return results;
}
