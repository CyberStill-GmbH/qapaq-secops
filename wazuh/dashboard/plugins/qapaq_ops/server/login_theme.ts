/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tema del login QAPAQ SecOps: negro #080808, tinta #f4f4f5, ámbar #c49a5a como único acento
 * y tipografía del sistema (docs/brand/qapaq-visual-identity.md). El panel de marca usa
 * `qapaq_login_hero.webp` (la ilustración original de la analista QAPAQ sobre fondo negro).
 * `__UI__` se sustituye por la ruta pública de los activos de marca.
 */
export const LOGIN_THEME = `:root{
  --qapaq-black:#080808;
  --qapaq-surface:#0d0d0f;
  --qapaq-raised:#131315;
  --qapaq-line:#29292d;
  --qapaq-line-strong:#49494e;
  --qapaq-ink:#f4f4f5;
  --qapaq-ink-soft:#b0b0b5;
  --qapaq-ink-muted:#8f8f95;
  --qapaq-amber:#c49a5a;
  --qapaq-amber-light:#e0bd80;
  --qapaq-danger:#ff5f57;
  --font-sans:'Segoe UI',Inter,ui-sans-serif,system-ui,sans-serif;
  color-scheme:dark;
}
*{box-sizing:border-box}
html,body{min-height:100%;margin:0}
body{background:var(--qapaq-black);color:var(--qapaq-ink);font-family:var(--font-sans);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
h1,h2,p{margin:0}
a{color:inherit}
img,svg{display:block;max-width:100%}
::selection{color:var(--qapaq-black);background:var(--qapaq-ink)}

.login-shell{display:grid;min-height:100vh;grid-template-columns:minmax(380px,540px) minmax(0,1fr)}

/* --- Columna del formulario --- */
.login-side{position:relative;display:flex;min-width:0;flex-direction:column;justify-content:space-between;gap:32px;padding:32px clamp(24px,5vw,64px);background:var(--qapaq-black);border-right:1px solid var(--qapaq-line)}
.login-brand{display:flex;align-items:center;gap:10px}
.brand-badge{display:block;width:42px;height:42px;object-fit:contain;border-radius:50%}
.brand-name{font-size:14px;font-weight:600;letter-spacing:3px;color:var(--qapaq-ink-soft)}
.login-destination{min-width:0;margin-left:auto;max-width:48%;overflow:hidden;color:var(--qapaq-ink-muted);font-size:12px;text-overflow:ellipsis;white-space:nowrap}

.login-core{width:100%;max-width:400px;margin:0 auto}
.login-core h1{font-size:clamp(26px,3.2vw,32px);font-weight:600;line-height:1.15;letter-spacing:-.5px}
.login-subtitle{margin-top:8px;color:var(--qapaq-ink-soft)}

.login-form{display:grid;gap:16px;margin-top:28px}
.field{display:grid;gap:6px}
.field label{font-size:13px;font-weight:600;color:var(--qapaq-ink-soft)}
.field input{width:100%;height:48px;padding:0 14px;border:1px solid var(--qapaq-line-strong);border-radius:8px;background:var(--qapaq-raised);color:var(--qapaq-ink);font:inherit;transition:border-color 140ms ease,box-shadow 140ms ease}
.field input::placeholder{color:#6f6f75}
.field input:hover{border-color:#6f6f75}
.field input:focus-visible{outline:none;border-color:var(--qapaq-amber);box-shadow:0 0 0 3px rgb(196 154 90 / 24%)}
.password-field{position:relative}
.password-field input{padding-right:48px}
.password-toggle{position:absolute;top:50%;right:6px;display:grid;width:36px;height:36px;place-items:center;padding:0;border:0;border-radius:6px;background:transparent;color:var(--qapaq-ink-soft);cursor:pointer;transform:translateY(-50%)}
.password-toggle:hover{background:var(--qapaq-surface);color:var(--qapaq-ink)}
.password-toggle:focus-visible{outline:2px solid var(--qapaq-ink);outline-offset:1px}
.password-toggle svg{width:20px;height:20px}

.btn{display:flex;width:100%;height:50px;align-items:center;justify-content:center;gap:10px;border:0;border-radius:8px;font:inherit;font-size:15px;font-weight:600;text-decoration:none;cursor:pointer;transition:transform 140ms ease,background-color 140ms ease,border-color 140ms ease,opacity 140ms ease}
.btn:focus-visible{outline:2px solid var(--qapaq-ink);outline-offset:3px}
.btn[aria-disabled="true"],.btn:disabled{cursor:progress;opacity:.7;pointer-events:none}
.btn-primary{background:var(--qapaq-ink);color:var(--qapaq-black)}
.btn-primary:hover{background:#ffffff;transform:translateY(-1px)}
.btn-primary:active{transform:translateY(0)}
.btn-entra{border:1px solid var(--qapaq-line-strong);background:var(--qapaq-surface);color:var(--qapaq-ink)}
.btn-entra:hover{border-color:var(--qapaq-amber);background:var(--qapaq-raised)}
.microsoft-mark{width:18px;height:18px}

.login-divider{display:flex;align-items:center;gap:14px;margin:22px 0;color:var(--qapaq-ink-muted);font-size:12px;text-transform:uppercase;letter-spacing:1.5px}
.login-divider::before,.login-divider::after{height:1px;flex:1;background:var(--qapaq-line);content:''}
.login-only-entra{margin-top:28px}

.auth-message{min-height:20px;margin-top:16px;color:var(--qapaq-ink-soft);font-size:13px}
.auth-message-error{padding:10px 12px;border:1px solid rgb(255 95 87 / 45%);border-radius:8px;background:rgb(255 95 87 / 10%);color:#ffb0ab;font-weight:600}

.auth-footer{max-width:400px;margin:0 auto;color:var(--qapaq-ink-muted);font-size:12px}
.auth-footer span{display:block}
.auth-footer .auth-attribution{margin-top:2px;color:#6f6f75;font-size:11px}

/* --- Panel de marca: la ilustración es el fondo --- */
/* La ilustración ya viene sobre negro QAPAQ con la luz ámbar; el degradado funde su borde
   izquierdo con la columna del formulario. */
.login-hero{position:relative;min-height:320px;overflow:hidden;background:url(__UI__/qapaq_login_hero.webp) 70% center/cover no-repeat,var(--qapaq-black)}
.login-hero::before{position:absolute;inset:0 auto 0 0;width:clamp(96px,22%,280px);background:linear-gradient(90deg,var(--qapaq-black) 0%,rgb(8 8 8 / 70%) 40%,rgb(8 8 8 / 0%) 100%);content:'';pointer-events:none}

/* Tablet y celular: una sola columna, solo el formulario. */
@media (max-width:1000px){
  .login-shell{grid-template-columns:minmax(0,1fr)}
  .login-hero{display:none}
  .login-side{padding:28px 24px 32px;border-right:0}
}
@media (max-width:600px){
  .login-destination{display:none}
}
.qapaqLoginSplash{position:fixed;inset:0;z-index:100000;display:grid;place-items:center;background:var(--qapaq-black);pointer-events:none;animation:qapaqLoginSplashOut 1600ms ease-out forwards}
.qapaqLoginSplash img{width:min(28vh,180px);max-width:70vw;height:auto}
@keyframes qapaqLoginSplashOut{0%,75%{opacity:1;visibility:visible}100%{opacity:0;visibility:hidden}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}.qapaqLoginSplash{display:none}}
`;
