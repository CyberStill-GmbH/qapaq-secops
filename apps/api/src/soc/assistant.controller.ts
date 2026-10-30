/**
 * Asistente Claude (Qapaqzito) sobre HTTP.
 *
 * - `GET /api/assistant/status`: si el asistente está configurado y con qué modelo, para que la
 *   consola muestre «sin configuración» antes de que la persona escriba.
 * - `POST /api/assistant/messages`: un turno de conversación. Es mutación a efectos de B-01
 *   (envía datos a un tercero), así que exige el token CSRF de la sesión.
 *
 * Ambos exigen `assistant.use`; sin ella responden igual que un recurso inexistente. Cada turno,
 * aceptado o rechazado, queda en la auditoría con actor, correlación, herramientas y tokens; ni el
 * texto de la conversación ni las entidades entran a la auditoría.
 */

import { randomUUID } from 'node:crypto';

import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import { recordAudit } from '@qapaq/audit';
import type { Actor } from '@qapaq/access';

import { ApiError } from '../http/api-error.js';
import type { IncomingRequest } from '../http/http-contracts.js';
import { ASSISTANT_LIMITS, ASSISTANT_NAME, AssistantError } from '../runtime/assistant.js';
import { mutatingActor, readingActor } from './session-actor.js';
import { SECOPS_RUNTIME } from './tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';

@Controller('api/assistant')
export class AssistantController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  @Get('status')
  public async status(@Req() request: IncomingRequest) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    if (!actor.capabilities.has('assistant.use')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const assistant = this.runtime.assistant;
    return {
      correlationId,
      name: ASSISTANT_NAME,
      configured: assistant.configured,
      model: assistant.configured ? assistant.model : null,
      limits: {
        messageMaxLength: ASSISTANT_LIMITS.messageMaxLength,
        maxTurns: ASSISTANT_LIMITS.maxTurns,
      },
    };
  }

  @Post('messages')
  public async message(
    @Req() request: IncomingRequest,
    @Body()
    body: {
      conversationId?: unknown;
      message?: unknown;
      context?: { alertId?: unknown; incidentId?: unknown } | null;
    } | null,
  ) {
    const { actor, session, correlationId } = await mutatingActor(this.runtime, request);
    if (!actor.capabilities.has('assistant.use')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const input = body ?? {};
    if (
      typeof input.message !== 'string' ||
      (input.conversationId !== undefined && typeof input.conversationId !== 'string') ||
      (input.context !== undefined &&
        input.context !== null &&
        (typeof input.context !== 'object' || Array.isArray(input.context)))
    ) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['message']);
    }
    const context = input.context ?? undefined;
    try {
      const reply = await this.runtime.assistant.converse({
        actor,
        displayName: session.displayName ?? null,
        email: session.email ?? null,
        message: input.message,
        ...(typeof input.conversationId === 'string'
          ? { conversationId: input.conversationId }
          : {}),
        ...(context
          ? {
              context: {
                ...(context.alertId === undefined ? {} : { alertId: context.alertId as string }),
                ...(context.incidentId === undefined
                  ? {}
                  : { incidentId: context.incidentId as string }),
              },
            }
          : {}),
      });
      await this.audit(actor, correlationId, reply.conversationId, 'succeeded', undefined, {
        model: reply.model,
        tools: [...reply.toolsUsed],
        toolCalls: reply.toolCalls,
        modelCalls: reply.modelCalls,
        stopReason: reply.stopReason,
        inputTokens: reply.usage.inputTokens,
        outputTokens: reply.usage.outputTokens,
        cacheTokens: reply.usage.cacheReadTokens,
        truncated: reply.truncated,
        declined: reply.declined,
      });
      return {
        correlationId,
        conversationId: reply.conversationId,
        reply: { text: reply.text, truncated: reply.truncated, declined: reply.declined },
        model: reply.model,
        toolsUsed: reply.toolsUsed,
        usage: { inputTokens: reply.usage.inputTokens, outputTokens: reply.usage.outputTokens },
      };
    } catch (error) {
      if (!(error instanceof AssistantError)) throw error;
      const denied = error.code !== 'DEPENDENCY_DEGRADED';
      await this.audit(
        actor,
        correlationId,
        typeof input.conversationId === 'string' ? input.conversationId : 'new',
        denied ? 'denied' : 'failed',
        error.reason,
      );
      if (!denied) this.runtime.reportAssistantError(error.reason);
      throw new ApiError(error.code, correlationId, error.fields);
    }
  }

  private async audit(
    actor: Actor,
    correlationId: string,
    conversationId: string,
    outcome: 'succeeded' | 'denied' | 'failed',
    reason?: string,
    metadata: Record<string, string | number | boolean | string[]> = {},
  ) {
    await recordAudit(this.runtime.audit, {
      id: randomUUID(),
      tenantId: actor.tenantId,
      occurredAt: this.runtime.now(),
      actor: { id: actor.subjectId, type: 'user', sessionId: actor.sessionId },
      action: 'assistant.message',
      // Un id de conversación ajeno o inventado no se refleja: solo su forma, si la tiene.
      resource: {
        type: 'assistant_conversation',
        id: /^[0-9a-f-]{36}$/iu.test(conversationId) ? conversationId : 'new',
      },
      outcome,
      correlationId,
      ...(reason ? { reason } : {}),
      metadata,
    });
  }
}
