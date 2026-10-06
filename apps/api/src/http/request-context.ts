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
const OIDC_FLOW_COOKIE_PREFIX = 'qapaq_oidc_flow_';
const OIDC_STATE_FORMAT = /^[A-Za-z0-9_-]{43}$/u;
const OIDC_FLOW_TTL_SECONDS = 10 * 60;
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

function oidcFlowCookieName(state: string): string {
  return `${OIDC_FLOW_COOKIE_PREFIX}${state}`;
}

/** El `state` viaja al IdP; esta cookie HttpOnly agrega la prueba del navegador iniciador. */
export function oidcFlowBindingOf(
  request: IncomingRequest,
  state: string | undefined,
): string | undefined {
  if (!state || !OIDC_STATE_FORMAT.test(state)) return undefined;
  const raw = request.headers.cookie;
  const cookie = typeof raw === 'string' ? raw : raw?.join('; ');
  if (!cookie) return undefined;
  const prefix = `${oidcFlowCookieName(state)}=`;
  const value = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function oidcFlowCookie(
  state: string,
  binding: string,
  secure: boolean,
  maxAgeSeconds: number,
): string {
  return [
    `${oidcFlowCookieName(state)}=${encodeURIComponent(binding)}`,
    'Path=/api/auth/callback',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function setOidcFlowCookie(
  reply: OutgoingReply,
  state: string,
  binding: string,
  secure: boolean,
): void {
  reply.header('set-cookie', oidcFlowCookie(state, binding, secure, OIDC_FLOW_TTL_SECONDS));
}

export function expiredOidcFlowCookie(state: string, secure: boolean): string {
  if (!OIDC_STATE_FORMAT.test(state)) return '';
  return oidcFlowCookie(state, '', secure, 0);
}

export function setSessionCookie(
  reply: OutgoingReply,
  sessionId: string,
  secure: boolean,
  maxAgeSeconds: number,
  additionalCookies: readonly string[] = [],
): void {
  reply.header('set-cookie', [
    [
      `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
      ...(secure ? ['Secure'] : []),
    ].join('; '),
    ...additionalCookies,
  ]);
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
