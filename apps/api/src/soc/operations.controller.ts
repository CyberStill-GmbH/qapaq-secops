/**
 * Operaciones de C-16 y C-20 expuestas al recorrido vertical.
 *
 * `POST /api/ingest/security-events` es el punto por el que entra un SecurityEvent ya
 * normalizado. En producción quien lo alimenta es el worker de C-11/C-12 leyendo Wazuh;
 * aquí existe además como entrada controlada para el E2E, y por eso está limitada al
 * modo de identidad local. No sustituye la aceptación con Wazuh real, que sigue siendo
 * gate del MVP.
 */

import { randomUUID } from 'node:crypto';

import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { IncomingRequest } from '../http/http-contracts.js';

import { recordAudit } from '@qapaq/audit';
import { validateSecurityEvent } from '@qapaq/contracts';
import {
  AWAITING_ACKNOWLEDGEMENT,
  contextOf,
  deliveryLabel,
  drainOutbox,
  linksFor,
  supersede,
  type NotificationAttempt,
} from '@qapaq/soar';

import { ApiError } from '../http/api-error.js';
import {
  HEALTH_THRESHOLDS,
  correlatorHealth,
  platformSection,
  socSection,
  summarySection,
  worstStatus,
  type HealthStatus,
} from './operations-health.js';
import { paginate, type PageQuery } from '../http/pagination.js';
import { correlationIdOf } from '../http/request-context.js';
import { correlatorGet } from '../runtime/correlator-link.js';
import { mutatingActor, readingActor } from './session-actor.js';
import { SECOPS_RUNTIME } from './tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';
import { evaluateMonitor } from '../runtime/source-health.js';

/** Mensajes por pasada manual del despacho. */
const MANUAL_DRAIN_BATCH = 1;
const CORRELATOR_HEALTH_TIMEOUT_MS = 750;
/** Tope de la bandeja de notificaciones que se pagina en el BFF. */
const NOTIFICATION_LIST_LIMIT = 2_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Estado de entrega para la consola: «sent» = M365 aceptó (2xx); «delivered» solo si el
 * proveedor lo confirmara (hoy ningún canal lo hace: Workflows y Graph responden 202);
 * «acknowledged» = acuse humano en QAPAQ.
 */
function deliveryState(attempt: NotificationAttempt): string {
  switch (attempt.status) {
    case 'acknowledged':
      return 'acknowledged';
    case 'sent':
    case 'fallback':
      return 'sent';
    case 'failed':
      return 'failed';
    case 'indeterminate':
      return 'indeterminate';
    case 'suppressed':
      return 'suppressed';
    case 'superseded':
      return 'superseded';
    default:
      return 'pending';
  }
}

/** Vista de un aviso para la consola: qué alerta, por qué, cómo se entregó y adónde ir. */
export function notificationView(attempt: NotificationAttempt, consoleBaseUrl: string) {
  const context = contextOf(attempt);
  const notice = (attempt.context?.['notice'] ?? null) as Record<string, unknown> | null;
  const links = context ? linksFor(consoleBaseUrl, context, attempt.id) : null;
  const isDigest = (attempt.groupKey ?? '').startsWith('digest:');
  const investigation = context?.alertId && links ? links.primary.url : null;
  const incident = context?.incidentId && links ? (links.incident ?? links.primary.url) : null;
  return {
    id: attempt.id,
    status: attempt.status,
    statusLabel: deliveryLabel(attempt),
    deliveryState: deliveryState(attempt),
    channel: attempt.channel,
    attemptCount: attempt.attemptCount,
    createdAt: attempt.createdAt.toISOString(),
    sentAt: attempt.sentAt?.toISOString() ?? null,
    acknowledgedAt: attempt.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: attempt.acknowledgedBy,
    lastFailureClass: attempt.lastFailureClass,
    lastFailureCode: attempt.lastFailureCode,
    kind: isDigest ? 'digest' : (context?.kind ?? null),
    alertId: context?.alertId ?? null,
    incidentId: context?.incidentId ?? null,
    title: context?.title ?? null,
    priority: context?.priority ?? null,
    severity: context?.severity ?? null,
    source: context?.source?.vendor ?? null,
    sourceId: context?.source?.id ?? null,
    entity: context?.entity ?? null,
    ruleId: context?.ruleId ?? null,
    correlationCandidateId: context?.correlation?.candidateId ?? null,
    correlationPatternId: context?.correlation?.patternId ?? null,
    summary: context?.summary ?? null,
    whyItMatters: context?.whyItMatters ?? null,
    nextStep: context?.nextStep ?? null,
    occurredAt: context?.occurredAt ?? null,
    test: context?.test ?? false,
    occurrences: typeof notice?.['occurrences'] === 'number' ? notice['occurrences'] : 1,
    suppressionReason: attempt.suppressionReason ?? null,
    coveredBy: attempt.supersededBy ?? null,
    digestId: attempt.digestId ?? null,
    deepLink: investigation ?? incident,
    links: links ? { investigation, incident, playbook: links.playbook, qapaqzito: links.qapaqzito } : null,
    delivery: attempt.delivery ?? [],
  };
}

@Controller('api')
export class OperationsController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  @Post('ingest/security-events')
  public async ingest(@Req() request: IncomingRequest, @Body() body: unknown) {
    const correlationId = correlationIdOf(request);
    if (!this.runtime.isLocalIdentity) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    const validation = validateSecurityEvent(body);
    if (!validation.valid) {
      throw new ApiError(
        'VALIDATION_FAILED',
        correlationId,
        validation.errors.map((error) => error.path),
      );
    }
    const result = await this.runtime.promoteEvent(validation.value);
    const outcome =
      result === 'below_threshold' || result === 'suppressed' ? 'not_promoted' : result;
    return {
      correlationId,
      outcome,
      ...(result === 'below_threshold'
        ? { reason: 'BELOW_THRESHOLD' }
        : result === 'suppressed'
          ? { reason: 'SUPPRESSED' }
          : {}),
    };
  }

  /**
   * Pasada manual del despacho. El despacho normal lo hace el bucle del runtime; esto queda
   * para operación y pruebas, y por ser un efecto externo exige `notifications.dispatch`.
   */
  @Post('notifications/drain')
  public async drain(@Req() request: IncomingRequest) {
    const { actor, correlationId } = await mutatingActor(this.runtime, request);
    if (!actor.capabilities.has('notifications.dispatch')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    // Un solo mensaje por pasada manual: con el timeout del transporte (10 s) la respuesta
    // cabe en el timeout del gateway. El resto lo despacha el bucle automático.
    const urgent = await drainOutbox(
      this.runtime.dispatchDependencies('urgent'),
      MANUAL_DRAIN_BATCH,
    );
    const results =
      urgent.length > 0
        ? urgent
        : await drainOutbox(this.runtime.dispatchDependencies('normal'), MANUAL_DRAIN_BATCH);
    this.runtime.dispatcher.kick();
    return { correlationId, results: results.map((result) => result.code) };
  }

  @Get('notifications')
  public async notifications(@Req() request: IncomingRequest, @Query() query: PageQuery) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    if (!actor.capabilities.has('notifications.read')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const page = paginate(
      await this.runtime.notifications.listByTenant(actor.tenantId, NOTIFICATION_LIST_LIMIT),
      (attempt) => ({ at: attempt.createdAt.getTime(), id: attempt.id }),
      query,
      'notifications',
      correlationId,
    );
    return {
      correlationId,
      nextCursor: page.nextCursor,
      items: page.items.map((attempt) => notificationView(attempt, this.runtime.consoleBaseUrl)),
    };
  }

  /**
   * Marca como sustituidos los avisos entregados y sin acuse anteriores a `olderThanHours`
   * (p. ej. la ráfaga tras una caída, ya cubierta por un resumen). No borra nada: el aviso, su
   * evidencia y la auditoría se conservan. Exige `notifications.dispatch` y CSRF.
   */
  @Post('notifications/supersede-stale')
  public async supersedeStale(@Req() request: IncomingRequest, @Body() body: unknown) {
    const { actor, correlationId } = await mutatingActor(this.runtime, request);
    if (!actor.capabilities.has('notifications.dispatch')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const hours = input['olderThanHours'];
    const reason = input['reason'];
    if (
      typeof hours !== 'number' ||
      !Number.isInteger(hours) ||
      hours < 1 ||
      hours > 24 * 90 ||
      typeof reason !== 'string' ||
      reason.trim().length < 5 ||
      reason.length > 300
    ) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['olderThanHours', 'reason']);
    }
    const at = this.runtime.now();
    const cutoff = at.getTime() - hours * 3_600_000;
    const candidates = (
      await this.runtime.notifications.listByTenant(actor.tenantId, NOTIFICATION_LIST_LIMIT)
    ).filter(
      (attempt) =>
        AWAITING_ACKNOWLEDGEMENT.includes(attempt.status) && attempt.createdAt.getTime() < cutoff,
    );
    let superseded = 0;
    for (const attempt of candidates) {
      const result = supersede(attempt, null, at);
      if (!result.ok) continue;
      await this.runtime.notifications.save(result.attempt);
      await recordAudit(this.runtime.audit, {
        id: randomUUID(),
        tenantId: actor.tenantId,
        occurredAt: at,
        actor: { id: actor.subjectId, type: 'user' },
        action: 'soar.notification.superseded',
        resource: { type: 'notification', id: attempt.id },
        outcome: 'succeeded',
        correlationId,
        reason: reason.trim(),
        metadata: { previousStatus: attempt.status },
      });
      superseded += 1;
    }
    return { correlationId, superseded };
  }

  @Get('notifications/:id')
  public async notification(@Req() request: IncomingRequest, @Param('id') id: string) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    if (!actor.capabilities.has('notifications.read') || !UUID.test(id)) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const attempt = await this.runtime.notifications.byId(actor.tenantId, id);
    if (!attempt) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    return { correlationId, item: notificationView(attempt, this.runtime.consoleBaseUrl) };
  }

  /**
   * Salud operativa por secciones según capability (ver `operations-health.ts`). Solo
   * lectura, agregada y sin datos personales.
   */
  @Get('operations/health')
  public async operationsHealth(@Req() request: IncomingRequest) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    if (!actor.capabilities.has('alerts.read')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const at = this.runtime.now();
    const monitor = this.runtime.sourceHealth;
    let sourceStatus: HealthStatus | undefined;
    if (actor.capabilities.has('sources.health.read') && monitor?.key.tenantId === actor.tenantId) {
      const source = await evaluateMonitor(monitor, this.runtime.soc.ingestion, at);
      sourceStatus =
        source.state === 'healthy'
          ? 'OK'
          : source.state === 'degraded' || source.state === 'failed'
            ? 'DEGRADED'
            : 'NO_DATA';
    }
    const summary = summarySection(
      {
        lastAlertAt: await this.runtime.soc.lastAlertAt(actor.tenantId),
        ...(sourceStatus ? { sourceStatus } : {}),
      },
      at,
    );
    const sections: Record<string, { readonly status: HealthStatus }> = { summary };

    if (actor.capabilities.has('observability.read_soc')) {
      // Ventana fija agregada en el store: conteos estables, no "las últimas N filas".
      const notificationsByStatus = await this.runtime.notifications.countByStatusSince(
        actor.tenantId,
        new Date(at.getTime() - HEALTH_THRESHOLDS.notificationWindowHours * 3_600_000),
      );
      const notificationWindowStart = new Date(
        at.getTime() - HEALTH_THRESHOLDS.notificationWindowHours * 3_600_000,
      );
      const providerAcceptanceLatency =
        await this.runtime.notifications.providerAcceptanceLatencySince(
          actor.tenantId,
          notificationWindowStart,
          at,
        );
      // The Wazuh inbox is deployment-scoped and has no tenant_id column. Never expose its
      // aggregate to a principal whose tenant does not own the configured Wazuh source.
      const wazuhPushInbox =
        monitor?.key.tenantId === actor.tenantId
          ? await this.runtime.wazuhPushInboxMetrics(at)
          : null;
      let correlator = correlatorHealth(undefined);
      if (this.runtime.correlatorRead && actor.tenantId === this.runtime.tenantId) {
        try {
          correlator = correlatorHealth(
            await correlatorGet(
              this.runtime.correlatorRead,
              '/readyz',
              CORRELATOR_HEALTH_TIMEOUT_MS,
            ),
          );
        } catch {
          // Una dependencia auxiliar nunca debe romper la respuesta agregada de operaciones.
          correlator = correlatorHealth(null);
        }
      }
      sections['soc'] = socSection(
        {
          persistence: this.runtime.soc.kind,
          dispatcherRunning: this.runtime.dispatcher.started,
          outbox: await this.runtime.soc.outboxHealth(actor.tenantId, at),
          notificationsByStatus,
          providerAcceptanceLatency,
          wazuhPushInbox,
          correlator,
          ...(this.runtime.channels
            ? {
                notificationChannels: this.runtime.channels.views().map((view) => ({
                  id: view.id,
                  enabled: view.enabled,
                  configured: view.configured,
                  setup: view.setup,
                })),
              }
            : {}),
        },
        at,
      );
    }

    if (actor.capabilities.has('observability.read_platform')) {
      const started = performance.now();
      let databaseLatencyMs: number | null = null;
      try {
        await this.runtime.soc.ready();
        databaseLatencyMs = Math.round(performance.now() - started);
      } catch {
        // El detalle del error no se expone: puede citar parámetros de conexión.
        databaseLatencyMs = null;
      }
      sections['platform'] = platformSection(
        { processMetrics: this.runtime.processInfo(), databaseLatencyMs },
        at,
      );
    }

    return {
      correlationId,
      generatedAt: at.toISOString(),
      status: worstStatus(Object.values(sections).map((section) => section.status)),
      sections,
    };
  }

  @Post('notifications/:id/acknowledge')
  public async acknowledgeNotification(@Req() request: IncomingRequest, @Param('id') id: string) {
    const { actor, correlationId } = await mutatingActor(this.runtime, request);
    if (!actor.capabilities.has('notifications.read') || !UUID.test(id)) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const at = this.runtime.now();
    const acknowledged = await this.runtime.notifications.acknowledgeWithAudit(
      actor.tenantId,
      id,
      actor.subjectId,
      at,
      (previousStatus) => ({
        id: randomUUID(),
        tenantId: actor.tenantId,
        occurredAt: at,
        actor: { id: actor.subjectId, type: 'user' },
        action: 'soar.notification.acknowledged',
        resource: { type: 'notification', id },
        outcome: 'succeeded',
        correlationId,
        metadata: { previousStatus },
      }),
      this.runtime.soc.audit,
    );
    if (!acknowledged) {
      if (!(await this.runtime.notifications.byId(actor.tenantId, id))) {
        throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
      }
      throw new ApiError('STATE_CONFLICT', correlationId);
    }
    return {
      correlationId,
      status: acknowledged.status,
      acknowledgedAt: acknowledged.acknowledgedAt?.toISOString() ?? at.toISOString(),
      acknowledgedBy: acknowledged.acknowledgedBy,
    };
  }
}
