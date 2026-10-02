/**
 * Resolución de la persona detrás de una petición, común a todos los controladores.
 *
 * Las lecturas solo necesitan una sesión válida. Las mutaciones necesitan además el token
 * CSRF de esa misma sesión (B-01): el orden es sesión primero —un anónimo recibe 401, no
 * 403— y token después, antes de tocar ningún caso de uso.
 */

import { ApiError } from '../http/api-error.js';
import { csrfAccepted } from '../http/csrf.js';
import type { IncomingRequest } from '../http/http-contracts.js';
import { correlationIdOf, originOf, sessionIdOf } from '../http/request-context.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';

export async function readingActor(runtime: SecOpsRuntime, request: IncomingRequest) {
  const correlationId = correlationIdOf(request);
  const resolved = await runtime.resolveActor(sessionIdOf(request), originOf(request));
  if (!resolved.ok) throw new ApiError(resolved.reason, correlationId);
  return { actor: resolved.actor, session: resolved.session, correlationId };
}

export async function mutatingActor(runtime: SecOpsRuntime, request: IncomingRequest) {
  const resolved = await readingActor(runtime, request);
  if (!csrfAccepted(request, runtime.csrfTokenFor(resolved.session.id))) {
    throw new ApiError('REQUEST_NOT_VERIFIED', resolved.correlationId);
  }
  return resolved;
}
