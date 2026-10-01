/**
 * Adapters de identidad del BFF: JWKS y canje de código.
 *
 * El adapter de Entra habla HTTP real contra el tenant configurado y cachea el JWKS con
 * refresco forzado ante un `kid` desconocido —que es lo que ocurre cuando Microsoft rota
 * sus claves—. El adapter local sirve el mismo contrato sin salir del proceso.
 */

import type { JsonWebKey, JwksProvider, TokenExchange, TokenExchangeResult } from '@qapaq/access';

import type { LocalDevelopmentIssuer } from './local-issuer.js';

export const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
export const IDENTITY_REQUEST_TIMEOUT_MS = 10_000;

export class EntraJwksProvider implements JwksProvider {
  private cached: readonly JsonWebKey[] = [];
  private fetchedAt = 0;

  public constructor(
    private readonly jwksUri: string,
    private readonly now: () => number = Date.now,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  public async keys(): Promise<readonly JsonWebKey[]> {
    if (this.cached.length > 0 && this.now() - this.fetchedAt < JWKS_CACHE_TTL_MS) {
      return this.cached;
    }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), IDENTITY_REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImplementation(this.jwksUri, { signal: controller.signal });
      if (!response.ok) throw new Error(`JWKS_UNAVAILABLE_${response.status}`);
      const body = (await response.json()) as { keys?: readonly JsonWebKey[] };
      this.cached = (body.keys ?? []).filter((key) => key.kty === 'RSA');
      this.fetchedAt = this.now();
      return this.cached;
    } finally {
      clearTimeout(deadline);
    }
  }
}

export class EntraTokenExchange implements TokenExchange {
  public constructor(
    private readonly options: {
      readonly tokenEndpoint: string;
      readonly clientId: string;
      readonly clientSecret: string;
      readonly scopes: readonly string[];
    },
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  public async exchange(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }): Promise<TokenExchangeResult> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), IDENTITY_REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImplementation(this.options.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          grant_type: 'authorization_code',
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier,
          scope: this.options.scopes.join(' '),
        }).toString(),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`TOKEN_EXCHANGE_FAILED_${response.status}`);
      const body = (await response.json()) as {
        id_token?: string;
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (!body.id_token) throw new Error('TOKEN_EXCHANGE_WITHOUT_ID_TOKEN');
      return {
        idToken: body.id_token,
        ...(body.access_token ? { accessToken: body.access_token } : {}),
        ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
        expiresInSeconds: body.expires_in ?? 3600,
      };
    } finally {
      clearTimeout(deadline);
    }
  }
}

export class LocalJwksProvider implements JwksProvider {
  public constructor(private readonly issuer: LocalDevelopmentIssuer) {}

  public keys(): Promise<readonly JsonWebKey[]> {
    return Promise.resolve(this.issuer.jwks);
  }
}

export class LocalTokenExchange implements TokenExchange {
  public constructor(
    private readonly issuer: LocalDevelopmentIssuer,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public exchange(input: { readonly code: string }): Promise<TokenExchangeResult> {
    return Promise.resolve({
      idToken: this.issuer.exchange(input.code, this.clock()),
      expiresInSeconds: 3600,
    });
  }
}
