/**
 * C-18 — validación del `id_token` de Entra.
 *
 * La firma se verifica de verdad (RS256 contra el JWKS del tenant); no hay modo
 * "confiar en el emisor". Y se validan, en este orden, las condiciones que convierten
 * un token bien firmado en un token aceptable aquí: emisor, audiencia, tenant, ventana
 * temporal, `nonce` y método de autenticación.
 *
 * El `tid` se comprueba además de `iss` a propósito: un token de otro tenant de Entra
 * está perfectamente firmado por Microsoft y no debe abrir sesión en QAPAQ.
 */

import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';

export const ID_TOKEN_ERROR_CODES = [
  'MALFORMED',
  'CLAIMS_MALFORMED',
  'ALG_NOT_ALLOWED',
  'KEY_UNKNOWN',
  'SIGNATURE_INVALID',
  'ISSUER_MISMATCH',
  'AUDIENCE_MISMATCH',
  'AZP_MISMATCH',
  'TENANT_MISMATCH',
  'EXPIRED',
  'NOT_YET_VALID',
  'ISSUED_IN_FUTURE',
  'NONCE_MISMATCH',
  'SUBJECT_MISSING',
  'AMR_NOT_ACCEPTED',
] as const;
export type IdTokenErrorCode = (typeof ID_TOKEN_ERROR_CODES)[number];

/** Solo RS256: `none` y HMAC no se negocian con un IdP que publica JWKS asimétrico. */
export const ALLOWED_ALGORITHMS = ['RS256'] as const;

/** Tolerancia de reloj. Más ancha convierte un token caducado en uno válido. */
export const CLOCK_SKEW_SECONDS = 60;

export interface JsonWebKey {
  readonly kid: string;
  readonly kty: 'RSA';
  readonly n: string;
  readonly e: string;
  readonly alg?: string;
  readonly use?: string;
}

export interface IdTokenClaims {
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly azp?: string;
  readonly sub: string;
  readonly tid?: string;
  readonly oid?: string;
  readonly exp: number;
  readonly iat: number;
  readonly nbf?: number;
  readonly nonce?: string;
  readonly amr?: readonly string[];
  readonly roles?: readonly string[];
  readonly groups?: readonly string[];
  readonly preferred_username?: string;
  readonly name?: string;
  readonly sid?: string;
}

export interface IdTokenPolicy {
  readonly issuer: string;
  readonly audience: string;
  readonly tenantId: string;
  /** Métodos aceptados; vacío significa "no se exige método concreto" (C-25 lo restringe). */
  readonly requiredAmr?: readonly string[];
}

export type IdTokenResult =
  | { readonly ok: true; readonly claims: IdTokenClaims }
  | { readonly ok: false; readonly code: IdTokenErrorCode; readonly detail?: string };

function fail(code: IdTokenErrorCode, detail?: string): IdTokenResult {
  return detail === undefined ? { ok: false, code } : { ok: false, code, detail };
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNumericDate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validClaims(value: unknown): value is IdTokenClaims {
  if (!isRecord(value)) return false;
  const audience = value.aud;
  const audienceValid =
    typeof audience === 'string' ||
    (Array.isArray(audience) && audience.length > 0 && isStringArray(audience));
  const optionalStrings = ['tid', 'oid', 'azp', 'nonce', 'preferred_username', 'name', 'sid'];
  const optionalStringArrays = ['amr', 'roles', 'groups'];
  return (
    typeof value.iss === 'string' &&
    typeof value.sub === 'string' &&
    value.sub.length > 0 &&
    audienceValid &&
    isNumericDate(value.exp) &&
    isNumericDate(value.iat) &&
    (value.nbf === undefined || isNumericDate(value.nbf)) &&
    optionalStrings.every((key) => value[key] === undefined || typeof value[key] === 'string') &&
    optionalStringArrays.every((key) => value[key] === undefined || isStringArray(value[key]))
  );
}

export function jwkToPublicKey(jwk: JsonWebKey): KeyObject {
  return createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
}

export function validateIdToken(
  token: string,
  jwks: readonly JsonWebKey[],
  policy: IdTokenPolicy,
  expectedNonce: string,
  now: Date,
): IdTokenResult {
  if (typeof token !== 'string') return fail('MALFORMED');
  const parts = token.split('.');
  if (parts.length !== 3) return fail('MALFORMED', 'El token no tiene tres segmentos.');
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let rawClaims: unknown;
  try {
    const decodedHeader = decodeSegment(headerPart);
    if (!isRecord(decodedHeader)) return fail('MALFORMED', 'La cabecera no es un objeto.');
    header = decodedHeader;
    rawClaims = decodeSegment(payloadPart);
  } catch {
    return fail('MALFORMED', 'Cabecera o carga no decodificables.');
  }
  if (typeof header.alg !== 'string' || !ALLOWED_ALGORITHMS.includes(header.alg as 'RS256')) {
    return fail('ALG_NOT_ALLOWED', typeof header.alg === 'string' ? header.alg : 'ausente');
  }
  if (!validClaims(rawClaims)) return fail('CLAIMS_MALFORMED');
  const claims = rawClaims;
  if (typeof header.kid !== 'string' || !header.kid) return fail('KEY_UNKNOWN', 'ausente');
  const jwk = jwks.find(
    (key) =>
      key.kid === header.kid &&
      key.kty === 'RSA' &&
      (key.alg === undefined || key.alg === 'RS256') &&
      (key.use === undefined || key.use === 'sig'),
  );
  if (!jwk) return fail('KEY_UNKNOWN', header.kid);
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerPart}.${payloadPart}`, 'ascii');
    verifier.end();
    if (!verifier.verify(jwkToPublicKey(jwk), Buffer.from(signaturePart, 'base64url'))) {
      return fail('SIGNATURE_INVALID');
    }
  } catch {
    return fail('KEY_UNKNOWN', 'La clave pública no es válida.');
  }
  if (claims.iss !== policy.issuer) return fail('ISSUER_MISMATCH', claims.iss);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(policy.audience)) return fail('AUDIENCE_MISMATCH', audiences.join(','));
  if (
    (audiences.length > 1 && claims.azp !== policy.audience) ||
    (claims.azp !== undefined && claims.azp !== policy.audience)
  ) {
    return fail('AZP_MISMATCH', claims.azp ?? 'ausente');
  }
  if (claims.tid !== policy.tenantId) return fail('TENANT_MISMATCH', claims.tid ?? 'ausente');
  const seconds = Math.floor(now.getTime() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS <= seconds) {
    return fail('EXPIRED');
  }
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > seconds) {
    return fail('NOT_YET_VALID');
  }
  if (typeof claims.iat !== 'number' || claims.iat - CLOCK_SKEW_SECONDS > seconds) {
    return fail('ISSUED_IN_FUTURE');
  }
  if (!claims.nonce || claims.nonce !== expectedNonce) return fail('NONCE_MISMATCH');
  if (!claims.sub) return fail('SUBJECT_MISSING');
  const required = policy.requiredAmr ?? [];
  if (required.length > 0 && !required.some((method) => (claims.amr ?? []).includes(method))) {
    return fail('AMR_NOT_ACCEPTED', (claims.amr ?? []).join(',') || 'ausente');
  }
  return { ok: true, claims };
}
