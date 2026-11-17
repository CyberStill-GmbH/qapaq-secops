/**
 * C-18 — inicio y retorno del flujo OIDC con Microsoft Entra, patrón BFF.
 *
 * El navegador nunca recibe tokens: el código se intercambia en el backend y lo único
 * que viaja al cliente es una cookie de sesión opaca. De ahí que aquí vivan `state`,
 * `nonce` y PKCE, y que el `code_verifier` se guarde del lado servidor asociado al
 * `state`, no en el cliente.
 *
 * Todo lo que llega del borde se trata como hostil: `state` desconocido, repetido o
 * caducado no es un caso de usuario despistado, es un intento de fijación o de replay.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const PKCE_METHOD = 'S256' as const;

export const HANDSHAKE_LIMITS = Object.freeze({
  /** Ventana entre el redirect y el retorno. Entra admite más; QAPAQ no lo necesita. */
  stateTtlMs: 10 * 60 * 1000,
  stateBytes: 32,
  nonceBytes: 32,
  verifierBytes: 64,
  /**
   * Tope de handshakes pendientes por proceso. `/api/auth/start` es anónimo: sin tope, cada
   * petición dejaría estado en memoria hasta agotarla. Al llenarse se descarta el más antiguo.
   */
  maxPending: 10_000,
});

export const HANDSHAKE_ERROR_CODES = [
  'STATE_UNKNOWN',
  'STATE_EXPIRED',
  'STATE_REPLAYED',
  'STATE_MISMATCH',
  'REDIRECT_URI_NOT_ALLOWED',
  'PROVIDER_ERROR',
  'CODE_REQUIRED',
] as const;
export type HandshakeErrorCode = (typeof HANDSHAKE_ERROR_CODES)[number];

export interface AuthorizationRequest {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  /** Secreto independiente del `state`, enlazado al navegador que inició el flujo. */
  readonly browserBinding: string;
  readonly codeChallenge: string;
  readonly expiresAt: Date;
}

export interface PendingHandshake {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly browserBinding: string;
  readonly redirectUri: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt?: Date;
}

export interface EntraEndpointConfig {
  readonly tenantId: string;
  readonly clientId: string;
  readonly authorizationEndpoint: string;
  readonly redirectUri: string;
  readonly allowedRedirectUris: readonly string[];
  readonly scopes: readonly string[];
}

export interface CallbackInput {
  readonly state?: string;
  readonly code?: string;
  readonly error?: string;
  readonly errorDescription?: string;
  readonly browserBinding?: string;
}

const PROVIDER_ERROR_CODES = new Set([
  'access_denied',
  'consent_required',
  'interaction_required',
  'invalid_client',
  'invalid_request',
  'login_required',
  'server_error',
  'temporarily_unavailable',
  'unauthorized_client',
  'unsupported_response_type',
]);

/** Conserva solo un código estable del proveedor; nunca registra `error_description` crudo. */
function providerDiagnosticCode(input: CallbackInput): string {
  const description = input.errorDescription?.slice(0, 4096);
  const aadsts = description?.match(/AADSTS([0-9]{1,8})/iu);
  if (aadsts) return `AADSTS${aadsts[1]}`;
  const error = input.error?.toLowerCase();
  return error && PROVIDER_ERROR_CODES.has(error) ? error : 'PROVIDER_ERROR';
}

export type CallbackResult =
  | { readonly ok: true; readonly handshake: PendingHandshake; readonly code: string }
  | {
      readonly ok: false;
      readonly code: HandshakeErrorCode;
      readonly detail?: string;
    };

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export function pkceChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier, 'ascii').digest());
}

/** Comparación en tiempo constante; `state` es un secreto de un solo uso. */
export function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function beginAuthorization(
  config: EntraEndpointConfig,
  now: Date,
  randomSource: (bytes: number) => Buffer = randomBytes,
): AuthorizationRequest {
  if (!config.allowedRedirectUris.includes(config.redirectUri)) {
    throw new Error('REDIRECT_URI_NOT_ALLOWED');
  }
  const state = base64Url(randomSource(HANDSHAKE_LIMITS.stateBytes));
  const nonce = base64Url(randomSource(HANDSHAKE_LIMITS.nonceBytes));
  const codeVerifier = base64Url(randomSource(HANDSHAKE_LIMITS.verifierBytes));
  const browserBinding = base64Url(randomSource(HANDSHAKE_LIMITS.stateBytes));
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  // En producción el callback llega por POST: el código no termina en la URL ni en los
  // access logs del ALB/nginx. HTTP queda reservado al emisor local de desarrollo.
  url.searchParams.set(
    'response_mode',
    new URL(config.redirectUri).protocol === 'https:' ? 'form_post' : 'query',
  );
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', pkceChallenge(codeVerifier));
  url.searchParams.set('code_challenge_method', PKCE_METHOD);
  return {
    authorizationUrl: url.toString(),
    state,
    nonce,
    codeVerifier,
    browserBinding,
    codeChallenge: pkceChallenge(codeVerifier),
    expiresAt: new Date(now.getTime() + HANDSHAKE_LIMITS.stateTtlMs),
  };
}

export function resolveCallback(
  input: CallbackInput,
  stored: PendingHandshake | undefined,
  now: Date,
): CallbackResult {
  if (!input.state) return { ok: false, code: 'STATE_MISMATCH' };
  if (!stored) return { ok: false, code: 'STATE_UNKNOWN' };
  if (!constantTimeEquals(input.state, stored.state)) return { ok: false, code: 'STATE_MISMATCH' };
  // El orden importa: un `state` ya consumido se rechaza aunque siga vigente.
  if (stored.consumedAt) return { ok: false, code: 'STATE_REPLAYED' };
  if (stored.expiresAt.getTime() <= now.getTime()) return { ok: false, code: 'STATE_EXPIRED' };
  if (!constantTimeEquals(input.browserBinding ?? '', stored.browserBinding)) {
    return { ok: false, code: 'STATE_MISMATCH' };
  }
  if (input.error) {
    return { ok: false, code: 'PROVIDER_ERROR', detail: providerDiagnosticCode(input) };
  }
  if (!input.code) return { ok: false, code: 'CODE_REQUIRED' };
  return { ok: true, handshake: stored, code: input.code };
}
