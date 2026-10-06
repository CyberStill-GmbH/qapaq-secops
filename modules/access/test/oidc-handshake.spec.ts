import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  beginAuthorization,
  pkceChallenge,
  resolveCallback,
  type EntraEndpointConfig,
  type PendingHandshake,
} from '../src/oidc-handshake.js';
import { InMemoryHandshakeStore } from '../src/memory-stores.js';
import { CLIENT_ID, TENANT_ID } from './support/token-factory.js';

const NOW = new Date('2026-10-07T12:00:00.000Z');

const config: EntraEndpointConfig = {
  tenantId: TENANT_ID,
  clientId: CLIENT_ID,
  authorizationEndpoint: `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`,
  redirectUri: 'https://soc.qapaq.pe/auth/callback',
  allowedRedirectUris: ['https://soc.qapaq.pe/auth/callback'],
  scopes: ['openid', 'profile', 'offline_access'],
};

function pending(overrides: Partial<PendingHandshake> = {}): PendingHandshake {
  return {
    state: 'state-1',
    nonce: 'nonce-1',
    codeVerifier: 'verifier-1',
    browserBinding: 'binding-1',
    redirectUri: config.redirectUri,
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 600_000),
    ...overrides,
  };
}

describe('C-18 · inicio del flujo OIDC', () => {
  it('construye la URL de autorización con PKCE S256, state y nonce', () => {
    const request = beginAuthorization(config, NOW);
    const url = new URL(request.authorizationUrl);

    expect(url.origin + url.pathname).toBe(config.authorizationEndpoint);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(request.state);
    expect(url.searchParams.get('nonce')).toBe(request.nonce);
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(request.codeVerifier, 'ascii').digest('base64url'),
    );
  });

  it('no coloca el code_verifier en la URL que ve el navegador', () => {
    const request = beginAuthorization(config, NOW);

    expect(request.authorizationUrl).not.toContain(request.codeVerifier);
    expect(pkceChallenge(request.codeVerifier)).toBe(request.codeChallenge);
  });

  it('genera state, nonce y verifier distintos en cada inicio', () => {
    const first = beginAuthorization(config, NOW);
    const second = beginAuthorization(config, NOW);

    expect(second.state).not.toBe(first.state);
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.codeVerifier).not.toBe(first.codeVerifier);
  });

  it('rechaza un redirect_uri que no esté en la lista aprobada', () => {
    expect(() =>
      beginAuthorization({ ...config, redirectUri: 'https://atacante.example/callback' }, NOW),
    ).toThrow(/REDIRECT_URI_NOT_ALLOWED/u);
  });
});

describe('C-18 · retorno del flujo OIDC', () => {
  it('acepta el retorno con state conocido y vigente', () => {
    const result = resolveCallback(
      { state: 'state-1', code: 'auth-code', browserBinding: 'binding-1' },
      pending(),
      NOW,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.handshake.codeVerifier).toBe('verifier-1');
  });

  it('rechaza un state desconocido', () => {
    expect(
      resolveCallback({ state: 'state-x', code: 'c', browserBinding: 'binding-1' }, undefined, NOW),
    ).toMatchObject({
      ok: false,
      code: 'STATE_UNKNOWN',
    });
  });

  it('rechaza un state que no coincide con el almacenado', () => {
    expect(
      resolveCallback(
        { state: 'otro-state', code: 'c', browserBinding: 'binding-1' },
        pending(),
        NOW,
      ),
    ).toMatchObject({
      ok: false,
      code: 'STATE_MISMATCH',
    });
  });

  it('rechaza un state caducado', () => {
    const later = new Date(NOW.getTime() + 601_000);

    expect(
      resolveCallback(
        { state: 'state-1', code: 'c', browserBinding: 'binding-1' },
        pending(),
        later,
      ),
    ).toMatchObject({
      ok: false,
      code: 'STATE_EXPIRED',
    });
  });

  it('rechaza el replay de un state ya consumido aunque siga vigente', () => {
    expect(
      resolveCallback(
        { state: 'state-1', code: 'c', browserBinding: 'binding-1' },
        pending({ consumedAt: NOW }),
        NOW,
      ),
    ).toMatchObject({ ok: false, code: 'STATE_REPLAYED' });
  });

  it('propaga el error del proveedor sin intentar continuar', () => {
    expect(
      resolveCallback(
        { state: 'state-1', error: 'access_denied', browserBinding: 'binding-1' },
        pending(),
        NOW,
      ),
    ).toMatchObject({ ok: false, code: 'PROVIDER_ERROR', detail: 'access_denied' });
  });

  it('solo deja consumir el handshake una vez en el store', async () => {
    const store = new InMemoryHandshakeStore();
    await store.save(pending());

    const wrongBrowser = await store.consume('state-1', 'attacker-binding', NOW);
    const first = await store.consume('state-1', 'binding-1', NOW);
    const second = await store.consume('state-1', 'binding-1', NOW);

    expect(
      resolveCallback(
        { state: 'state-1', code: 'c', browserBinding: 'attacker-binding' },
        wrongBrowser,
        NOW,
      ),
    ).toMatchObject({ ok: false, code: 'STATE_MISMATCH' });
    expect(
      resolveCallback({ state: 'state-1', code: 'c', browserBinding: 'binding-1' }, first, NOW).ok,
    ).toBe(true);
    expect(
      resolveCallback({ state: 'state-1', code: 'c', browserBinding: 'binding-1' }, second, NOW),
    ).toMatchObject({
      ok: false,
      code: 'STATE_REPLAYED',
    });
  });
});
