/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import {
  loginContentSecurityPolicy,
  readSignInNotice,
  renderLoginPage,
  renderLogoutPage,
  rawNextUrl,
  safeNextUrl,
} from './login_page';
import { ATTRIBUTION } from '../common';

const FALLBACK = '/app/qapaq-alerts';
const CORRELATION = '3f2b6c1e-8d4a-4f0e-9a51-2c7d8e9f0a1b';

describe('safeNextUrl', () => {
  it.each([
    ['//evil.example/app', FALLBACK],
    ['https://evil.example/', FALLBACK],
    ['/\\evil.example', FALLBACK],
    ['/app/home\u0000', FALLBACK],
    ['app/home', FALLBACK],
    ['/api/auth/start', FALLBACK],
    ['/api', FALLBACK],
    ['/qapaq/login', FALLBACK],
    ['', FALLBACK],
    [`/${'a'.repeat(600)}`, FALLBACK],
  ])('rechaza %p', (value, expected) => {
    expect(safeNextUrl(value, FALLBACK)).toBe(expected);
  });

  it('conserva ruta, query y hash relativos del mismo origen', () => {
    expect(safeNextUrl('/app/discover?x=1#/view', FALLBACK)).toBe('/app/discover?x=1#/view');
  });

  it('respeta un apiPrefix distinto', () => {
    expect(safeNextUrl('/qapaq-api/alerts', FALLBACK, '/qapaq-api')).toBe(FALLBACK);
    expect(safeNextUrl('/api/status', FALLBACK, '/qapaq-api')).toBe('/api/status');
  });
});

describe('rawNextUrl', () => {
  it('toma en crudo todo lo que sigue a nextUrl (redirect de nginx con $request_uri)', () => {
    expect(rawNextUrl('?loggedOut=1&nextUrl=/app/discover?_g=(a:1)&x=2')).toBe(
      '/app/discover?_g=(a:1)&x=2',
    );
  });

  it('decodifica si el destino venía codificado', () => {
    expect(rawNextUrl('?nextUrl=%2Fapp%2Fhome%3Fx%3D1')).toBe('/app/home?x=1');
  });

  it('sin nextUrl o con codificación rota no devuelve destino', () => {
    expect(rawNextUrl('?authError=AUTH_FAILED')).toBeUndefined();
    expect(rawNextUrl('?nextUrl=%2F%E0%A4%A')).toBeUndefined();
  });
});

describe('readSignInNotice', () => {
  it('lee el error del BFF dentro de nextUrl y lo limpia del destino', () => {
    const { nextUrl, notice } = readSignInNotice(
      { nextUrl: `/app/discover?authError=PASSKEY_REQUIRED&correlationId=${CORRELATION}#/` },
      FALLBACK,
    );
    expect(nextUrl).toBe('/app/discover#/');
    expect(notice).toMatchObject({ code: 'PASSKEY_REQUIRED', correlationId: CORRELATION });
  });

  it('ignora códigos fuera del catálogo y referencias que no son UUID', () => {
    const { notice } = readSignInNotice({ authError: '<script>', correlationId: 'x"y' }, FALLBACK);
    expect(notice.code).toBeNull();
    expect(notice.correlationId).toBeNull();
  });

  it('informa la sesión reemplazada y el cierre de sesión', () => {
    expect(readSignInNotice({ sessionNotice: 'superseded' }, FALLBACK).notice.superseded).toBe(
      true,
    );
    expect(readSignInNotice({ loggedOut: '1' }, FALLBACK).notice.loggedOut).toBe(true);
  });
});

describe('renderLoginPage', () => {
  const base = {
    basePath: '/dash',
    apiPrefix: '/api',
    nonce: 'abc123',
    destinationLabel: 'QAPAQ SOC',
  };

  const clean = { code: null, correlationId: null, superseded: false, loggedOut: false };

  it('ofrece Entra con el destino codificado y el formulario de usuario y contraseña', () => {
    const html = renderLoginPage({ ...base, nextUrl: '/dash/app/home?x=1', notice: clean });
    expect(html).toContain('href="/api/auth/start?returnTo=%2Fdash%2Fapp%2Fhome%3Fx%3D1"');
    expect(html).toContain('Continuar con Microsoft Entra');
    expect(html).toContain('<form id="qapaq-password-form"');
    expect(html).toContain('method="post" action="/api/auth/password"');
    expect(html).toContain('name="username"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('name="returnTo" value="/dash/app/home?x=1"');
    // El destino viaja codificado en la URL de Entra y escapado en el campo oculto.
    expect(html).toContain('Bienvenido a QAPAQ SOC');
  });

  it('la contraseña nunca se escribe en la página ni viaja por la URL', () => {
    const html = renderLoginPage({ ...base, nextUrl: '/dash/app/home', notice: clean });
    expect(html).toMatch(/<input id="qapaq-password" name="password" type="password"/u);
    expect(html).not.toMatch(/action="[^"]*\?/u);
    expect(html).toContain('method="post"');
  });

  it('con passwordEnabled=false solo queda el acceso con Entra', () => {
    const html = renderLoginPage({
      ...base,
      passwordEnabled: false,
      nextUrl: '/dash/app/home',
      notice: clean,
    });
    expect(html).not.toContain('qapaq-password-form');
    expect(html).not.toContain('name="password"');
    expect(html).toContain('Continuar con Microsoft Entra');
  });

  it('con entraEnabled=false solo queda usuario y contraseña, sin enlace a /auth/start', () => {
    const html = renderLoginPage({
      ...base,
      entraEnabled: false,
      nextUrl: '/dash/app/home',
      notice: clean,
    });
    expect(html).toContain('qapaq-password-form');
    expect(html).not.toContain('Microsoft Entra');
    expect(html).not.toContain('/auth/start');
    expect(html).not.toContain('role="separator"');
  });

  it('nunca deja la pantalla sin forma de entrar', () => {
    const html = renderLoginPage({
      ...base,
      entraEnabled: false,
      passwordEnabled: false,
      nextUrl: '/dash/app/home',
      notice: clean,
    });
    expect(html).toContain('qapaq-password-form');
  });

  it('cumple la CSP: solo script y estilos con nonce y nada inline', () => {
    const html = renderLoginPage({ ...base, nextUrl: '/dash/app/home', notice: clean });
    expect(html).toContain(ATTRIBUTION);
    expect(html.split(ATTRIBUTION).join('')).not.toMatch(/wazuh|opensearch/iu);
    expect(html).toContain('<style nonce="abc123">');
    expect(html).toContain('<script nonce="abc123">');
    expect(html).not.toMatch(/<script(?![^>]*nonce="abc123")/u);
    expect(html).not.toMatch(/ style="/u);
  });

  it('carga Satoshi desde la ruta pública de los activos de marca', () => {
    const html = renderLoginPage({ ...base, nextUrl: '/dash/app/home', notice: clean });
    expect(html).toContain('href="/dash/ui/qapaq/fonts/satoshi.css"');
    expect(html).toContain("'Satoshi'");
  });

  it('usa la ilustración y la paleta de marca', () => {
    const html = renderLoginPage({ ...base, nextUrl: '/dash/app/home', notice: clean });
    expect(html).toContain('/dash/ui/qapaq/qapaq_login_hero.webp');
    expect(html).not.toContain('qapaq_login_hero_sm.webp');
    expect(html).toContain('.login-hero{display:none}');
    expect(html).toContain('#ff5899');
    expect(html).toContain('#ffc136');
  });

  it('muestra el mensaje público del catálogo como alerta, nunca el código crudo', () => {
    const html = renderLoginPage({
      ...base,
      nextUrl: '/dash/app/home',
      notice: {
        code: 'AUTH_FAILED',
        correlationId: CORRELATION,
        superseded: false,
        loggedOut: false,
      },
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('No fue posible iniciar sesión con esas credenciales.');
    expect(html).toContain(`Referencia: ${CORRELATION}`);
    expect(html).not.toContain('AUTH_FAILED');
  });

  it('escapa la etiqueta de destino configurada', () => {
    const html = renderLoginPage({
      ...base,
      destinationLabel: '<img src=x onerror=alert(1)>',
      nextUrl: '/dash/app/home',
      notice: { code: null, correlationId: null, superseded: false, loggedOut: false },
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('aviso de cookies', () => {
  const html = renderLoginPage({
    basePath: '',
    apiPrefix: '/api',
    nonce: 'n',
    destinationLabel: 'QAPAQ SOC',
    nextUrl: '/app/home',
    notice: { code: null, correlationId: null, superseded: false, loggedOut: false },
  });

  it('es una barra inferior con aceptar y cierre (×) accesible', () => {
    expect(html).toContain('class="qapaq-cookie-notice qapaq-cookie-bar"');
    expect(html).toContain('aria-label="Cerrar aviso de cookies"');
    expect(html).toContain('Aceptar cookies necesarias');
  });

  it('empieza oculta (sin JS no tapa el login) y sale con transición', () => {
    expect(html).toMatch(/id="qapaq-cookie-notice"[^>]*hidden/u);
    expect(html).toContain('.qapaq-cookie-bar.is-leaving{transform:translateY(100%)');
    expect(html).toContain('prefers-reduced-motion:reduce');
  });

  it('recuerda el reconocimiento con la misma clave que qapaq-secops', () => {
    expect(html).toContain('"qapaq.cookie-notice.technical.v1"');
  });
});

describe('CSP y logout', () => {
  it('el login solo ejecuta su script con nonce', () => {
    const csp = loginContentSecurityPolicy('n1');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-n1'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('el logout envía el token CSRF de la sesión y vuelve al login QAPAQ', () => {
    const html = renderLogoutPage({ basePath: '', apiPrefix: '/api', nonce: 'n2' });
    expect(html).toContain('<script nonce="n2">');
    expect(html).toContain("'x-csrf-token'");
    expect(html).toContain('/qapaq/login?loggedOut=1');
  });
});
