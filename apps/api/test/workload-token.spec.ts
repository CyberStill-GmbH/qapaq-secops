/**
 * Sprint 5 · S5-D2 — token de workload del API para el gateway de Wazuh.
 *
 * Fija la caché con margen de renovación, una sola petición en vuelo y que un fallo no expone
 * el cuerpo de la respuesta de Entra.
 */

import { describe, expect, it } from 'vitest';

import { EntraClientCredentialsTokenSource } from '../src/runtime/workload-token.js';

const TOKEN = 'eyJ.sintetico.token-de-prueba-para-workload';

function source(responses: Array<() => Response>, now: () => number) {
  const bodies: string[] = [];
  const instance = new EntraClientCredentialsTokenSource({
    tenantId: '00000000-0000-0000-0000-000000000001',
    clientId: '00000000-0000-0000-0000-000000000002',
    clientSecret: 'secreto-sintetico',
    scope: 'api://00000000-0000-0000-0000-000000000002/.default',
    authority: 'https://login.example.test',
    now,
    fetch: (async (_url: URL, init: RequestInit) => {
      bodies.push(String(init.body));
      const next = responses.shift();
      if (!next) throw new Error('sin respuesta');
      return next();
    }) as unknown as typeof fetch,
  });
  return { instance, bodies };
}

const ok = () =>
  new Response(JSON.stringify({ access_token: TOKEN, expires_in: 3600 }), { status: 200 });

describe('token de workload por client credentials', () => {
  it('pide con client credentials y reutiliza el token hasta el margen de vencimiento', async () => {
    let now = 0;
    const { instance, bodies } = source([ok, ok], () => now);
    expect(await instance.token()).toBe(TOKEN);
    now = 3_000_000;
    expect(await instance.token()).toBe(TOKEN);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('grant_type=client_credentials');
    now = 3_600_000 - 30_000;
    await instance.token();
    expect(bodies).toHaveLength(2);
  });

  it('una sola petición en vuelo aunque varias llamadas pidan token a la vez', async () => {
    const { instance, bodies } = source([ok], () => 0);
    await Promise.all([instance.token(), instance.token(), instance.token()]);
    expect(bodies).toHaveLength(1);
  });

  it('un rechazo de Entra se reporta con código, sin el cuerpo de la respuesta', async () => {
    const { instance } = source(
      [() => new Response('{"error":"invalid_client","trace_id":"interno"}', { status: 401 })],
      () => 0,
    );
    const error = await instance.token().catch((caught: unknown) => caught as Error);
    expect(error).toMatchObject({ code: 'TOKEN_REQUEST_FAILED' });
    expect(String(error.message)).not.toContain('interno');
  });
});
