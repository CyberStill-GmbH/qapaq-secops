/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tema del login QAPAQ SOC con la paleta oficial; el panel de marca usa la ilustración
 * `qapaq_login_hero.webp`. `__UI__` se sustituye por la ruta pública de los activos de marca.
 */
export const LOGIN_THEME = `:root{
  --qapaq-pink:#ff5899;
  --qapaq-rose:#ff5841;
  --qapaq-coral:#ff5841;
  --qapaq-orange:#ffc136;
  --qapaq-blue:#119cff;
  --qapaq-lime:#d0e870;
  --qapaq-ink:#1b1220;
  --qapaq-ink-soft:#5d5266;
  --qapaq-line:#eadfe6;
  --qapaq-surface:#ffffff;
  --qapaq-bg:#fff7f9;
  --qapaq-danger:#b0123f;
  --font-sans:'Satoshi',ui-sans-serif,system-ui,sans-serif;
  color-scheme:light;
}
*{box-sizing:border-box}
html,body{min-height:100%;margin:0}
body{background:var(--qapaq-bg);color:var(--qapaq-ink);font-family:var(--font-sans);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
h1,h2,p{margin:0}
a{color:inherit}
img,svg{display:block;max-width:100%}

.login-shell{display:grid;min-height:100vh;grid-template-columns:minmax(380px,540px) minmax(0,1fr)}

/* --- Columna del formulario --- */
.login-side{position:relative;display:flex;min-width:0;flex-direction:column;justify-content:space-between;gap:32px;padding:32px clamp(24px,5vw,64px);background:var(--qapaq-surface)}
.login-brand{display:flex;align-items:center;gap:10px}
.brand-badge{display:block;width:42px;height:42px;object-fit:contain;border-radius:50%}
.brand-name{font-size:14px;font-weight:700;letter-spacing:3px;color:var(--qapaq-ink-soft)}
.login-destination{min-width:0;margin-left:auto;max-width:48%;overflow:hidden;color:var(--qapaq-ink-soft);font-size:12px;text-overflow:ellipsis;white-space:nowrap}

.login-core{width:100%;max-width:400px;margin:0 auto}
.login-core h1{font-size:clamp(26px,3.2vw,32px);font-weight:800;line-height:1.15;letter-spacing:-.5px}
.login-subtitle{margin-top:8px;color:var(--qapaq-ink-soft)}

.login-form{display:grid;gap:16px;margin-top:28px}
.field{display:grid;gap:6px}
.field label{font-size:13px;font-weight:600}
.field input{width:100%;height:48px;padding:0 14px;border:1.5px solid var(--qapaq-line);border-radius:12px;background:#fff;color:var(--qapaq-ink);font:inherit;transition:border-color 140ms ease,box-shadow 140ms ease}
.field input::placeholder{color:#a89cb0}
.field input:hover{border-color:#d9c6d3}
.field input:focus-visible{outline:none;border-color:var(--qapaq-pink);box-shadow:0 0 0 4px rgb(255 88 153 / 20%)}
.password-field{position:relative}
.password-field input{padding-right:48px}
.password-toggle{position:absolute;top:50%;right:6px;display:grid;width:36px;height:36px;place-items:center;padding:0;border:0;border-radius:8px;background:transparent;color:var(--qapaq-ink-soft);cursor:pointer;transform:translateY(-50%)}
.password-toggle:hover{background:var(--qapaq-bg);color:var(--qapaq-ink)}
.password-toggle:focus-visible{outline:2px solid var(--qapaq-pink);outline-offset:1px}
.password-toggle svg{width:20px;height:20px}

.btn{display:flex;width:100%;height:50px;align-items:center;justify-content:center;gap:10px;border:0;border-radius:12px;font:inherit;font-size:15px;font-weight:700;text-decoration:none;cursor:pointer;transition:transform 140ms ease,box-shadow 140ms ease,background-color 140ms ease,opacity 140ms ease}
.btn:focus-visible{outline:3px solid var(--qapaq-blue);outline-offset:2px}
.btn[aria-disabled="true"],.btn:disabled{cursor:progress;opacity:.7;pointer-events:none}
.btn-primary{background:linear-gradient(100deg,var(--qapaq-pink),var(--qapaq-coral) 55%,var(--qapaq-orange));color:#21141b;box-shadow:0 8px 20px -8px rgb(255 88 153 / 40%)}
.btn-primary:hover{transform:translateY(-1px);box-shadow:0 12px 24px -8px rgb(255 88 153 / 46%)}
.btn-primary:active{transform:translateY(0)}
.btn-entra{border:1.5px solid var(--qapaq-line);background:#fff;color:var(--qapaq-ink)}
.btn-entra:hover{border-color:#d9c6d3;background:var(--qapaq-bg)}
.microsoft-mark{width:18px;height:18px}

.login-divider{display:flex;align-items:center;gap:14px;margin:22px 0;color:var(--qapaq-ink-soft);font-size:12px;text-transform:uppercase;letter-spacing:1.5px}
.login-divider::before,.login-divider::after{height:1px;flex:1;background:var(--qapaq-line);content:''}
.login-only-entra{margin-top:28px}

.auth-message{min-height:20px;margin-top:16px;color:var(--qapaq-ink-soft);font-size:13px}
.auth-message-error{padding:10px 12px;border:1px solid #f4b5c8;border-radius:10px;background:#fff1f5;color:var(--qapaq-danger);font-weight:600}

.auth-footer{max-width:400px;margin:0 auto;color:var(--qapaq-ink-soft);font-size:12px}
.auth-footer span{display:block}
.auth-footer .auth-attribution{margin-top:2px;color:#8b7f93;font-size:11px}

/* --- Panel de marca: la ilustración es el fondo --- */
/* La ilustración viene recortada a su zona útil (≈4:3), así que en un panel casi cuadrado
   apenas se escala. El degradado funde su borde izquierdo con el blanco del formulario. */
.login-hero{position:relative;min-height:320px;overflow:hidden;background:url(__UI__/qapaq_login_hero.webp) 55% center/cover no-repeat,linear-gradient(115deg,var(--qapaq-pink),var(--qapaq-rose) 38%,var(--qapaq-orange))}
.login-hero::before{position:absolute;inset:0 auto 0 0;width:clamp(96px,22%,280px);background:linear-gradient(90deg,var(--qapaq-surface) 0%,rgb(255 255 255 / 82%) 28%,rgb(255 255 255 / 38%) 62%,rgb(255 255 255 / 0%) 100%);content:'';pointer-events:none}

/* Tablet y celular: una sola columna, solo el formulario. */
@media (max-width:1000px){
  .login-shell{grid-template-columns:minmax(0,1fr)}
  .login-hero{display:none}
  .login-side{padding:28px 24px 32px}
}
@media (max-width:600px){
  .login-destination{display:none}
}
.qapaqLoginSplash{position:fixed;inset:0;z-index:100000;display:grid;place-items:center;background:#fff;pointer-events:none;animation:qapaqLoginSplashOut 1600ms ease-out forwards}
.qapaqLoginSplash img{width:min(28vh,180px);max-width:70vw;height:auto}
@keyframes qapaqLoginSplashOut{0%,75%{opacity:1;visibility:visible}100%{opacity:0;visibility:hidden}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}.qapaqLoginSplash{display:none}}
`;
