#!/usr/bin/env node
/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 *
 * Genera el arte QAPAQ SecOps del dashboard a partir de una sola fuente: la Q de QAPAQ
 * vectorizada (misma silueta que `qapaq-secops/apps/web/public/qapaq-mark-source.png`).
 *
 *   node assets/tools/build-brand.mjs            # escribe assets/svg/*.svg (sin dependencias)
 *   node assets/tools/build-brand.mjs --raster   # además PNG/ICO de favicons y logo de reportes
 *
 * `--raster` necesita `sharp` resoluble desde NODE_PATH o desde el cwd (p. ej. un
 * `npm install sharp@0.33.5` en un directorio temporal fuera del repo). Los PNG generados se
 * versionan, así que CI no necesita sharp. Paleta: doc 02 de qapaq-secops.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const svgDir = join(root, 'svg');
const favDir = join(root, 'favicons');
const appDir = join(root, 'wazuh-app');

const INK = '#f4f4f5'; // texto principal sobre #080808
const INK_2 = '#b0b0b5';
const BLACK = '#080808';
const GREY_LINE = '#29292d';
const AMBER = '#c49a5a';
const FONT = "'Segoe UI', Inter, 'Helvetica Neue', Arial, sans-serif";

/** Q de QAPAQ: caja de la silueta en coordenadas de origen (x 69.5–374, y 39.1–427). */
const Q_PATH =
  'M352.4 401.2C357.3 387.1 361.5 374.9 361.8 374.2C362.1 373.3 360.4 373.0 355.2 373.0C338.2 373.0 312.5 365.6 277.5 350.5C255.7 341.1 255.4 340.9 262.7 339.5C264.8 339.1 270.8 337.2 276.0 335.3C310.7 322.5 338.5 297.6 355.3 264.5C371.0 233.7 375.7 196.4 368.4 161.9C356.6 105.9 315.9 64.5 259.0 50.6C211.7 39.1 160.5 49.6 123.7 78.3C97.7 98.6 80.0 127.1 72.2 161.0C69.8 171.4 69.6 174.5 69.6 193.5C69.5 212.6 69.8 215.6 72.2 227.1C79.1 258.9 93.2 284.0 116.7 306.0C124.8 313.5 138.3 323.3 144.4 326.2C145.8 326.8 147.0 327.6 147.0 327.9C147.0 328.2 143.4 330.4 139.1 332.8C134.8 335.2 128.1 340.1 124.2 343.6L117.1 350.0L125.6 374.6C130.2 388.2 134.0 399.5 134.0 399.8C134.0 400.1 136.2 398.0 138.9 395.2C150.5 383.2 162.7 378.0 181.5 377.3C206.7 376.2 230.8 383.7 284.0 408.8C302.2 417.4 310.2 420.6 320.0 423.3C332.5 426.7 332.7 426.8 338.5 426.9L343.5 427.0L352.4 401.2ZM205.5 284.0C179.4 279.2 157.0 261.3 145.0 235.7C138.5 221.9 136.6 212.2 136.6 194.0C136.6 181.2 137.0 177.1 138.8 170.4C149.3 131.6 180.1 106.9 218.0 106.9C241.1 106.9 260.5 115.2 276.1 131.6C309.0 166.5 308.6 222.6 275.1 260.3C271.1 264.7 259.1 273.5 252.5 276.8C239.3 283.4 219.0 286.5 205.5 284.0Z';
const Q_BOX = { x: 69.5, y: 39.1, w: 304.6, h: 387.9 };

/** `<path>` de la Q inscrita en el rectángulo (x, y, w, h), centrada. */
function q(x, y, w, h, fill, extra = '') {
  const s = Math.min(w / Q_BOX.w, h / Q_BOX.h);
  const tx = x + (w - Q_BOX.w * s) / 2;
  const ty = y + (h - Q_BOX.h * s) / 2;
  return `<path${extra} fill="${fill}" fill-rule="evenodd" transform="translate(${tx.toFixed(2)} ${ty.toFixed(
    2,
  )}) scale(${s.toFixed(5)}) translate(${-Q_BOX.x} ${-Q_BOX.y})" d="${Q_PATH}"/>`;
}

const svg = (w, h, label, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${label}">${body}</svg>\n`;

/** Marca Q sola (cabecera, menú, ayuda). 64×64 con aire, como las marcas del core. */
const mark = (fill) => svg(64, 64, 'QAPAQ', q(8, 6, 48, 52, fill));

/** Logotipo «QAPAQ SecOps»: Q + nombre. `secondary` es el gris de «SecOps». */
function wordmark(w, h, fill, secondary) {
  const qh = h * 0.86;
  const fontSize = h * 0.5;
  const textX = qh * 0.86 + h * 0.22;
  return svg(
    w,
    h,
    'QAPAQ SecOps',
    q(0, (h - qh) / 2, qh * 0.8, qh, fill) +
      `<text x="${textX.toFixed(1)}" y="${(h * 0.68).toFixed(1)}" font-family="${FONT}" font-size="${fontSize.toFixed(
        1,
      )}" font-weight="600" letter-spacing="${(-fontSize * 0.02).toFixed(2)}" fill="${fill}">QAPAQ<tspan dx="${(fontSize * 0.26).toFixed(1)}" font-weight="400" fill="${secondary}">SecOps</tspan></text>`,
  );
}

/**
 * Pantalla de carga (OSD `spinner_on_*.svg`, 1024×200, se pinta a 100 px de alto): la Q late
 * suavemente (opacidad) y una línea ámbar recorre la base. Nada se mueve con
 * `prefers-reduced-motion` (los SVG en <img> respetan la media query del sistema).
 */
function spinner(fill, secondary, track) {
  const style =
    '<style>' +
    '@keyframes qp{0%,100%{opacity:1}50%{opacity:.6}}' +
    '@keyframes ql{0%{transform:translateX(-240px)}100%{transform:translateX(1024px)}}' +
    '@keyframes qi{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}' +
    '.q{animation:qp 1.6s cubic-bezier(.4,0,.2,1) infinite}' +
    '.t{animation:qi 240ms cubic-bezier(.16,1,.3,1) both}' +
    '.l{animation:ql 1.8s cubic-bezier(.65,0,.35,1) infinite}' +
    '@media (prefers-reduced-motion:reduce){.q,.l,.t{animation:none}}' +
    '</style>';
  return svg(
    1024,
    200,
    'Cargando QAPAQ SecOps',
    style +
      `<g class="t">` +
      q(224, 24, 112, 136, fill, ' class="q"') +
      `<text x="360" y="124" font-family="${FONT}" font-size="84" font-weight="600" letter-spacing="-1.6" fill="${fill}">QAPAQ<tspan dx="22" font-weight="400" fill="${secondary}">SecOps</tspan></text>` +
      `</g>` +
      `<clipPath id="c"><rect x="224" y="184" width="576" height="3" rx="1.5"/></clipPath>` +
      `<rect x="224" y="184" width="576" height="3" rx="1.5" fill="${track}"/>` +
      `<g clip-path="url(#c)"><rect class="l" x="0" y="184" width="240" height="3" rx="1.5" fill="${AMBER}"/></g>`,
  );
}

/** Icono de la app (favicon fuente): Q blanca sobre cuadrado negro redondeado (PWA de QAPAQ). */
const appIcon = (size = 512) =>
  svg(
    size,
    size,
    'QAPAQ SecOps',
    `<rect width="${size}" height="${size}" rx="${size * 0.19}" fill="${BLACK}"/>` +
      q(size * 0.2, size * 0.16, size * 0.6, size * 0.68, INK),
  );

/** Fondo del login heredado (OSD/Security plugin): negro con la Q en línea muy tenue. */
const loginBg = () =>
  svg(
    1119,
    539,
    '',
    `<rect width="1119" height="539" fill="${BLACK}"/>` +
      q(
        640,
        40,
        420,
        460,
        'none',
        ` stroke="${GREY_LINE}" stroke-width="10" vector-effect="non-scaling-stroke" opacity=".6"`,
      ),
  );

function writeSvgs() {
  mkdirSync(svgDir, { recursive: true });
  const files = {
    'qapaq_mark_on_dark.svg': mark(INK),
    'qapaq_mark_on_light.svg': mark(BLACK),
    'qapaq_wordmark_on_dark.svg': wordmark(360, 72, INK, INK_2),
    'qapaq_wordmark_on_light.svg': wordmark(360, 72, BLACK, '#4a4a4f'),
    'qapaq_spinner_on_dark.svg': spinner(INK, INK_2, '#1a1a1c'),
    'qapaq_spinner_on_light.svg': spinner(BLACK, '#4a4a4f', '#e4e4e7'),
    'qapaq_login_bg.svg': loginBg(),
    'qapaq_app_icon.svg': appIcon(512),
    // Safari pinned tab: silueta monocroma (Safari aplica el color de `mask-icon`).
    'qapaq_safari_pinned_tab.svg': svg(16, 16, 'QAPAQ', q(1.5, 0.5, 13, 15, '#000000')),
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(svgDir, name), content);
  return files;
}

/** ICO con imágenes PNG embebidas (formato admitido por todos los navegadores actuales). */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

async function raster(files) {
  const require = createRequire(join(process.cwd(), 'noop.js'));
  const sharp = require('sharp');
  mkdirSync(favDir, { recursive: true });
  mkdirSync(appDir, { recursive: true });
  const icon = Buffer.from(files['qapaq_app_icon.svg']);
  const square = async (size) => sharp(icon, { density: 300 }).resize(size, size).png().toBuffer();
  const out = {
    'favicon-16x16.png': await square(16),
    'favicon-32x32.png': await square(32),
    'apple-touch-icon.png': await square(180),
    'android-chrome-192x192.png': await square(192),
    'android-chrome-512x512.png': await square(512),
    'mstile-70x70.png': await square(70),
    'mstile-144x144.png': await square(144),
    'mstile-150x150.png': await square(150),
    'mstile-310x310.png': await square(310),
  };
  // Mosaico ancho: icono centrado sobre negro.
  out['mstile-310x150.png'] = await sharp({
    create: { width: 310, height: 150, channels: 4, background: BLACK },
  })
    .composite([{ input: await square(120), top: 15, left: 95 }])
    .png()
    .toBuffer();
  for (const [name, data] of Object.entries(out)) writeFileSync(join(favDir, name), data);
  const icoImages = await Promise.all(
    [16, 32, 48].map(async (size) => ({ size, data: await square(size) })),
  );
  writeFileSync(join(favDir, 'favicon.ico'), ico(icoImages));
  // Logo de los PDF de reportes de Wazuh (fondo blanco): 369×74 como el original.
  writeFileSync(
    join(appDir, 'logo_reports.png'),
    await sharp(Buffer.from(wordmark(369, 74, BLACK, '#4a4a4f')), { density: 300 })
      .resize(369, 74)
      .png()
      .toBuffer(),
  );
}

function writeStatic() {
  mkdirSync(favDir, { recursive: true });
  writeFileSync(
    join(favDir, 'manifest.json'),
    JSON.stringify(
      {
        name: 'QAPAQ SecOps',
        short_name: 'QAPAQ SOC',
        icons: [
          { src: 'android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
          {
            src: 'android-chrome-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
        theme_color: BLACK,
        background_color: BLACK,
        display: 'standalone',
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(favDir, 'browserconfig.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<browserconfig>\n    <msapplication>\n        <tile>\n            <square150x150logo src="/ui/favicons/mstile-150x150.png"/>\n            <TileColor>${BLACK}</TileColor>\n        </tile>\n    </msapplication>\n</browserconfig>\n`,
  );
}

const files = writeSvgs();
writeStatic();
if (process.argv.includes('--raster')) {
  await raster(files);
  console.log('SVG, favicons PNG/ICO y logo de reportes generados.');
} else {
  console.log('SVG generados (sin --raster: PNG/ICO sin cambios).');
}
