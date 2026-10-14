/**
 * B-01 — protección CSRF de las mutaciones del BFF.
 *
 * La cookie de sesión viaja sola en cualquier petición al origen, de modo que una página
 * de otro sitio podría disparar un `POST` con la sesión de quien la visita. `SameSite=Lax`
 * ya corta el caso común, pero no cubre un subdominio comprometido ni un navegador que no
 * lo aplique. Se añaden dos barreras independientes:
 *
 * 1. **Token sincronizado** derivado de la sesión con HMAC. Solo lo puede leer código del
 *    mismo origen (vía `GET /api/auth/session`, sin CORS), y otro sitio no puede
 *    calcularlo sin la clave. No hay estado extra: revocar la sesión invalida el token.
 * 2. **`Sec-Fetch-Site: cross-site`** se rechaza aunque el token fuera válido.
 */

import { createHmac } from 'node:crypto';

import { constantTimeEquals } from '@qapaq/access';

import type { IncomingRequest } from './http-contracts.js';

export const CSRF_HEADER = 'x-csrf-token';

/** Deriva una clave CSRF estable por propósito desde el secreto compartido del BFF. */
export function deriveCsrfKey(masterKey: string | Buffer): Buffer {
  return createHmac('sha256', masterKey).update('qapaq.csrf.key.v1').digest();
}

function single(value: string | readonly string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : (value as string | undefined);
}

export function csrfTokenFor(key: Buffer, sessionId: string): string {
  return createHmac('sha256', key).update(`qapaq.csrf.v1:${sessionId}`).digest('base64url');
}

export function csrfAccepted(request: IncomingRequest, expected: string): boolean {
  if (single(request.headers['sec-fetch-site']) === 'cross-site') return false;
  const sent = single(request.headers[CSRF_HEADER]);
  return typeof sent === 'string' && constantTimeEquals(sent, expected);
}
