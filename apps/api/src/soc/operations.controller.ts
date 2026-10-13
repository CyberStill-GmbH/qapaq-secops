/**
 * Operaciones de C-16 y C-20 expuestas al recorrido vertical.
 *
 * `POST /api/ingest/security-events` es el punto por el que entra un SecurityEvent ya
 * normalizado. En producción quien lo alimenta es el worker de C-11/C-12 leyendo Wazuh;
 * aquí existe además como entrada controlada para el E2E, y por eso está limitada al
 * modo de identidad local. No sustituye la aceptación con Wazuh real, que sigue siendo
 * gate del MVP.
 */

import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { IncomingRequest } from '../http/http-contracts.js';

import { validateSecurityEvent } from '@qapaq/contracts';
import { acknowledge, drainOutbox } from '@qapaq/soar';

import { ApiError } from '../http/api-error.js';
import {
  HEALTH_THRESHOLDS,
  platformSection,
  socSection,
  summarySection,
  worstStatus,
  type HealthStatus,
} from './operations-health.js';
import { paginate, type PageQuery } from '../http/pagination.js';
import { correlationIdOf } from '../http/request-context.js';
import { mutatingActor, readingActor } from './session-actor.js';
import { SECOPS_RUNTIME } from './tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';

/** Mensajes por pasada manual del despacho. */
const MANUAL_DRAIN_BATCH = 1;
/** Tope de la bandeja de notificaciones que se pagina en el BFF. */
const NOTIFICATION_LIST_LIMIT = 2_000;

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
    const outcome = await this.runtime.promoteEvent(validation.value);
    return { correlationId, outcome };
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
    const results = await drainOutbox(this.runtime.dispatchDependencies(), MANUAL_DRAIN_BATCH);
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
      items: page.items.map((attempt) => ({
        id: attempt.id,
        status: attempt.status,
        channel: attempt.channel,
        attemptCount: attempt.attemptCount,
        sentAt: attempt.sentAt?.toISOString() ?? null,
        acknowledgedAt: attempt.acknowledgedAt?.toISOString() ?? null,
        acknowledgedBy: attempt.acknowledgedBy,
        lastFailureClass: attempt.lastFailureClass,
      })),
    };
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
    const summary = summarySection(
      { lastAlertAt: await this.runtime.soc.lastAlertAt(actor.tenantId) },
      at,
    );
    const sections: Record<string, { readonly status: HealthStatus }> = { summary };

    if (actor.capabilities.has('observability.read_soc')) {
      // Ventana fija agregada en el store: conteos estables, no "las últimas N filas".
      const notificationsByStatus = await this.runtime.notifications.countByStatusSince(
        actor.tenantId,
        new Date(at.getTime() - HEALTH_THRESHOLDS.notificationWindowHours * 3_600_000),
      );
      sections['soc'] = socSection(
        {
          persistence: this.runtime.soc.kind,
          dispatcherRunning: this.runtime.dispatcher.started,
          outbox: await this.runtime.soc.outboxHealth(actor.tenantId),
          notificationsByStatus,
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
    if (!actor.capabilities.has('notifications.read')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const attempt = await this.runtime.notifications.byId(actor.tenantId, id);
    if (!attempt) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    const result = acknowledge(attempt, actor.subjectId, this.runtime.now());
    if (!result.ok) throw new ApiError('STATE_CONFLICT', correlationId);
    await this.runtime.notifications.save(result.attempt);
    return { correlationId, status: result.attempt.status };
  }
}
