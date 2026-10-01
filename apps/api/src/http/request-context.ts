/**
 * Contexto de petición del BFF: correlación, origen de red y cookie de sesión.
 *
 * El `correlationId` se acepta del cliente solo si tiene forma de UUID; si no, se
 * genera. Aceptarlo tal cual permitiría inyectar texto arbitrario en logs y auditoría.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingRequest, OutgoingReply } from './http-contracts.js';
import type { RequestOrigin } from '@qapaq/access';

export const SESSION_COOKIE = 'qapaq_session';
export const CORRELATION_HEADER = 'x-correlation-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function correlationIdOf(request: IncomingRequest): string {
  const header = request.headers[CORRELATION_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  return value && UUID.test(value) ? value : randomUUID();
}

export function originOf(request: IncomingRequest): RequestOrigin {
  const forwarded = request.headers['x-forwarded-for'];
  return {
    remoteAddress: request.ip,
    ...(forwarded === undefined ? {} : { forwardedFor: forwarded }),
  };
}

export function sessionIdOf(request: IncomingRequest): string | undefined {
  const raw = request.headers.cookie;
  const cookie = typeof raw === 'string' ? raw : raw?.join('; ');
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export function setSessionCookie(
  reply: OutgoingReply,
  sessionId: string,
  secure: boolean,
  maxAgeSeconds: number,
): void {
  reply.header(
    'set-cookie',
    [
      `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
      ...(secure ? ['Secure'] : []),
    ].join('; '),
  );
}

export function clearSessionCookie(reply: OutgoingReply, secure: boolean): void {
  reply.header(
    'set-cookie',
    [
      `${SESSION_COOKIE}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=0',
      ...(secure ? ['Secure'] : []),
    ].join('; '),
  );
}
