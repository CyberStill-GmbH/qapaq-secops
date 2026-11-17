/**
 * Cliente interno de lectura de Qapaqzito: ejecuta `GET` contra la propia API **con la sesión de la
 * persona** (cookie y cabeceras de origen de la petición original), mediante `inject` de Fastify
 * (sin red). Solo admite rutas `/api/...` por `GET`: Qapaqzito no puede mutar nada por este camino.
 */

import type { IncomingRequest } from '../http/http-contracts.js';
import type { InternalGet, InternalResponse } from './soc-tools.js';

/** Superficie de Fastify que usa el cliente. */
export interface InjectingServer {
  inject(options: {
    method: 'GET';
    url: string;
    headers: Record<string, string>;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}

function single(value: string | readonly string[] | undefined): string | undefined {
  return Array.isArray(value) ? (value[0] as string | undefined) : (value as string | undefined);
}

export function createInternalGet(
  server: InjectingServer,
  request: IncomingRequest,
  signal?: AbortSignal,
): InternalGet {
  const cookie = single(request.headers.cookie);
  const forwarded = single(request.headers['x-forwarded-for']);
  return async (pathWithQuery): Promise<InternalResponse> => {
    if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    if (
      !pathWithQuery.startsWith('/api/') ||
      pathWithQuery.includes('//') ||
      pathWithQuery.includes('..')
    ) {
      return { status: 400, body: null };
    }
    const response = await server.inject({
      method: 'GET',
      url: pathWithQuery,
      headers: {
        accept: 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(forwarded ? { 'x-forwarded-for': forwarded } : {}),
      },
      remoteAddress: request.ip,
    });
    let body: unknown = null;
    try {
      body = JSON.parse(response.body);
    } catch {
      body = null;
    }
    return { status: response.statusCode, body };
  };
}
