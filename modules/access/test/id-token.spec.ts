import { describe, expect, it } from 'vitest';

import { validateIdToken, type IdTokenPolicy } from '../src/id-token.js';
import {
  baseClaims,
  CLIENT_ID,
  createSigningIdentity,
  ISSUER,
  TENANT_ID,
} from './support/token-factory.js';

const NOW = new Date('2026-10-07T12:00:00.000Z');
const identity = createSigningIdentity();
const policy: IdTokenPolicy = { issuer: ISSUER, audience: CLIENT_ID, tenantId: TENANT_ID };

function validate(token: string, nonce = 'nonce-valido', withPolicy: IdTokenPolicy = policy) {
  return validateIdToken(token, identity.jwks, withPolicy, nonce, NOW);
}

describe('C-18 · validación del id_token', () => {
  it('acepta un token firmado por el tenant con todas las condiciones', () => {
    const result = validate(identity.sign(baseClaims(NOW)));

    expect(result.ok).toBe(true);
    expect(result.ok && result.claims.sub).toBe('subject-analyst-1');
  });

  it('rechaza una carga alterada después de firmar', () => {
    const result = validate(identity.sign(baseClaims(NOW), { tamperPayload: true }));

    expect(result).toMatchObject({ ok: false, code: 'SIGNATURE_INVALID' });
  });

  it('rechaza un algoritmo no permitido', () => {
    const result = validate(identity.sign(baseClaims(NOW), { alg: 'none' }));

    expect(result).toMatchObject({ ok: false, code: 'ALG_NOT_ALLOWED' });
  });

  it('rechaza un kid que no está en el JWKS del tenant', () => {
    const result = validate(identity.sign(baseClaims(NOW), { kid: 'clave-ajena' }));

    expect(result).toMatchObject({ ok: false, code: 'KEY_UNKNOWN' });
  });

  it('rechaza un token firmado por otra autoridad', () => {
    const otherAuthority = createSigningIdentity();
    const result = validateIdToken(
      otherAuthority.sign(baseClaims(NOW)),
      identity.jwks,
      policy,
      'nonce-valido',
      NOW,
    );

    expect(result).toMatchObject({ ok: false, code: 'SIGNATURE_INVALID' });
  });

  it('rechaza emisor, audiencia y tenant ajenos', () => {
    expect(validate(identity.sign(baseClaims(NOW, { iss: 'https://otro/v2.0' })))).toMatchObject({
      ok: false,
      code: 'ISSUER_MISMATCH',
    });
    expect(validate(identity.sign(baseClaims(NOW, { aud: 'otra-app' })))).toMatchObject({
      ok: false,
      code: 'AUDIENCE_MISMATCH',
    });
    expect(
      validate(identity.sign(baseClaims(NOW, { tid: '00000000-0000-4000-8000-000000000000' }))),
    ).toMatchObject({ ok: false, code: 'TENANT_MISMATCH' });
  });

  it('rechaza un token de otro tenant aunque la audiencia coincida', () => {
    const foreign = baseClaims(NOW, {
      iss: 'https://login.microsoftonline.com/otro-tenant/v2.0',
      tid: 'otro-tenant',
    });

    expect(validate(identity.sign(foreign))).toMatchObject({ ok: false, code: 'ISSUER_MISMATCH' });
  });

  it('acepta la audiencia cuando viene como arreglo que incluye la aplicación', () => {
    const result = validate(identity.sign(baseClaims(NOW, { aud: ['otra', CLIENT_ID] })));

    expect(result.ok).toBe(true);
  });

  it('rechaza por ventana temporal fuera de la tolerancia de reloj', () => {
    const seconds = Math.floor(NOW.getTime() / 1000);

    expect(validate(identity.sign(baseClaims(NOW, { exp: seconds - 120 })))).toMatchObject({
      ok: false,
      code: 'EXPIRED',
    });
    expect(validate(identity.sign(baseClaims(NOW, { nbf: seconds + 300 })))).toMatchObject({
      ok: false,
      code: 'NOT_YET_VALID',
    });
    expect(validate(identity.sign(baseClaims(NOW, { iat: seconds + 300 })))).toMatchObject({
      ok: false,
      code: 'ISSUED_IN_FUTURE',
    });
  });

  it('tolera un desfase de reloj menor al margen declarado', () => {
    const seconds = Math.floor(NOW.getTime() / 1000);

    expect(validate(identity.sign(baseClaims(NOW, { exp: seconds - 30 }))).ok).toBe(true);
  });

  it('exige que el nonce corresponda al handshake que inició el flujo', () => {
    expect(validate(identity.sign(baseClaims(NOW)), 'otro-nonce')).toMatchObject({
      ok: false,
      code: 'NONCE_MISMATCH',
    });
    expect(validate(identity.sign(baseClaims(NOW, { nonce: undefined })))).toMatchObject({
      ok: false,
      code: 'NONCE_MISMATCH',
    });
  });

  it('exige el método de autenticación cuando la política lo declara', () => {
    const passkeyPolicy: IdTokenPolicy = { ...policy, requiredAmr: ['fido', 'hwk'] };

    expect(validate(identity.sign(baseClaims(NOW)), 'nonce-valido', passkeyPolicy)).toMatchObject({
      ok: false,
      code: 'AMR_NOT_ACCEPTED',
    });
    expect(
      validate(identity.sign(baseClaims(NOW, { amr: ['fido'] })), 'nonce-valido', passkeyPolicy).ok,
    ).toBe(true);
  });

  it('rechaza un token que no tiene tres segmentos', () => {
    expect(validate('solo.dos')).toMatchObject({ ok: false, code: 'MALFORMED' });
  });
});
