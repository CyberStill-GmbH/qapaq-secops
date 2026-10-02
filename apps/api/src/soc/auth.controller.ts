/**
 * C-18/C-25 — endpoints de sesión del BFF.
 *
 * El navegador no ve tokens en ningún momento: `/api/auth/start` redirige al emisor,
 * `/api/auth/callback` canjea en el servidor y la única credencial que vuelve al cliente
 * es una cookie `HttpOnly` con un identificador opaco.
 *
 * El callback termina con un 303 a la consola (B-03): es una navegación del navegador y
 * no un `fetch`, así que responder con JSON dejaba a la persona frente a un documento
 * técnico. El error viaja como código público del catálogo, nunca como motivo interno.
 */

import { Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { IncomingRequest, OutgoingReply } from '../http/http-contracts.js';

import { ApiError, signInDenialCode } from '../http/api-error.js';
import { csrfAccepted } from '../http/csrf.js';
import {
  clearSessionCookie,
  correlationIdOf,
  originOf,
  sessionIdOf,
  setSessionCookie,
} from '../http/request-context.js';
import { safeReturnTo, withAuthError, withSupersededNotice } from '../http/return-to.js';
import { SECOPS_RUNTIME } from './tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';

@Controller('api/auth')
export class AuthController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  @Get('start')
  public async start(
    @Query() query: { returnTo?: string },
    @Req() request: IncomingRequest,
    @Res() reply: OutgoingReply,
  ) {
    const begun = await this.runtime.beginSignIn(originOf(request), safeReturnTo(query.returnTo));
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
    const returnTo = this.runtime.takeReturnTo(query.state);
    const result = await this.runtime.completeSignIn(query, originOf(request), correlationId);
    if (!result.ok) {
      const code = signInDenialCode(result.failure.reason);
      await reply
        .status(303)
        .header('cache-control', 'no-store')
        .header('location', withAuthError(returnTo, code, correlationId))
        .send();
      return;
    }
    setSessionCookie(
      reply,
      result.value.session.id,
      this.runtime.secureCookies,
      Math.floor(
        (result.value.session.absoluteExpiresAt.getTime() - this.runtime.now().getTime()) / 1000,
      ),
    );
    await reply
      .status(303)
      .header('cache-control', 'no-store')
      .header('location', withSupersededNotice(returnTo, result.value.supersededSessions.length))
      .send();
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
      // Solo legible desde el mismo origen (no hay CORS); se reenvía en `x-csrf-token`.
      csrfToken: this.runtime.csrfTokenFor(resolved.session.id),
      correlationId,
    };
  }

  @Post('logout')
  public async logout(@Req() request: IncomingRequest, @Res() reply: OutgoingReply) {
    const correlationId = correlationIdOf(request);
    const resolved = await this.runtime.resolveActor(sessionIdOf(request), originOf(request));
    // Una sesión vigente solo se cierra con su token: otro sitio no puede expulsar a la
    // persona. Sin sesión vigente no hay nada que proteger y la cookie se limpia igual.
    if (resolved.ok) {
      if (!csrfAccepted(request, this.runtime.csrfTokenFor(resolved.session.id))) {
        throw new ApiError('REQUEST_NOT_VERIFIED', correlationId);
      }
      await this.runtime.signOut(resolved.session.id);
    }
    clearSessionCookie(reply, this.runtime.secureCookies);
    await reply.status(204).send();
  }
}
