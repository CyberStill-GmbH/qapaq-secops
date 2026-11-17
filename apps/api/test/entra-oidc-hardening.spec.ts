/**
 * Endurecimiento del inicio de sesión con Entra (rama fix/entra-oauth-hardening-20261115).
 *
 * - JWKS: un `kid` desconocido fuerza un refresco (rotación de claves de Microsoft), con
 *   intervalo mínimo para que un `kid` inventado no multiplique las peticiones al emisor.
 * - `/api/auth/start` es anónimo: el estado del flujo en memoria tiene tope.
 * - Los roles aprobadores no se aceptan desde el claim `roles` del token.
 */

import { describe, expect, it } from 'vitest';

import { HANDSHAKE_LIMITS } from '@qapaq/access';

import {
  EntraJwksProvider,
  JWKS_CACHE_TTL_MS,
  JWKS_FORCED_REFRESH_MIN_INTERVAL_MS,
} from '../src/access/identity-provider.js';
import { buildApi } from '../src/bootstrap.js';
import { rolesFromIdToken } from '../src/runtime/role-grants.js';

function jwksResponse(kid: string): Response {
  return new Response(JSON.stringify({ keys: [{ kid, kty: 'RSA', n: 'AQAB', e: 'AQAB' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('EntraJwksProvider · refresco ante kid desconocido', () => {
  it('sirve la caché sin forzar y la refresca cuando se fuerza tras el intervalo mínimo', async () => {
    let now = 1_000_000;
    const kids = ['k1', 'k2', 'k3'];
    const requests: RequestInit[] = [];
    const provider = new EntraJwksProvider(
      'https://login.microsoftonline.com/t/discovery/v2.0/keys',
      () => now,
      ((_url: string, init: RequestInit) => {
        requests.push(init);
        return Promise.resolve(jwksResponse(kids[requests.length - 1]!));
      }) as unknown as typeof fetch,
    );
    expect((await provider.keys())[0]!.kid).toBe('k1');
    expect(requests[0]!.redirect).toBe('error');
    // Sin forzar, dentro del TTL: caché.
    now += 1_000;
    expect((await provider.keys())[0]!.kid).toBe('k1');
    // Forzado antes del intervalo mínimo: sigue la caché (un kid inventado no amplifica).
    expect((await provider.keys({ forceRefresh: true }))[0]!.kid).toBe('k1');
    expect(requests).toHaveLength(1);
    // Forzado después del intervalo mínimo: refresca aunque el TTL no haya vencido.
    now += JWKS_FORCED_REFRESH_MIN_INTERVAL_MS;
    expect(now - 1_000_000).toBeLessThan(JWKS_CACHE_TTL_MS);
    expect((await provider.keys({ forceRefresh: true }))[0]!.kid).toBe('k2');
    expect(requests).toHaveLength(2);
  });
});

describe('roles del ID token', () => {
  it('descarta los roles aprobadores y conserva los roles runtime', () => {
    expect(
      rolesFromIdToken([
        'qapaq.soc.analyst',
        'qapaq.access.approver',
        'qapaq.security.approver',
        'qapaq.platform.admin',
      ]),
    ).toEqual(['qapaq.soc.analyst', 'qapaq.platform.admin']);
    expect(rolesFromIdToken(undefined)).toEqual([]);
  });
});

describe('/api/auth/start · estado del flujo acotado', () => {
  it('no retiene más handshakes, nonces ni destinos que el tope', async () => {
    const built = await buildApi({ QAPAQ_PROFILE: 'test' }, () => {});
    const runtime = built.runtime;
    const origin = { remoteAddress: '10.20.0.10' };
    for (let index = 0; index < HANDSHAKE_LIMITS.maxPending + 25; index += 1) {
      await runtime.beginSignIn(origin, '/');
    }
    expect(runtime.handshakes.size).toBeLessThanOrEqual(HANDSHAKE_LIMITS.maxPending);
    expect(runtime.pendingFlowCount.nonces).toBeLessThanOrEqual(HANDSHAKE_LIMITS.maxPending);
    expect(runtime.pendingFlowCount.returnTo).toBeLessThanOrEqual(HANDSHAKE_LIMITS.maxPending);
    // El flujo más reciente sigue completo y usable.
    const last = await runtime.beginSignIn(origin, '/qapaq/alerts');
    expect(runtime.takeReturnTo(last.state, last.browserBinding)).toBe('/qapaq/alerts');
    await built.application.close();
  });
});
