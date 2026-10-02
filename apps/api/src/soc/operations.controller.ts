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
import { paginate, type PageQuery } from '../http/pagination.js';
import { correlationIdOf } from '../http/request-context.js';
import { mutatingActor, readingActor } from './session-actor.js';
import { SECOPS_RUNTIME } from './tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';

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

  @Post('notifications/drain')
  public async drain(@Req() request: IncomingRequest) {
    const { actor, correlationId } = await mutatingActor(this.runtime, request);
    if (!actor.capabilities.has('notifications.read')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    this.runtime.pumpOutbox();
    const results = await drainOutbox(this.runtime.dispatchDependencies());
    return { correlationId, results: results.map((result) => result.code) };
  }

  @Get('notifications')
  public async notifications(@Req() request: IncomingRequest, @Query() query: PageQuery) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    if (!actor.capabilities.has('notifications.read')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const page = paginate(
      [...this.runtime.notifications.rows.values()].filter(
        (attempt) => attempt.tenantId === actor.tenantId,
      ),
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
