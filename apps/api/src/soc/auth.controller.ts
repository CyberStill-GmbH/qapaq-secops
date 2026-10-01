/**
 * C-18/C-25 — endpoints de sesión del BFF.
 *
 * El navegador no ve tokens en ningún momento: `/api/auth/start` redirige al emisor,
 * `/api/auth/callback` canjea en el servidor y la única credencial que vuelve al cliente
 * es una cookie `HttpOnly` con un identificador opaco.
 */

import { Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { IncomingRequest, OutgoingReply } from '../http/http-contracts.js';

import { ApiError, fromSignInDenial } from '../http/api-error.js';
import {
  clearSessionCookie,
  correlationIdOf,
  originOf,
  sessionIdOf,
  setSessionCookie,
} from '../http/request-context.js';
import { SECOPS_RUNTIME } from './tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';

@Controller('api/auth')
export class AuthController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  @Get('start')
  public async start(@Req() request: IncomingRequest, @Res() reply: OutgoingReply) {
    const begun = await this.runtime.beginSignIn(originOf(request));
    // 302 al emisor: el `state` queda del lado servidor, no en un campo oculto.
    const target = this.runtime.isLocalIdentity
      ? `/api/auth/local/login?state=${encodeURIComponent(begun.state)}`
      : begun.url;
    await reply.status(302).header('location', target).send();
  }

  @Get('callback')
  public async callback(
    @Query() query: { state?: string; code?: string; error?: string },
    @Req() request: IncomingRequest,
    @Res() reply: OutgoingReply,
  ) {
    const correlationId = correlationIdOf(request);
    const result = await this.runtime.completeSignIn(query, originOf(request), correlationId);
    if (!result.ok) throw fromSignInDenial(result.failure.reason, correlationId);
    setSessionCookie(
      reply,
      result.value.session.id,
      this.runtime.secureCookies,
      Math.floor(
        (result.value.session.absoluteExpiresAt.getTime() - this.runtime.now().getTime()) / 1000,
      ),
    );
    await reply.status(200).send({
      subjectId: result.value.session.subjectId,
      capabilities: [...result.value.session.capabilities].sort(),
      supersededSessions: result.value.supersededSessions.length,
      correlationId,
    });
  }

  @Get('session')
  public async session(@Req() request: IncomingRequest) {
    const correlationId = correlationIdOf(request);
    const resolved = await this.runtime.resolveActor(sessionIdOf(request), originOf(request));
    if (!resolved.ok) throw new ApiError(resolved.reason, correlationId);
    return {
      subjectId: resolved.actor.subjectId,
      tenantId: resolved.actor.tenantId,
      roles: resolved.actor.roles,
      capabilities: [...resolved.actor.capabilities].sort(),
      amr: resolved.session.amr,
      correlationId,
    };
  }

  @Post('logout')
  public async logout(@Req() request: IncomingRequest, @Res() reply: OutgoingReply) {
    const sessionId = sessionIdOf(request);
    if (sessionId) await this.runtime.signOut(sessionId);
    clearSessionCookie(reply, this.runtime.secureCookies);
    await reply.status(204).send();
  }
}
