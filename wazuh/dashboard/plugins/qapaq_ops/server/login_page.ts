/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

/**
 * Login QAPAQ SecOps servido por el dashboard (sustituye al formulario de Wazuh).
 *
 * Es la misma pantalla de `qapaq-secops/apps/web` (login.css + HeroArt), renderizada en el
 * servidor: el único control es un enlace a `/api/auth/start` (funciona sin JavaScript), que lleva
 * a Microsoft Entra ID por el BFF de QAPAQ (PKCE, nonce, admisión Accesos_SOC, MFA/passkey).
 * El dashboard nunca ve credenciales ni tokens.
 */

import {
  API_ERROR_CODES,
  API_ERROR_MESSAGE,
  ApiErrorCode,
  ATTRIBUTION,
  BRAND_ASSETS_PATH,
  LOGIN_PATH,
} from '../common';
import { LOGIN_STYLES } from './login_styles.generated';

const MAX_NEXT_URL_LENGTH = 512;
const PROBE_ORIGIN = 'https://next-url.qapaq.invalid';

/**
 * Mismas reglas que `safeReturnTo` del BFF: solo rutas relativas del mismo origen; nada de
 * `//host`, barras invertidas, caracteres de control ni rutas de la API. Evita el *open
 * redirect* clásico en `nextUrl`.
 */
export function safeNextUrl(value: unknown, fallback: string, apiPrefix = '/api'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NEXT_URL_LENGTH) {
    return fallback;
  }
  const hasControl = [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || hasControl) {
    return fallback;
  }
  let url: URL;
  try {
    url = new URL(value, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PROBE_ORIGIN) return fallback;
  if (url.pathname === apiPrefix || url.pathname.startsWith(`${apiPrefix}/`)) return fallback;
  if (url.pathname.startsWith('/qapaq/')) return fallback; // nunca volver al propio login
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * `nextUrl` tal como lo pone el proxy (`/qapaq/login?nextUrl=$request_uri`): nginx no puede
 * codificarlo, así que es el último parámetro y llega en crudo, con sus propios `?` y `&`.
 * Se toma todo lo que sigue a `nextUrl=`; si venía codificado, se decodifica. El resultado
 * pasa igualmente por `safeNextUrl`.
 */
export function rawNextUrl(search: string): string | undefined {
  const marker = search.search(/[?&]nextUrl=/u);
  if (marker === -1) return undefined;
  const raw = search.slice(search.indexOf('=', marker) + 1);
  if (!raw.startsWith('%2F') && !raw.startsWith('%2f')) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

export interface SignInNotice {
  readonly code: ApiErrorCode | null;
  readonly correlationId: string | null;
  readonly superseded: boolean;
  readonly loggedOut: boolean;
}

const CORRELATION_PATTERN = /^[0-9a-f-]{36}$/u;

function isApiErrorCode(value: string | null): value is ApiErrorCode {
  return value !== null && (API_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * El BFF devuelve los fallos al `returnTo` con `?authError=&correlationId=`; el proxy, al no
 * haber sesión, reenvía esa URL aquí como `nextUrl`. Se leen ambos sitios y se limpian del
 * destino para no repetir el error tras un acceso correcto.
 */
export function readSignInNotice(
  query: Record<string, unknown>,
  fallback: string,
  apiPrefix = '/api',
): { readonly nextUrl: string; readonly notice: SignInNotice } {
  const nextUrl = safeNextUrl(query.nextUrl, fallback, apiPrefix);
  const next = new URL(nextUrl, PROBE_ORIGIN);
  const pick = (name: string): string | null => {
    const own = query[name];
    if (typeof own === 'string') return own;
    return next.searchParams.get(name);
  };
  const code = pick('authError');
  const correlationId = pick('correlationId');
  const superseded = pick('sessionNotice') === 'superseded';
  for (const name of ['authError', 'correlationId', 'sessionNotice'])
    next.searchParams.delete(name);
  return {
    nextUrl: `${next.pathname}${next.search}${next.hash}`,
    notice: {
      code: isApiErrorCode(code) ? code : null,
      correlationId:
        correlationId && CORRELATION_PATTERN.test(correlationId) ? correlationId : null,
      superseded,
      loggedOut: query.loggedOut === '1',
    },
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

export interface LoginPageOptions {
  readonly basePath: string;
  readonly apiPrefix: string;
  readonly nextUrl: string;
  readonly notice: SignInNotice;
  readonly nonce: string;
  readonly destinationLabel: string;
}

/**
 * CSP del login: un único script inline con nonce (estado «Conectando…» y aviso de cookies),
 * estilos con el mismo nonce e imágenes propias más el grano `data:` del panel de marca.
 */
export function loginContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

function message(notice: SignInNotice): { readonly text: string; readonly alert: boolean } {
  if (notice.code) {
    const reference = notice.correlationId ? ` Referencia: ${notice.correlationId}.` : '';
    return { text: `${API_ERROR_MESSAGE[notice.code]}${reference}`, alert: true };
  }
  if (notice.superseded) {
    return {
      text: 'Tu sesión se cerró porque iniciaste sesión en otro dispositivo.',
      alert: false,
    };
  }
  if (notice.loggedOut) return { text: 'Sesión cerrada.', alert: false };
  return { text: 'Usa tu cuenta institucional para continuar.', alert: false };
}

const MICROSOFT_MARK =
  '<svg aria-hidden="true" class="microsoft-mark" viewBox="0 0 18 18">' +
  '<path fill="#f25022" d="M0 0h8v8H0z"/><path fill="#7fba00" d="M10 0h8v8h-8z"/>' +
  '<path fill="#00a4ef" d="M0 10h8v8H0z"/><path fill="#ffb900" d="M10 10h8v8h-8z"/></svg>';

/** Icono Cookie (Phosphor, duotone) del aviso de cookies de qapaq-secops. */
const COOKIE_ICON =
  '<svg aria-hidden="true" viewBox="0 0 256 256" fill="currentColor">' +
  '<path opacity="0.2" d="M224,128a96,96,0,1,1-96-96,48,48,0,0,0,48,48A48,48,0,0,0,224,128Z"/>' +
  '<path d="M164.49,163.51a12,12,0,1,1-17,0A12,12,0,0,1,164.49,163.51Zm-81-8a12,12,0,1,0,17,0A12,12,0,0,0,83.51,155.51Zm9-39a12,12,0,1,0-17,0A12,12,0,0,0,92.49,116.49Zm48-1a12,12,0,1,0,0,17A12,12,0,0,0,140.49,115.51ZM232,128A104,104,0,1,1,128,24a8,8,0,0,1,8,8,40,40,0,0,0,40,40,8,8,0,0,1,8,8,40,40,0,0,0,40,40A8,8,0,0,1,232,128Zm-16.31,7.39A56.13,56.13,0,0,1,168.5,87.5a56.13,56.13,0,0,1-47.89-47.19,88,88,0,1,0,95.08,95.08Z"/></svg>';

const CLOSE_ICON =
  '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

/** Clave de reconocimiento del aviso; la misma que `CookieNotice.tsx` de qapaq-secops. */
const COOKIE_ACK_KEY = 'qapaq.cookie-notice.technical.v1';

/**
 * Aviso de cookies como barra inferior a lo ancho (formato clásico), con «Aceptar» y cierre
 * (×). Solo hay cookies técnicas necesarias, así que cerrar equivale a darse por enterado.
 * Entra y sale deslizándose; sin movimiento con `prefers-reduced-motion`.
 */
const COOKIE_BAR_CSS = `
.auth-footer span{display:block}
.auth-footer .auth-attribution{margin-top:2px;color:#6f6f75;font-size:11px}
.qapaq-cookie-notice.qapaq-cookie-bar{position:fixed;z-index:110;right:0;bottom:0;left:0;display:flex;width:100%;max-width:none;align-items:center;gap:16px;
padding:14px max(24px,env(safe-area-inset-right)) calc(14px + env(safe-area-inset-bottom)) max(24px,env(safe-area-inset-left));
border:0;border-top:1px solid #29292d;border-radius:0;background:#0d0d0f;box-shadow:0 -8px 24px rgb(0 0 0 / 45%);
transform:translateY(100%);opacity:0;transition:transform 320ms cubic-bezier(0.16,1,0.3,1),opacity 220ms ease}
.qapaq-cookie-bar.is-visible{transform:translateY(0);opacity:1}
.qapaq-cookie-bar.is-leaving{transform:translateY(100%);opacity:0;transition:transform 280ms cubic-bezier(0.4,0,1,1),opacity 240ms ease}
.qapaq-cookie-bar .qapaq-cookie-notice__mark{flex:0 0 auto}
.qapaq-cookie-bar .qapaq-cookie-notice__content{display:flex;min-width:0;flex:1 1 auto;align-items:center;gap:8px 24px;flex-wrap:wrap}
.qapaq-cookie-bar .qapaq-cookie-notice__text{min-width:0;flex:1 1 420px}
.qapaq-cookie-bar .qapaq-cookie-notice__content p{margin:2px 0 0}
.qapaq-cookie-bar .qapaq-cookie-notice__content details{margin:4px 0 0}
.qapaq-cookie-bar .qapaq-cookie-notice__actions{display:flex;flex:0 0 auto;align-items:center;gap:8px}
.qapaq-cookie-bar .qapaq-cookie-notice__content .qapaq-cookie-accept{border-radius:999px;padding:0 16px}
.qapaq-cookie-bar .qapaq-cookie-close{display:grid;width:38px;height:38px;flex:0 0 auto;place-items:center;padding:0;border:1px solid #49494e;border-radius:999px;background:transparent;color:#b0b0b5;cursor:pointer;transition:border-color 160ms ease,color 160ms ease,background-color 160ms ease}
.qapaq-cookie-bar .qapaq-cookie-close:hover{border-color:#85858b;background:#131315;color:#f4f4f5}
.qapaq-cookie-bar .qapaq-cookie-close:focus-visible{outline:2px solid #f5f5f5;outline-offset:3px}
.qapaq-cookie-bar .qapaq-cookie-close svg{width:14px;height:14px}
@media (max-width:600px){
.qapaq-cookie-notice.qapaq-cookie-bar{align-items:flex-start;gap:10px;padding:12px 12px calc(12px + env(safe-area-inset-bottom))}
.qapaq-cookie-bar .qapaq-cookie-notice__actions{width:100%}
.qapaq-cookie-bar .qapaq-cookie-notice__content .qapaq-cookie-accept{flex:1;min-height:44px}
.qapaq-cookie-bar .qapaq-cookie-close{position:absolute;top:8px;right:8px;width:44px;height:44px;border-color:transparent}
.qapaq-cookie-bar .qapaq-cookie-notice__text{padding-right:40px}
}
@media (prefers-reduced-motion:reduce){.qapaq-cookie-notice.qapaq-cookie-bar,.qapaq-cookie-bar.is-leaving{transition:none}}
`;

function loginScript(): string {
  return `(function () {
  var link = document.getElementById('qapaq-entra');
  var label = document.getElementById('qapaq-entra-label');
  var status = document.getElementById('qapaq-auth-message');
  link.addEventListener('click', function () {
    link.setAttribute('aria-disabled', 'true');
    label.textContent = 'Conectando con Microsoft Entra…';
    if (status.getAttribute('role') !== 'alert') status.textContent = 'Conectando de forma segura…';
  });

  var key = ${JSON.stringify(COOKIE_ACK_KEY)};
  var bar = document.getElementById('qapaq-cookie-notice');
  var accepted = false;
  try { accepted = window.localStorage.getItem(key) === 'accepted'; } catch (e) {}
  if (accepted) { bar.remove(); return; }
  bar.hidden = false;
  requestAnimationFrame(function () { requestAnimationFrame(function () { bar.classList.add('is-visible'); }); });
  var closed = false;
  function dismiss() {
    if (closed) return;
    closed = true;
    try { window.localStorage.setItem(key, 'accepted'); } catch (e) {}
    bar.classList.remove('is-visible');
    bar.classList.add('is-leaving');
    var done = function () { if (bar.parentNode) bar.remove(); };
    bar.addEventListener('transitionend', done, { once: true });
    window.setTimeout(done, 400);
  }
  document.getElementById('qapaq-cookie-accept').addEventListener('click', dismiss);
  document.getElementById('qapaq-cookie-close').addEventListener('click', dismiss);
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') dismiss(); });
})();`;
}

/**
 * Misma maqueta que `apps/web/src/app/application.tsx` (pantalla de acceso), `HeroArt.tsx`
 * (panel de marca) y `QapaqSplash.tsx` (splash de la Q). Estilos: login_styles.generated.ts,
 * sincronizado verbatim desde qapaq-secops.
 */
export function renderLoginPage(options: LoginPageOptions): string {
  const { basePath, apiPrefix, nextUrl, notice, nonce, destinationLabel } = options;
  const start = `${apiPrefix}/auth/start?returnTo=${encodeURIComponent(nextUrl)}`;
  const status = message(notice);
  const ui = `${basePath}/ui`;
  const brand = `${basePath}${BRAND_ASSETS_PATH}`;
  const css = LOGIN_STYLES.split('__UI__').join(brand) + COOKIE_BAR_CSS;
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#080808">
<meta name="referrer" content="no-referrer">
<link rel="icon" type="image/png" sizes="32x32" href="${ui}/favicons/favicon-32x32.png">
<link rel="apple-touch-icon" sizes="180x180" href="${ui}/favicons/apple-touch-icon.png">
<link rel="manifest" href="${ui}/favicons/manifest.json">
<title>Iniciar sesión · QAPAQ SecOps</title>
<style nonce="${nonce}">${css}</style>
</head>
<body>
<div class="auth-splash" aria-hidden="true"><span class="auth-splash-mark"></span></div>
<main class="auth-screen">
  <header class="auth-topbar">
    <span class="brand-destination">Estás iniciando sesión en ${escapeHtml(destinationLabel)}</span>
  </header>
  <section class="login-core" aria-labelledby="login-title">
    <h1 id="login-title">Inicia sesión en tu cuenta</h1>
    <p class="login-subtitle">Acceso institucional</p>
    <div class="login-action-group">
      <a id="qapaq-entra" class="entra-button entra-button-enabled" href="${escapeHtml(start)}">${MICROSOFT_MARK}<span id="qapaq-entra-label">Continuar con Microsoft Entra</span></a>
      <p id="qapaq-auth-message" class="auth-message${status.alert ? ' auth-message-error' : ''}" role="${
        status.alert ? 'alert' : 'status'
      }">${escapeHtml(status.text)}</p>
    </div>
  </section>
  <footer class="auth-footer">
    <span>El acceso requiere una identidad corporativa autorizada.</span>
    <span class="auth-attribution">${escapeHtml(ATTRIBUTION)}</span>
  </footer>
  <aside class="brand-panel" aria-label="Identidad visual QAPAQ">
    <div class="login-light-amber hero-light-amber" aria-hidden="true"></div>
    <div class="login-light-core hero-light-core" aria-hidden="true"></div>
    <div class="hero-fade" aria-hidden="true"></div>
    <div class="hero-grain" aria-hidden="true"></div>
    <img class="hero-analyst" src="${brand}/qapaq_analyst.webp" alt="" aria-hidden="true">
    <svg class="login-glass-mark" viewBox="0 0 447 447" role="img" aria-label="Emblema Q de QAPAQ">
      <defs>
        <linearGradient id="qapaq-glass-fill" x1="0%" y1="52%" x2="100%" y2="45%">
          <stop offset="0%" stop-color="#d8dce0" stop-opacity="0.035"/>
          <stop offset="42%" stop-color="#d8dce0" stop-opacity="0.06"/>
          <stop offset="72%" stop-color="#f2dcb7" stop-opacity="0.13"/>
          <stop offset="100%" stop-color="#fff0d1" stop-opacity="0.19"/>
        </linearGradient>
        <linearGradient id="qapaq-glass-reflection" x1="24%" y1="100%" x2="82%" y2="0%">
          <stop offset="0%" stop-color="#fff8e9" stop-opacity="0"/>
          <stop offset="54%" stop-color="#fff8e9" stop-opacity="0"/>
          <stop offset="61%" stop-color="#fff8e9" stop-opacity="0.035"/>
          <stop offset="65%" stop-color="#fff8e9" stop-opacity="0.15"/>
          <stop offset="69%" stop-color="#fff8e9" stop-opacity="0.055"/>
          <stop offset="75%" stop-color="#fff8e9" stop-opacity="0"/>
          <stop offset="100%" stop-color="#fff8e9" stop-opacity="0"/>
        </linearGradient>
        <mask id="qapaq-q-shape" x="0" y="0" width="447" height="447" maskUnits="userSpaceOnUse" mask-type="alpha">
          <image href="${brand}/qapaq_q_mask.png" width="447" height="447" preserveAspectRatio="none"/>
        </mask>
      </defs>
      <rect width="447" height="447" fill="url(#qapaq-glass-fill)" mask="url(#qapaq-q-shape)"/>
      <rect width="447" height="447" fill="url(#qapaq-glass-reflection)" mask="url(#qapaq-q-shape)"/>
    </svg>
  </aside>
</main>
<aside id="qapaq-cookie-notice" class="qapaq-cookie-notice qapaq-cookie-bar" aria-labelledby="cookie-notice-title" hidden>
  <div class="qapaq-cookie-notice__mark" aria-hidden="true">${COOKIE_ICON}</div>
  <div class="qapaq-cookie-notice__content">
    <div class="qapaq-cookie-notice__text">
      <h2 id="cookie-notice-title">Cookies necesarias</h2>
      <p>QAPAQ usa cookies técnicas para mantener tu sesión institucional y proteger el inicio de sesión.</p>
      <details>
        <summary>Ver para qué se usan</summary>
        <ul>
          <li><code>qapaq_session</code>: mantiene la sesión autenticada.</li>
          <li><code>qapaq_oidc_flow_…</code>: vincula temporalmente el inicio de sesión con este navegador.</li>
        </ul>
      </details>
    </div>
    <div class="qapaq-cookie-notice__actions">
      <button id="qapaq-cookie-accept" class="qapaq-cookie-accept" type="button">Aceptar cookies necesarias</button>
    </div>
  </div>
  <button id="qapaq-cookie-close" class="qapaq-cookie-close" type="button" aria-label="Cerrar aviso de cookies">${CLOSE_ICON}</button>
</aside>
<script nonce="${nonce}">${loginScript()}</script>
</body>
</html>`;
}

export interface LogoutPageOptions {
  readonly basePath: string;
  readonly apiPrefix: string;
  readonly nonce: string;
}

/** CSP del cierre de sesión: un único script inline identificado por nonce. */
export function logoutContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/**
 * Cierre de sesión: el BFF exige el token CSRF de la sesión para cerrarla (otro sitio no
 * puede expulsar a la persona), así que se obtiene de `/auth/session` y se envía en
 * `x-csrf-token`. Sin sesión vigente, el BFF limpia la cookie igualmente.
 */
export function renderLogoutPage({ basePath, apiPrefix, nonce }: LogoutPageOptions): string {
  const login = `${basePath}${LOGIN_PATH}?loggedOut=1`;
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Cerrando sesión · QAPAQ SecOps</title>
<style nonce="${nonce}">html,body{margin:0;height:100%;background:#080808;color:#8f8f95;font:13px/20px 'Segoe UI',Inter,ui-sans-serif,system-ui,sans-serif}main{display:grid;height:100%;place-items:center}</style>
</head>
<body>
<main><p role="status">Cerrando sesión…</p></main>
<script nonce="${nonce}">
(function () {
  var api = ${JSON.stringify(apiPrefix)};
  var done = function () { window.location.replace(${JSON.stringify(login)}); };
  fetch(api + '/auth/session', { credentials: 'same-origin', headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (s) {
      return fetch(api + '/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: s && s.csrfToken ? { 'x-csrf-token': s.csrfToken } : {}
      });
    })
    .then(done, done);
})();
</script>
</body>
</html>`;
}
