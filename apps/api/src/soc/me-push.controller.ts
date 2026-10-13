/**
 * Sprint 5 — avisos al dispositivo: autoservicio de cada persona (`/api/me/push`).
 *
 * Lo usa «Configuración → Notificaciones» de la consola. El permiso del navegador se pide solo
 * cuando la persona pulsa «Activar en este dispositivo» (nunca al cargar la página); con la
 * suscripción resultante, la consola llama a `POST /subscriptions`.
 *
 * - `GET  /config`: `{ enabled, vapidPublicKey }` para `PushManager.subscribe`.
 * - `GET  /subscriptions`: mis dispositivos (sin claves ni endpoint completo).
 * - `POST /subscriptions`: registra o reactiva un dispositivo (CSRF).
 * - `POST /subscriptions/:id/revoke`: lo quita (CSRF); solo los propios.
 * - `POST /test`: aviso de prueba a mis dispositivos (CSRF).
 * - `GET  /pending`: lo que el service worker muestra al despertar: alertas P1 abiertas e
 *   incidentes críticos recientes que esta sesión puede ver, con enlace. Sin datos del evento.
 *
 * Exige `notifications.read` (analista, lead, admin). Todo queda ligado a la persona de la
 * sesión: nadie registra ni quita dispositivos de otro.
 */

import { randomUUID } from 'node:crypto';

import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { notifyDevices, PUSH_LIMITS, validatePushSubscription } from '@qapaq/soar';

import { ApiError } from '../http/api-error.js';
import type { IncomingRequest } from '../http/http-contracts.js';
import { mutatingActor, readingActor } from './session-actor.js';
import { SECOPS_RUNTIME } from './tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';

/** Ventana de «pendientes» que el service worker muestra al despertar. */
const PENDING_WINDOW_MS = 30 * 60_000;
const PENDING_LIMIT = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

@Controller('api/me/push')
export class MePushController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  /** La clave de la persona para sus dispositivos: OID si la sesión lo trae; si no, `sub`. */
  private subjectKey(session: { readonly oid?: string; readonly subjectId: string }): string {
    return (session.oid ?? session.subjectId).toLowerCase();
  }

  private requireCapability(actor: { capabilities: ReadonlySet<string> }, correlationId: string) {
    if (!actor.capabilities.has('notifications.read')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
  }

  @Get('config')
  public async config(@Req() request: IncomingRequest) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    this.requireCapability(actor, correlationId);
    const push = this.runtime.push;
    return {
      correlationId,
      enabled: Boolean(push),
      vapidPublicKey: push?.sender.publicKey ?? null,
      maximumDevices: PUSH_LIMITS.maximumPerSubject,
    };
  }

  @Get('subscriptions')
  public async list(@Req() request: IncomingRequest) {
    const { actor, session, correlationId } = await readingActor(this.runtime, request);
    this.requireCapability(actor, correlationId);
    const push = this.runtime.push;
    const rows = push
      ? await push.store.activeForSubject(actor.tenantId, this.subjectKey(session))
      : [];
    return {
      correlationId,
      items: rows.map((row) => ({
        id: row.id,
        label: row.label,
        service: new URL(row.endpoint).hostname,
        createdAt: row.createdAt.toISOString(),
        lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      })),
    };
  }

  @Post('subscriptions')
  public async subscribe(
    @Req() request: IncomingRequest,
    @Body()
    body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; label?: unknown },
  ) {
    const { actor, session, correlationId } = await mutatingActor(this.runtime, request);
    this.requireCapability(actor, correlationId);
    const push = this.runtime.push;
    if (!push) throw new ApiError('DEPENDENCY_DEGRADED', correlationId);
    const validation = validatePushSubscription({
      endpoint: body.endpoint,
      p256dh: body.keys?.p256dh,
      auth: body.keys?.auth,
      label: body.label,
    });
    if (!validation.ok) throw new ApiError('VALIDATION_FAILED', correlationId, [validation.field]);
    const subjectKey = this.subjectKey(session);
    const existing = await push.store.activeForSubject(actor.tenantId, subjectKey);
    if (
      existing.length >= PUSH_LIMITS.maximumPerSubject &&
      !existing.some((row) => row.endpoint === body.endpoint)
    ) {
      throw new ApiError('STATE_CONFLICT', correlationId);
    }
    const stored = await push.store.upsert({
      id: randomUUID(),
      tenantId: actor.tenantId,
      subjectKey,
      endpoint: body.endpoint as string,
      p256dh: body.keys!.p256dh as string,
      auth: body.keys!.auth as string,
      label: (body.label as string).trim(),
      createdAt: this.runtime.now(),
      lastSuccessAt: null,
      revokedAt: null,
      revocationReason: null,
    });
    return { correlationId, subscription: { id: stored.id, label: stored.label } };
  }

  @Post('subscriptions/:id/revoke')
  public async revoke(@Req() request: IncomingRequest, @Param('id') id: string) {
    const { actor, session, correlationId } = await mutatingActor(this.runtime, request);
    this.requireCapability(actor, correlationId);
    const push = this.runtime.push;
    if (!push || !UUID.test(id)) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    const revoked = await push.store.revoke(
      actor.tenantId,
      id,
      this.subjectKey(session),
      'user_revoked',
      this.runtime.now(),
    );
    if (!revoked) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    return { correlationId, revoked: true };
  }

  @Post('test')
  public async test(@Req() request: IncomingRequest) {
    const { actor, session, correlationId } = await mutatingActor(this.runtime, request);
    this.requireCapability(actor, correlationId);
    const push = this.runtime.push;
    if (!push) throw new ApiError('DEPENDENCY_DEGRADED', correlationId);
    const delivered = await notifyDevices({
      store: push.store,
      sender: push.sender,
      tenantId: actor.tenantId,
      subjectKeys: [this.subjectKey(session)],
      now: () => this.runtime.now(),
    });
    return { correlationId, delivered };
  }

  @Get('pending')
  public async pending(@Req() request: IncomingRequest) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    this.requireCapability(actor, correlationId);
    const since = this.runtime.now().getTime() - PENDING_WINDOW_MS;
    const base = this.runtime.access.consoleBaseUrl.replace(/\/+$/u, '');
    const items: {
      type: string;
      id: string;
      title: string;
      severity: string;
      at: string;
      url: string;
    }[] = [];
    if (actor.capabilities.has('alerts.read')) {
      const alerts = await this.runtime.soc.listAlerts({
        tenantId: actor.tenantId,
        status: 'open',
        priority: 'P1',
      });
      for (const alert of alerts.items) {
        if (alert.occurredAt.getTime() < since) continue;
        items.push({
          type: 'alert',
          id: alert.id,
          title: alert.title,
          severity: alert.priority,
          at: alert.occurredAt.toISOString(),
          url: `${base}/alerts/${encodeURIComponent(alert.id)}`,
        });
      }
    }
    if (actor.capabilities.has('incidents.read')) {
      const incidents = await this.runtime.soc.listIncidents({ tenantId: actor.tenantId });
      for (const incident of incidents.items) {
        if (incident.severity !== 'critical' || incident.openedAt.getTime() < since) continue;
        items.push({
          type: 'incident',
          id: incident.id,
          title: incident.title,
          severity: incident.severity,
          at: incident.openedAt.toISOString(),
          url: `${base}/incidents/${encodeURIComponent(incident.id)}`,
        });
      }
    }
    items.sort((a, b) => b.at.localeCompare(a.at));
    return { correlationId, items: items.slice(0, PENDING_LIMIT) };
  }
}
