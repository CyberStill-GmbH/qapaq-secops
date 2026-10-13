/**
 * C-10(b) — administración de sesiones del tenant.
 *
 * - `GET /api/admin/sessions` (`sessions.read`): sesiones vistas en los últimos 7 días, más
 *   recientes primero, paginadas por cursor. Cada fila trae `ref` (`h:<sha256>`), que sirve
 *   para revocar pero nunca como cookie: el valor de la cookie no existe fuera del navegador
 *   de su dueño.
 * - `POST /api/admin/sessions/:ref/revoke` (`sessions.revoke` + CSRF): revoca con motivo
 *   obligatorio y deja `AuditEvent`. La propia sesión no se revoca por aquí (para eso está
 *   cerrar sesión), así un administrador no se deja fuera por error.
 *
 * Mismo error para inexistente y no autorizado: la API no enumera sesiones ajenas.
 */

import { randomUUID } from 'node:crypto';

import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { revokeSession, type Session } from '@qapaq/access';
import { recordAudit } from '@qapaq/audit';

import { ApiError } from '../http/api-error.js';
import type { IncomingRequest } from '../http/http-contracts.js';
import { paginate, type PageQuery } from '../http/pagination.js';
import { mutatingActor, readingActor } from './session-actor.js';
import { SECOPS_RUNTIME } from './tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';

const SESSION_WINDOW_DAYS = 7;
const SESSION_LIST_LIMIT = 2_000;
const REFERENCE_PATTERN = /^h:[0-9a-f]{64}$/u;
const REASON_LIMITS = Object.freeze({ minimumLength: 10, maximumLength: 500 });

function sessionView(session: Session, currentReference: string | undefined) {
  return {
    ref: session.id,
    current: session.id === currentReference,
    subjectId: session.subjectId,
    displayName: session.displayName ?? null,
    email: session.email ?? null,
    state: session.state,
    roles: session.roles,
    // Factores de autenticación del IdP (`pwd`, `mfa`, `fido`…): evidencia de MFA.
    amr: session.amr,
    clientIp: session.clientIp,
    createdAt: session.createdAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
    revokedAt: session.revokedAt?.toISOString() ?? null,
    revocationReason: session.revocationReason ?? null,
    revision: session.revision,
  };
}

@Controller('api/admin/sessions')
export class AdminSessionsController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  @Get()
  public async list(@Req() request: IncomingRequest, @Query() query: PageQuery) {
    const { actor, session, correlationId } = await readingActor(this.runtime, request);
    if (!actor.capabilities.has('sessions.read')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const since = new Date(this.runtime.now().getTime() - SESSION_WINDOW_DAYS * 86_400_000);
    const sessions = await this.runtime.sessions.recentByTenant(
      actor.tenantId,
      since,
      SESSION_LIST_LIMIT,
    );
    const currentReference = this.runtime.sessionReferenceOf(session.id);
    const page = paginate(
      sessions,
      (row) => ({ at: row.lastSeenAt.getTime(), id: row.id }),
      query,
      'admin-sessions',
      correlationId,
    );
    return {
      correlationId,
      windowDays: SESSION_WINDOW_DAYS,
      items: page.items.map((row) => sessionView(row, currentReference)),
      nextCursor: page.nextCursor,
      totalCount: sessions.length,
    };
  }

  @Post(':ref/revoke')
  public async revoke(
    @Req() request: IncomingRequest,
    @Param('ref') reference: string,
    @Body() body: { reason?: unknown; expectedRevision?: unknown },
  ) {
    const { actor, session, correlationId } = await mutatingActor(this.runtime, request);
    if (!actor.capabilities.has('sessions.revoke')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (
      reason.length < REASON_LIMITS.minimumLength ||
      reason.length > REASON_LIMITS.maximumLength ||
      typeof body.expectedRevision !== 'number'
    ) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['reason', 'expectedRevision']);
    }
    if (!REFERENCE_PATTERN.test(reference)) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const target = await this.runtime.sessions.byReference(reference);
    if (!target || target.tenantId !== actor.tenantId) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    if (reference === this.runtime.sessionReferenceOf(session.id)) {
      // La propia sesión se cierra con logout, no con una revocación administrativa.
      throw new ApiError('STATE_CONFLICT', correlationId);
    }
    if (target.state !== 'active' || target.revision !== body.expectedRevision) {
      throw new ApiError('STATE_CONFLICT', correlationId);
    }
    const at = this.runtime.now();
    const revoked = revokeSession(target, 'administrative', at);
    if (!(await this.runtime.sessions.update(revoked, target.revision))) {
      throw new ApiError('STATE_CONFLICT', correlationId);
    }
    await recordAudit(this.runtime.audit, {
      id: randomUUID(),
      tenantId: actor.tenantId,
      occurredAt: at,
      actor: { id: actor.subjectId, type: 'user', sessionId: actor.sessionId },
      action: 'access.session.revoked',
      resource: { type: 'session', id: target.subjectId },
      outcome: 'succeeded',
      correlationId,
      reason,
      metadata: { reference, targetSubject: target.subjectId },
    });
    return { correlationId, session: sessionView(revoked, undefined) };
  }
}
