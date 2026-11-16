/**
 * Canales de aviso administrables (Teams, correo, push).
 *
 * - `GET  /api/notifications/channels`            estado sin secretos (`notifications.read`).
 * - `PUT  /api/notifications/channels/teams`      fija o reemplaza el webhook (`notifications.manage`).
 * - `POST /api/notifications/channels/:id/test`   envía una prueba rotulada y devuelve el resultado.
 * - `POST /api/notifications/channels/:id/enable|disable`.
 *
 * `PUT teams` y `enable|disable` aceptan `expectedRevision` (la `revision` del listado): si la
 * fila cambió entretanto responden `STATE_CONFLICT` sin escribir. Cada ítem trae `setup` y
 * `needsSetup` para la puesta en marcha.
 *
 * Las mutaciones exigen sesión, CSRF, la capability `notifications.manage` (solo
 * `qapaq.platform.admin`) y un inicio de sesión reciente (`STEP_UP_REQUIRED` si la sesión tiene más
 * de `RECENT_AUTH_MS`): el BFF no recibe `auth_time`, así que la edad de la sesión es la prueba
 * de reautenticación disponible. Todo cambio queda auditado sin el valor del secreto.
 */

import { Body, Controller, Get, Inject, Param, Post, Put, Req } from '@nestjs/common';

import { recordAudit } from '@qapaq/audit';
import { buildAlertCard, CHANNEL_IDS, linksFor, type ChannelId, type DeliveryEvidence } from '@qapaq/soar';
import { randomUUID } from 'node:crypto';

import { ApiError } from '../http/api-error.js';
import type { IncomingRequest } from '../http/http-contracts.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';
import { mutatingActor, readingActor } from './session-actor.js';
import { SECOPS_RUNTIME } from './tokens.js';

/** Edad máxima de la sesión para cambiar un canal o los ajustes del analista (salvo administración). */
export const RECENT_AUTH_MS = 30 * 60_000;

/** Rol que configura con su sesión vigente (decisión del dueño, 2026-11-15). */
export const PLATFORM_ADMIN_ROLE = 'qapaq.platform.admin';

/**
 * ¿Necesita esta sesión verificarse de nuevo? La administración de plataforma configura con su
 * sesión vigente; el resto de los roles con permiso, solo con un inicio de sesión de < 30 min.
 * La asignación de roles privilegiados conserva su propio step-up (separación de funciones).
 */
export function needsRecentAuth(
  actor: { readonly roles: readonly string[] },
  session: { readonly createdAt: Date },
  now: Date,
): boolean {
  if (actor.roles.includes(PLATFORM_ADMIN_ROLE)) return false;
  return now.getTime() - session.createdAt.getTime() > RECENT_AUTH_MS;
}
const TEST_TITLE = '[QAPAQ SOC] Prueba de notificación';

/**
 * `expectedRevision` es opcional (clientes anteriores no lo envían); si viene, debe ser un entero
 * no negativo y coincidir con la revisión guardada o la mutación responde `STATE_CONFLICT`.
 */
function expectedRevisionOf(body: unknown, correlationId: string): number | undefined {
  const value =
    body && typeof body === 'object' ? (body as Record<string, unknown>)['expectedRevision'] : undefined;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ApiError('VALIDATION_FAILED', correlationId, ['expectedRevision']);
  }
  return value;
}

function channelIdOf(value: string, correlationId: string): ChannelId {
  const id = CHANNEL_IDS.find((candidate) => candidate === value);
  if (!id) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
  return id;
}

@Controller('api/notifications/channels')
export class NotificationChannelsController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  private registry(correlationId: string) {
    const channels = this.runtime.channels;
    if (!channels) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    return channels;
  }

  private async manager(request: IncomingRequest) {
    const resolved = await mutatingActor(this.runtime, request);
    if (!resolved.actor.capabilities.has('notifications.manage')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', resolved.correlationId);
    }
    if (needsRecentAuth(resolved.actor, resolved.session, this.runtime.now())) {
      throw new ApiError('STEP_UP_REQUIRED', resolved.correlationId);
    }
    return resolved;
  }

  private async audit(
    actor: { readonly subjectId: string; readonly tenantId: string },
    correlationId: string,
    action: string,
    channelId: ChannelId,
    outcome: 'succeeded' | 'failed',
    metadata: Readonly<Record<string, string | number | boolean | null>>,
    reason?: string,
  ): Promise<void> {
    await recordAudit(this.runtime.audit, {
      id: randomUUID(),
      tenantId: actor.tenantId,
      occurredAt: this.runtime.now(),
      actor: { id: actor.subjectId, type: 'user' },
      action,
      resource: { type: 'notification_channel', id: channelId },
      outcome,
      correlationId,
      ...(reason ? { reason } : {}),
      metadata,
    });
  }

  @Get()
  public async list(@Req() request: IncomingRequest) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    if (!actor.capabilities.has('notifications.read')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const registry = this.registry(correlationId);
    await registry.refresh();
    return {
      correlationId,
      canManage: actor.capabilities.has('notifications.manage'),
      items: registry.views(),
    };
  }

  @Put('teams')
  public async setTeams(@Req() request: IncomingRequest, @Body() body: unknown) {
    const { actor, correlationId } = await this.manager(request);
    const registry = this.registry(correlationId);
    const raw =
      body && typeof body === 'object' ? (body as Record<string, unknown>)['webhookUrl'] : undefined;
    const expectedRevision = expectedRevisionOf(body, correlationId);
    const result = await registry.setTeamsUrl(raw, actor.subjectId, expectedRevision);
    if (!result.ok) {
      await this.audit(actor, correlationId, 'notifications.channel.webhook_rejected', 'teams', 'failed', { code: result.code }, result.code);
      if (result.code === 'ENCRYPTION_KEY_MISSING') throw new ApiError('DEPENDENCY_DEGRADED', correlationId);
      if (result.code === 'REVISION_CONFLICT') throw new ApiError('STATE_CONFLICT', correlationId);
      throw new ApiError('VALIDATION_FAILED', correlationId, [`webhookUrl:${result.code}`]);
    }
    await this.audit(actor, correlationId, 'notifications.channel.webhook_updated', 'teams', 'succeeded', {
      previous: result.previous,
      current: result.view.destination,
    });
    return { correlationId, channel: result.view };
  }

  @Post(':id/enable')
  public enable(@Req() request: IncomingRequest, @Param('id') id: string, @Body() body?: unknown) {
    return this.toggle(request, id, true, body);
  }

  @Post(':id/disable')
  public disable(@Req() request: IncomingRequest, @Param('id') id: string, @Body() body?: unknown) {
    return this.toggle(request, id, false, body);
  }

  private async toggle(request: IncomingRequest, id: string, enabled: boolean, body: unknown) {
    const { actor, correlationId } = await this.manager(request);
    const channelId = channelIdOf(id, correlationId);
    const expectedRevision = expectedRevisionOf(body, correlationId);
    const change = await this.registry(correlationId).setEnabled(
      channelId,
      enabled,
      actor.subjectId,
      expectedRevision,
    );
    if (!change.ok) {
      await this.audit(
        actor,
        correlationId,
        `notifications.channel.${enabled ? 'enable' : 'disable'}_rejected`,
        channelId,
        'failed',
        { code: change.code },
        change.code,
      );
      throw new ApiError('STATE_CONFLICT', correlationId);
    }
    const view = change.view;
    await this.audit(
      actor,
      correlationId,
      `notifications.channel.${enabled ? 'enabled' : 'disabled'}`,
      channelId,
      'succeeded',
      { enabled },
    );
    return { correlationId, channel: view };
  }

  @Post(':id/test')
  public async test(@Req() request: IncomingRequest, @Param('id') id: string) {
    const { actor, correlationId, session } = await this.manager(request);
    const channelId = channelIdOf(id, correlationId);
    const registry = this.registry(correlationId);
    const at = this.runtime.now();
    const expectedRevision = registry.view(channelId).revision;
    let evidence: DeliveryEvidence;
    if (channelId === 'teams') {
      const attemptId = randomUUID();
      const card = buildAlertCard({
        context: {
          kind: 'alert',
          alertId: null,
          incidentId: null,
          title: TEST_TITLE,
          priority: 'P4',
          severity: null,
          source: { id: 'qapaq', vendor: 'QAPAQ SOC (prueba manual)' },
          entity: null,
          ruleId: null,
          summary: 'Mensaje de verificación del canal de avisos. No requiere acción: si lo ves en el canal, la entrega a Microsoft Teams funciona.',
          whyItMatters: null,
          mitre: [],
          correlation: null,
          score: null,
          reasons: [],
          relatedAlertCount: 0,
          occurredAt: at.toISOString(),
          nextStep: 'Confirma en la consola (Notificaciones → canales) que la prueba figura como aceptada.',
          runbook: null,
          test: true,
        },
        links: linksFor(this.runtime.consoleBaseUrl, { kind: 'alert', alertId: null, incidentId: null }, null),
        timeZone: 'America/Lima',
        occurrences: 1,
        firstSeen: at.toISOString(),
        lastSeen: at.toISOString(),
        reminder: false,
        late: false,
        attemptId,
        clientRequestId: attemptId,
        aggregateId: attemptId,
      });
      const outcome = await registry.teamsTransport.send(card, attemptId);
      evidence = {
        channel: 'teams',
        outcome: outcome.delivered ? 'accepted' : 'failed',
        at: at.toISOString(),
        httpStatus: outcome.httpStatus ?? null,
        providerMessageId: outcome.providerMessageId ?? null,
        providerLink: null,
        reason: outcome.delivered ? null : (outcome.failure?.code ?? 'UNKNOWN'),
      };
    } else if (channelId === 'email') {
      const mail = this.runtime.mailChannel;
      if (!mail) throw new ApiError('STATE_CONFLICT', correlationId);
      const email = session.email ?? null;
      if (!email) throw new ApiError('VALIDATION_FAILED', correlationId, ['email']);
      evidence = await mail.send({
        recipients: [{ upn: email, displayName: session.displayName ?? email }],
        email: {
          subject: TEST_TITLE,
          html: `<p><strong>${TEST_TITLE}</strong></p><p>Mensaje de verificación del canal de correo del SOC. No requiere acción.</p>`,
          text: `${TEST_TITLE}\n\nMensaje de verificación del canal de correo del SOC. No requiere acción.`,
        },
        clientRequestId: randomUUID(),
      });
    } else {
      const delivered = await this.runtime.testPush(actor.tenantId, session.oid ?? actor.subjectId);
      evidence = {
        channel: 'push',
        outcome: delivered > 0 ? 'accepted' : 'failed',
        at: at.toISOString(),
        httpStatus: null,
        providerMessageId: null,
        providerLink: null,
        reason: delivered > 0 ? null : 'NO_DEVICES',
      };
    }
    await registry.recordOutcome(channelId, evidence, true, expectedRevision);
    await this.audit(
      actor,
      correlationId,
      'notifications.channel.tested',
      channelId,
      evidence.outcome === 'accepted' ? 'succeeded' : 'failed',
      {
        httpStatus: evidence.httpStatus,
        providerMessageId: evidence.providerMessageId,
      },
      evidence.reason ?? undefined,
    );
    return { correlationId, result: evidence, channel: registry.view(channelId) };
  }
}
