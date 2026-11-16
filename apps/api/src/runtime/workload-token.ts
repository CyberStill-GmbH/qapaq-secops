/**
 * Sprint 5 · S5-D2 — token de workload del API para el gateway de Wazuh (C-28).
 *
 * El API pide a Entra un token de client credentials sobre su propio app registration
 * (`<audiencia>/.default`); KrakenD lo valida con el mismo issuer y audiencia que ya usa.
 * No agrega secretos: usa el client secret que el API ya tiene para el inicio de sesión.
 *
 * - Caché hasta `REFRESH_MARGIN_MS` antes del vencimiento; una sola petición en vuelo aunque
 *   varias llamadas pidan token a la vez.
 * - El token y el secreto nunca se registran. Un fallo se reporta con un código, sin el
 *   cuerpo de la respuesta de Entra (puede incluir trazas o identificadores internos).
 */

const REFRESH_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export class WorkloadTokenError extends Error {
  public constructor(public readonly code: 'TOKEN_REQUEST_FAILED' | 'TOKEN_RESPONSE_INVALID') {
    super(code);
    this.name = 'WorkloadTokenError';
  }
}

export interface EntraClientCredentialsOptions {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Scope pedido, p. ej. `api://<client-id>/.default` o `<client-id>/.default`. */
  readonly scope: string;
  /** Base del endpoint; inyectable para pruebas. */
  readonly authority?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export class EntraClientCredentialsTokenSource {
  #cached: { readonly token: string; readonly expiresAt: number } | undefined;
  #inFlight: Promise<string> | undefined;
  #lastRejectedRefreshAt = Number.NEGATIVE_INFINITY;

  public constructor(private readonly options: EntraClientCredentialsOptions) {}

  /** Refresh rejected credentials once per minute; old parallel failures cannot evict a newer token. */
  public refreshRejected = async (rejectedToken: string): Promise<string | null> => {
    if (this.#cached && this.#cached.token !== rejectedToken) return this.token();
    if (this.#inFlight) return this.#inFlight;
    const now = (this.options.now ?? Date.now)();
    if (now - this.#lastRejectedRefreshAt < REFRESH_MARGIN_MS) return null;
    this.#lastRejectedRefreshAt = now;
    this.#cached = undefined;
    return this.token();
  };

  /** Token vigente; renueva si falta menos del margen para vencer. */
  public token = (): Promise<string> => {
    const now = (this.options.now ?? Date.now)();
    if (this.#cached && this.#cached.expiresAt - REFRESH_MARGIN_MS > now) {
      return Promise.resolve(this.#cached.token);
    }
    this.#inFlight ??= this.#request().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  };

  async #request(): Promise<string> {
    const authority = this.options.authority ?? 'https://login.microsoftonline.com';
    const url = new URL(
      `/${encodeURIComponent(this.options.tenantId)}/oauth2/v2.0/token`,
      authority,
    );
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      scope: this.options.scope,
    });
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new WorkloadTokenError('TOKEN_REQUEST_FAILED');
    }
    if (!response.ok) throw new WorkloadTokenError('TOKEN_REQUEST_FAILED');
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new WorkloadTokenError('TOKEN_RESPONSE_INVALID');
    }
    const record = payload as { access_token?: unknown; expires_in?: unknown };
    const expiresIn = Number(record.expires_in);
    if (
      typeof record.access_token !== 'string' ||
      record.access_token.length < 20 ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0
    ) {
      throw new WorkloadTokenError('TOKEN_RESPONSE_INVALID');
    }
    const now = (this.options.now ?? Date.now)();
    this.#cached = { token: record.access_token, expiresAt: now + expiresIn * 1_000 };
    return record.access_token;
  }
}

/**
 * Token estático del gateway (`QAPAQ_WAZUH_GATEWAY_AUTH=static-token`): para un solo nodo sin
 * Entra. Misma forma que `EntraClientCredentialsTokenSource.token`, así el cliente C-28 no
 * cambia. El valor queda en un campo privado y solo sale por `token()`; la instancia se
 * serializa e inspecciona como `[REDACTED]`.
 */
export class StaticGatewayTokenSource {
  readonly #secret: { reveal(): string };

  public constructor(secret: { reveal(): string }) {
    if (!secret.reveal().trim()) throw new WorkloadTokenError('TOKEN_RESPONSE_INVALID');
    this.#secret = secret;
  }

  public token = (): Promise<string> => Promise.resolve(this.#secret.reveal());

  public toJSON(): string {
    return '[REDACTED]';
  }

  public toString(): string {
    return '[REDACTED]';
  }

  public [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'StaticGatewayTokenSource [REDACTED]';
  }
}
