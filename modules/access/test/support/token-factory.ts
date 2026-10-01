/**
 * Emisor de `id_token` para las specs: firma RS256 real con una clave efímera.
 *
 * No es un doble del validador. El token se firma de verdad y se publica un JWKS, de
 * modo que la spec ejercita la misma ruta criptográfica que correrá contra Entra; lo
 * único que no es real es quién posee la clave.
 */

import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

import type { IdTokenClaims, JsonWebKey } from '../../src/id-token.js';

export interface SigningIdentity {
  readonly jwks: readonly JsonWebKey[];
  readonly sign: (claims: Partial<IdTokenClaims>, overrides?: SignOverrides) => string;
  readonly privateKey: KeyObject;
}

export interface SignOverrides {
  readonly kid?: string;
  readonly alg?: string;
  readonly tamperPayload?: boolean;
}

export const TENANT_ID = '9f2a1c44-0000-4000-8000-0000000000aa';
export const CLIENT_ID = '11112222-3333-4444-5555-666677778888';
export const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function createSigningIdentity(kid = 'qapaq-test-key'): SigningIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const jwks: readonly JsonWebKey[] = [
    { kid, kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig' },
  ];
  const sign = (claims: Partial<IdTokenClaims>, overrides: SignOverrides = {}): string => {
    const header = { typ: 'JWT', alg: overrides.alg ?? 'RS256', kid: overrides.kid ?? kid };
    const payload = base64UrlJson(claims);
    const signingInput = `${base64UrlJson(header)}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput, 'ascii');
    signer.end();
    const signature = signer.sign(privateKey).toString('base64url');
    if (!overrides.tamperPayload) return `${signingInput}.${signature}`;
    // Firma válida sobre la carga original, carga alterada después: debe fallar la firma.
    const tampered = base64UrlJson({ ...claims, roles: ['qapaq.platform.admin'] });
    return `${base64UrlJson(header)}.${tampered}.${signature}`;
  };
  return { jwks, sign, privateKey };
}

export function baseClaims(now: Date, overrides: Partial<IdTokenClaims> = {}): IdTokenClaims {
  const seconds = Math.floor(now.getTime() / 1000);
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'subject-analyst-1',
    oid: '0a0a0a0a-0000-4000-8000-00000000000b',
    tid: TENANT_ID,
    iat: seconds,
    nbf: seconds,
    exp: seconds + 3600,
    nonce: 'nonce-valido',
    amr: ['pwd', 'mfa'],
    roles: ['qapaq.soc.analyst'],
    preferred_username: 'analista@qapaq.pe',
    sid: 'idp-session-1',
    ...overrides,
  };
}
