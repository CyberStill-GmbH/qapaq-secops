import { describe, expect, it } from 'vitest';

import { ConfigurationError } from '../src/configuration.errors.js';
import { loadAccessConfig } from '../src/configuration-loader.js';

/** El mensaje es deliberadamente genérico; la variable afectada viaja en `path`. */
function rejectedPath(load: () => unknown): string {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigurationError) return error.path;
    throw error;
  }
  throw new Error('Se esperaba un ConfigurationError.');
}

const PRODUCTION = {
  QAPAQ_PROFILE: 'production',
  QAPAQ_ENTRA_TENANT_ID: '9f2a1c44-0000-4000-8000-0000000000aa',
  QAPAQ_ENTRA_CLIENT_ID: '11112222-3333-4444-5555-666677778888',
  QAPAQ_ENTRA_CLIENT_SECRET_REF: 'secret://entra/client-secret',
  QAPAQ_ENTRA_REDIRECT_URI: 'https://soc.qapaq.pe/api/auth/callback',
  QAPAQ_ENTRA_ALLOWED_REDIRECT_URIS: 'https://soc.qapaq.pe/api/auth/callback',
  QAPAQ_ACCESS_ALLOWED_CIDRS: '10.20.0.0/16',
  QAPAQ_ACCESS_TRUSTED_PROXY_CIDRS: '172.31.0.0/16',
  QAPAQ_CONSOLE_BASE_URL: 'https://soc.qapaq.pe',
} as const;

describe('C-18 · configuración de acceso', () => {
  it('deriva los endpoints de Entra a partir del tenant', () => {
    const config = loadAccessConfig(PRODUCTION);

    expect(config.issuer).toBe(
      `https://login.microsoftonline.com/${PRODUCTION.QAPAQ_ENTRA_TENANT_ID}/v2.0`,
    );
    expect(config.authorizationEndpoint).toContain('/oauth2/v2.0/authorize');
    expect(config.jwksUri).toContain('/discovery/v2.0/keys');
    expect(config.identityMode).toBe('entra');
  });

  it('rechaza el emisor local en producción', () => {
    expect(() =>
      loadAccessConfig({ ...PRODUCTION, QAPAQ_ACCESS_IDENTITY_MODE: 'local-development' }),
    ).toThrow(ConfigurationError);
  });

  it('exige el secreto del cliente cuando la identidad es Entra', () => {
    const { QAPAQ_ENTRA_CLIENT_SECRET_REF: _omitted, ...withoutSecret } = PRODUCTION;

    expect(rejectedPath(() => loadAccessConfig(withoutSecret))).toBe(
      'QAPAQ_ENTRA_CLIENT_SECRET_REF',
    );
  });

  it('exige que el redirect configurado esté en la lista aprobada', () => {
    expect(
      rejectedPath(() =>
        loadAccessConfig({
          ...PRODUCTION,
          QAPAQ_ENTRA_REDIRECT_URI: 'https://atacante.example/callback',
        }),
      ),
    ).toBe('QAPAQ_ENTRA_REDIRECT_URI');
  });

  it('rechaza transporte inseguro en producción y lo admite en desarrollo local', () => {
    expect(() =>
      loadAccessConfig({ ...PRODUCTION, QAPAQ_CONSOLE_BASE_URL: 'http://soc.qapaq.pe' }),
    ).toThrow(ConfigurationError);
    expect(
      loadAccessConfig({ QAPAQ_PROFILE: 'development' }).consoleBaseUrl.startsWith('http://'),
    ).toBe(true);
  });

  it('arranca en desarrollo con el emisor local y sin secreto de cliente', () => {
    const config = loadAccessConfig({ QAPAQ_PROFILE: 'development' });

    expect(config.identityMode).toBe('local-development');
    expect(config.clientSecretRef).toBeNull();
    expect(config.allowedCidrs).toContain('127.0.0.0/8');
  });

  it('rechaza un modo de identidad desconocido', () => {
    expect(
      rejectedPath(() =>
        loadAccessConfig({ ...PRODUCTION, QAPAQ_ACCESS_IDENTITY_MODE: 'anonimo' }),
      ),
    ).toBe('QAPAQ_ACCESS_IDENTITY_MODE');
  });

  it('exige listas de red no vacías', () => {
    expect(
      rejectedPath(() => loadAccessConfig({ ...PRODUCTION, QAPAQ_ACCESS_ALLOWED_CIDRS: '' })),
    ).toBe('QAPAQ_ACCESS_ALLOWED_CIDRS');
  });

  it('no expone material secreto: solo referencias', () => {
    const config = loadAccessConfig(PRODUCTION);

    expect(config.clientSecretRef).toBe('secret://entra/client-secret');
    expect(JSON.stringify(config)).not.toMatch(/password|clientSecret"/u);
  });
});
