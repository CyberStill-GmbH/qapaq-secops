/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 *
 * GENERADO por qapaq/tools/sync_login_from_secops.py — no editar a mano.
 * Migrado desde main antes de retirar apps/web; CSS de acceso QAPAQ integrado en el plugin Wazuh.
 * sha256: b92f9af04f72737a
 */

/** CSS del login QAPAQ SecOps. `__UI__` se sustituye por `${basePath}/ui/qapaq` (activos de marca). */
export const LOGIN_STYLES = `:root{
  --color-qapaq-black: #080808;
  --color-qapaq-white: #f4f4f5;
  --color-qapaq-muted: #a1a1a6;
  --color-qapaq-line: #39393d;
  --font-sans: 'Segoe UI', Inter, ui-sans-serif, system-ui, sans-serif;
}

h1,h2,p{margin:0}
img,svg{display:block;vertical-align:middle}
img{max-width:100%;height:auto}
a{color:inherit}
:root{
  color-scheme: dark;
  font-family: var(--font-sans);
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  background: var(--color-qapaq-black);
  color: var(--color-qapaq-white);
}
*{
  box-sizing: border-box;
}
html,
body,
#root{
  min-width: 320px;
  min-height: 100%;
  margin: 0;
  background: var(--color-qapaq-black);
}
button,
a{
  -webkit-tap-highlight-color: transparent;
}
button{
  font: inherit;
}
::selection{
  color: #080808;
  background: #f4f4f5;
}
.qapaq-cookie-notice{
  position: fixed;
  z-index: 110;
  right: 16px;
  bottom: 16px;
  display: grid;
  width: min(440px, calc(100vw - 32px));
  grid-template-columns: 38px minmax(0, 1fr);
  gap: 12px;
  padding: 15px;
  border: 1px solid #49494e;
  border-radius: 10px;
  background: #131315;
  color: #f4f4f5;
}
.qapaq-cookie-notice__mark{
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border: 1px solid #49494e;
  border-radius: 9px;
  color: #e0bd80;
}
.qapaq-cookie-notice__mark svg{
  width: 20px;
  height: 20px;
}
.qapaq-cookie-notice__content h2{
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.qapaq-cookie-notice__content p{
  margin: 5px 0 8px;
  color: #b0b0b5;
  font-size: 12px;
  line-height: 1.5;
}
.qapaq-cookie-notice__content details{
  margin-bottom: 9px;
  color: #b0b0b5;
  font-size: 11px;
}
.qapaq-cookie-notice__content summary{
  width: fit-content;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.qapaq-cookie-notice__content ul{
  display: grid;
  gap: 4px;
  margin: 8px 0 0;
  padding-left: 18px;
  line-height: 1.5;
}
.qapaq-cookie-notice__content code{
  color: #f4f4f5;
  font-size: 10px;
}
.qapaq-cookie-notice__content button{
  min-height: 38px;
  padding: 0 12px;
  border: 1px solid #85858b;
  border-radius: 6px;
  background: #f4f4f5;
  color: #080808;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.qapaq-cookie-notice__content button:focus-visible{
  outline: 2px solid #f5f5f5;
  outline-offset: 3px;
}
.auth-screen {
  position: relative;
  display: grid;
  min-height: 100svh;
  grid-template-columns: minmax(0, 1fr) minmax(0, 0.96fr);
  overflow: hidden;
  background: #080808;
}

.auth-topbar {
  position: absolute;
  z-index: 2;
  inset: 0 48% auto 0;
  display: flex;
  min-height: 76px;
  align-items: center;
  justify-content: flex-end;
  padding: 0 clamp(20px, 2vw, 34px);
}

.brand-destination {
  color: #a3a3a8;
  font-size: 13px;
  line-height: 1.4;
  text-align: right;
}

.login-core {
  z-index: 1;
  display: flex;
  width: min(100% - 48px, 440px);
  flex-direction: column;
  align-items: center;
  justify-content: center;
  grid-column: 1;
  grid-row: 1;
  justify-self: center;
  padding: 88px 0 100px;
  text-align: center;
}

.login-core h1 {
  margin: 0;
  color: #f5f5f5;
  font-size: clamp(25px, 2.1vw, 32px);
  font-weight: 480;
  letter-spacing: -0.035em;
  line-height: 1.3;
  text-wrap: balance;
}

.login-subtitle {
  margin: 12px 0 0;
  color: #b0b0b5;
  font-size: 16px;
  line-height: 1.5;
}

.login-action-group {
  width: min(100%, 392px);
  margin-top: 54px;
}

.entra-button {
  display: flex;
  width: 100%;
  min-height: 52px;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 12px 20px;
  border: 1px solid #49494e;
  border-radius: 999px;
  background: #09090a;
  color: #b5b5b9;
  font-size: 14px;
  font-weight: 550;
  line-height: 1.4;
  cursor: not-allowed;
  opacity: 1;
}

.entra-button-enabled {
  cursor: pointer;
  color: #f3f3f4;
  transition:
    border-color 160ms ease,
    background-color 160ms ease,
    transform 160ms ease;
}

.entra-button-enabled:hover:not(:disabled) {
  border-color: #929297;
  background: #131315;
  transform: translateY(-1px);
}

.entra-button-enabled:focus-visible {
  outline: 2px solid #f5f5f5;
  outline-offset: 3px;
}

.entra-button-enabled:disabled {
  cursor: progress;
  opacity: 0.75;
}
.auth-message-error {
  color: #f4a6a6;
}

.contract-demo {
  margin-left: auto;
  color: #b0b0b5;
  font-size: 9px;
  letter-spacing: 0.08em;
}

.microsoft-mark {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
}

.auth-message {
  margin: 13px 0 0;
  color: #9d9da2;
  font-size: 13px;
  line-height: 1.5;
}

.api-check-row {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 42px;
}

.api-check-button {
  display: inline-flex;
  min-height: 42px;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 8px 14px;
  border: 1px solid #49494e;
  border-radius: 999px;
  background: transparent;
  color: #ededee;
  font-size: 13px;
  cursor: pointer;
  transition:
    border-color 150ms ease,
    background-color 150ms ease;
}

.api-check-button:hover:not(:disabled) {
  border-color: #85858b;
  background: #111113;
}

.api-check-button:disabled {
  cursor: progress;
}

.api-check-button:focus-visible {
  outline: 2px solid #f5f5f5;
  outline-offset: 4px;
}

.api-check-result {
  color: #a1a1a6;
  font-size: 13px;
  text-align: left;
}

.result-healthy,
.result-degraded,
.result-failed {
  color: #e0e0e2;
}

.health-mark {
  display: inline-grid;
  width: 15px;
  height: 15px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid #85858b;
  border-radius: 50%;
  color: #f5f5f5;
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
}

.health-mark-checking {
  border-right-color: #f5f5f5;
  animation: status-turn 700ms linear infinite;
}

.api-explanation {
  max-width: 400px;
  min-height: 18px;
  margin: 8px auto 0;
  color: #89898e;
  font-size: 11px;
  line-height: 1.55;
}

.auth-footer {
  position: absolute;
  z-index: 1;
  inset: auto 48% 24px 18px;
  color: #89898e;
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
}

.brand-panel {
  position: relative;
  display: grid;
  min-height: 100svh;
  grid-column: 2;
  grid-row: 1;
  overflow: hidden;
  place-items: center;
  background: #080808;
}

.brand-panel::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: 1px;
  background: linear-gradient(
    transparent,
    rgb(255 255 255 / 7%) 18%,
    rgb(255 255 255 / 7%) 82%,
    transparent
  );
  content: '';
}

@keyframes status-turn {
  to {
    transform: rotate(360deg);
  }
}

@media (min-width: 1440px) and (min-height: 800px) {
  .login-action-group {
    margin-top: 60px;
  }

  .api-check-row {
    margin-top: 48px;
  }
}

@media (max-width: 800px) {
  .auth-screen {
    grid-template-columns: minmax(0, 1fr) minmax(0, 0.68fr);
  }

  .auth-topbar {
    right: 40%;
    min-height: 68px;
    padding-inline: 18px;
  }

  .brand-destination {
    font-size: 11px;
  }

  .login-core {
    width: min(100% - 36px, 400px);
  }

  .auth-footer {
    right: 40%;
    left: 12px;
    font-size: 11px;
  }
}

@media (max-width: 620px) {
  .auth-screen {
    display: block;
    min-height: 100svh;
  }

  .auth-topbar {
    right: 0;
    min-height: 66px;
  }

  .brand-destination {
    max-width: calc(100vw - 36px);
    font-size: 11px;
  }

  .login-core {
    position: relative;
    min-height: 100svh;
    width: min(100% - 36px, 460px);
    margin: 0 auto;
    padding: 130px 0 120px;
  }

  .login-core h1 {
    max-width: 360px;
    font-size: clamp(25px, 7vw, 31px);
  }

  .login-subtitle {
    font-size: 15px;
  }

  .login-action-group {
    margin-top: 46px;
  }

  .api-check-row {
    flex-direction: column;
    gap: 8px;
    margin-top: 34px;
  }

  .api-check-result {
    text-align: center;
  }

  .api-explanation {
    margin-top: 10px;
  }

  .brand-panel {
    display: none;
  }

  .auth-footer {
    z-index: 2;
    right: 20px;
    bottom: 16px;
    left: 20px;
    font-size: 11px;
  }
}

@media (max-height: 680px) and (min-width: 621px) {
  .login-core {
    padding-block: 82px 76px;
  }

  .login-action-group {
    margin-top: 32px;
  }

  .api-check-row {
    margin-top: 25px;
  }

  .auth-footer {
    bottom: 10px;
  }
}

.auth-startup {
  position: fixed;
  z-index: 100;
  inset: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: #080808;
}

.auth-splash {
  position: fixed;
  z-index: 30;
  inset: 0;
  display: grid;
  place-items: center;
  background: #080808;
  pointer-events: none;
  animation: auth-splash-out 1050ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.auth-splash-mark {
  width: clamp(64px, 7vw, 96px);
  aspect-ratio: 1;
  background: #fff;
  opacity: 0.76;
  filter: drop-shadow(0 0 16px rgb(255 255 255 / 12%));
  mask-position: center;
  mask-repeat: no-repeat;
  mask-size: contain;
  animation: auth-mark-out 1050ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.auth-splash--waiting {
  animation: none;
  opacity: 1;
  visibility: visible;
}

.auth-splash--waiting .auth-splash-mark {
  animation: none;
  opacity: 0.76;
}

.auth-topbar {
  animation: auth-content-enter 780ms cubic-bezier(0.16, 1, 0.3, 1) 120ms both;
}

.login-core {
  animation: auth-content-enter 900ms cubic-bezier(0.16, 1, 0.3, 1) 180ms both;
}

.auth-footer {
  animation: auth-content-enter 720ms cubic-bezier(0.16, 1, 0.3, 1) 280ms both;
}

.brand-panel::after {
  position: absolute;
  z-index: 11;
  inset: -8% -18%;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgb(151 111 63 / 6%) 38%,
    rgb(221 191 149 / 17%) 68%,
    rgb(255 255 255 / 38%) 100%
  );
  filter: blur(22px);
  mix-blend-mode: screen;
  opacity: 0;
  pointer-events: none;
  content: '';
  animation: login-light-flash 1650ms cubic-bezier(0.16, 1, 0.3, 1) 100ms both;
}

.login-light-amber {
  animation: login-amber-arrival 1650ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.login-light-core {
  animation: login-core-arrival 1500ms cubic-bezier(0.16, 1, 0.3, 1) 80ms both;
}

.login-glass-mark {
  animation: login-mark-relight 1700ms cubic-bezier(0.16, 1, 0.3, 1) 100ms both;
}

@keyframes auth-splash-out {
  0%,
  42% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    visibility: hidden;
  }
}

@keyframes auth-mark-out {
  0% {
    opacity: 0.76;
    filter: blur(4px) drop-shadow(0 0 16px rgb(255 255 255 / 12%));
    transform: scale(0.94);
  }
  38% {
    opacity: 0.76;
    filter: blur(0) drop-shadow(0 0 16px rgb(255 255 255 / 12%));
    transform: scale(1);
  }
  100% {
    opacity: 0;
    filter: blur(7px) drop-shadow(0 0 24px rgb(255 255 255 / 8%));
    transform: scale(1.08);
  }
}

@keyframes auth-content-enter {
  0% {
    filter: blur(6px);
    opacity: 0;
    transform: translateY(12px);
  }
  72%,
  100% {
    filter: blur(0);
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes login-light-flash {
  0%,
  100% {
    opacity: 0;
    transform: translateX(18%);
  }
  18% {
    opacity: 0.9;
  }
  54% {
    opacity: 0.36;
    transform: translateX(-5%);
  }
}

@keyframes login-amber-arrival {
  0% {
    filter: blur(56px) brightness(0.58);
    opacity: 0.42;
  }
  48% {
    filter: blur(56px) brightness(1.12);
    opacity: 1;
  }
  100% {
    filter: blur(56px) brightness(1);
    opacity: 1;
  }
}

@keyframes login-core-arrival {
  0% {
    filter: blur(30px) brightness(0.6);
    opacity: 0.36;
  }
  42% {
    filter: blur(30px) brightness(1.45);
    opacity: 1;
  }
  100% {
    filter: blur(30px) brightness(1.25);
    opacity: 1;
  }
}

@keyframes login-mark-relight {
  0%,
  100% {
    filter: drop-shadow(0 5px 14px rgb(0 0 0 / 62%)) drop-shadow(0 0 1px rgb(255 255 255 / 20%))
      brightness(0.85);
  }
  45% {
    filter: drop-shadow(0 5px 14px rgb(0 0 0 / 62%)) drop-shadow(0 0 14px rgb(255 229 190 / 26%))
      brightness(1.22);
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }

  .auth-splash {
    display: none;
  }

  .auth-startup .auth-splash {
    display: grid;
    animation: none;
    opacity: 1;
    visibility: visible;
  }

  .auth-startup .auth-splash-mark {
    animation: none;
    opacity: 0.76;
  }

  .auth-topbar,
  .login-core,
  .auth-footer,
  .login-light-amber,
  .login-light-core,
  .login-glass-mark,
  .brand-panel::after {
    animation: none !important;
    opacity: 1;
  }
}


.brand-panel{background:#080808}
.login-light-amber{position:absolute;inset:0;z-index:0;pointer-events:none;filter:blur(56px);
background:radial-gradient(ellipse 92% 92% at 100% 45%,#bd8d4c 0%,#a8742f 22%,#7a5528 43%,#3a2815 64%,transparent 83%)}
.login-light-core{position:absolute;inset:0;z-index:0;pointer-events:none;filter:blur(30px) brightness(1.25);
background:radial-gradient(ellipse 42% 82% at 100% 45%,#f4f4f4 0%,#d9d9d9 19%,#b9a47f 48%,transparent 100%)}
.login-art-shade{position:absolute;inset:0;z-index:11;pointer-events:none;background:linear-gradient(90deg,transparent 0%,rgb(0 0 0 / 6%) 38%,rgb(0 0 0 / 32%) 100%)}
.hero-grain{position:absolute;inset:0;z-index:20;pointer-events:none;mix-blend-mode:overlay;opacity:.07;
background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
.login-analyst{position:absolute;right:2%;bottom:0;z-index:5;width:auto;height:82%;max-width:70%;object-fit:contain;object-position:bottom;opacity:.9;pointer-events:none;
-webkit-mask-image:linear-gradient(90deg,transparent 0%,black 25%,black 92%,transparent 100%);mask-image:linear-gradient(90deg,transparent 0%,black 25%,black 92%,transparent 100%)}
.login-glass-mark{position:absolute;top:50%;left:-18%;z-index:10;width:auto;height:88%;pointer-events:none;transform:translateY(-50%);
filter:drop-shadow(0 5px 14px rgb(0 0 0 / 62%)) drop-shadow(0 0 1px rgb(255 255 255 / 20%))}
.auth-splash-mark{-webkit-mask-image:url(__UI__/qapaq_q_mask.png);mask-image:url(__UI__/qapaq_q_mask.png);-webkit-mask-size:contain;-webkit-mask-repeat:no-repeat;-webkit-mask-position:center}
.entra-button{text-decoration:none}
.entra-button[aria-disabled=true]{cursor:progress;opacity:.75;pointer-events:none}
.qapaq-cookie-notice[hidden]{display:none}
`;
