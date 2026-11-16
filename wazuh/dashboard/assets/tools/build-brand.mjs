#!/usr/bin/env node
/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 *
 * Genera el arte QAPAQ SecOps del dashboard a partir de una sola fuente: la Q de QAPAQ
 * vectorizada (misma silueta que `qapaq-secops/apps/web/public/qapaq-mark-source.png`).
 *
 *   node assets/tools/build-brand.mjs            # escribe assets/svg/*.svg (sin dependencias)
 *   node assets/tools/build-brand.mjs --raster   # además PNG/ICO/WebP (favicons, logo de reportes,
 *                                                # mascotas, login e informes de services/qapaq-reports)
 *
 * `--raster` necesita `sharp` resoluble desde NODE_PATH o desde el cwd (p. ej. un
 * `npm install sharp@0.33.5` en un directorio temporal fuera del repo). Los PNG generados se
 * versionan, así que CI no necesita sharp. Paleta: doc 02 de qapaq-secops
 * (docs/brand/qapaq-visual-identity.md).
 *
 * Qapaqzito (asistente) y la mascota del Analista IA se construyen con la misma Q: el hueco de
 * la Q es la cara (ojos y sonrisa ámbar). Son arte provisional hasta tener ilustración oficial.
 * El fondo del login compone `images/qapaq_analyst.webp` (ilustración original de QAPAQ).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Transformación que lleva coordenadas de origen de la Q al rectángulo (x, y, w, h). */
function qTransform(x, y, w, h) {
  const s = Math.min(w / Q_BOX.w, h / Q_BOX.h);
  const tx = x + (w - Q_BOX.w * s) / 2;
  const ty = y + (h - Q_BOX.h * s) / 2;
  return `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s.toFixed(5)}) translate(${-Q_BOX.x} ${-Q_BOX.y})`;
}

/**
 * Cara de Qapaqzito en coordenadas de origen: el hueco de la Q (centro ≈ 219,196) lleva dos ojos
 * ámbar y una sonrisa. Sin texto ni fuentes: se rasteriza igual en cualquier máquina.
 */
const FACE =
  `<rect x="181" y="160" width="22" height="38" rx="11" fill="${AMBER}"/>` +
  `<rect x="235" y="160" width="22" height="38" rx="11" fill="${AMBER}"/>` +
  `<path d="M186 226Q219 254 252 226" fill="none" stroke="${AMBER}" stroke-width="11" stroke-linecap="round"/>`;

/** Destello de cuatro puntas (marca de «IA»), centrado en (cx, cy) con radio r. */
const spark = (cx, cy, r, fill) =>
  `<path fill="${fill}" d="M${cx} ${cy - r}Q${cx + r * 0.16} ${cy - r * 0.16} ${cx + r} ${cy}Q${cx + r * 0.16} ${
    cy + r * 0.16
  } ${cx} ${cy + r}Q${cx - r * 0.16} ${cy + r * 0.16} ${cx - r} ${cy}Q${cx - r * 0.16} ${cy - r * 0.16} ${cx} ${cy - r}Z"/>`;

/** Q de QAPAQ con cara, inscrita en (x, y, w, h). */
const qFace = (x, y, w, h, ink) =>
  `<g transform="${qTransform(x, y, w, h)}"><path fill="${ink}" fill-rule="evenodd" d="${Q_PATH}"/>${FACE}</g>`;

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

/**
 * Pantalla de carga (OSD `ui/logos/spinner*.svg` y splash del login; el fondo es siempre #080808):
 * la Q entra, late suavemente y una línea ámbar recorre la base. 640×512 para el hueco del patch 0001.
 */
function splash() {
  const style =
    '<style>' +
    '@keyframes qi{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}' +
    '@keyframes qp{0%,100%{opacity:1}50%{opacity:.62}}' +
    '@keyframes ql{0%{transform:translateX(-120px)}100%{transform:translateX(400px)}}' +
    '.t{animation:qi 320ms cubic-bezier(.16,1,.3,1) both}' +
    '.q{animation:qp 1.6s cubic-bezier(.4,0,.2,1) infinite}' +
    '.l{animation:ql 1.6s cubic-bezier(.65,0,.35,1) infinite}' +
    '@media (prefers-reduced-motion:reduce){.t,.q,.l{animation:none}}' +
    '</style>';
  return svg(
    640,
    512,
    'Cargando QAPAQ SecOps',
    style +
      `<g class="t">${q(200, 56, 240, 300, INK, ' class="q"')}</g>` +
      `<clipPath id="c"><rect x="200" y="420" width="240" height="4" rx="2"/></clipPath>` +
      `<rect x="200" y="420" width="240" height="4" rx="2" fill="#1a1a1c"/>` +
      `<g clip-path="url(#c)"><rect class="l" x="200" y="420" width="120" height="4" rx="2" fill="${AMBER}"/></g>`,
  );
}

/** Insignia circular de la Q (login, Ankay): Q clara sobre círculo negro con borde neutro. */
const headMark = (size = 256) =>
  svg(
    size,
    size,
    'QAPAQ',
    `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - size * 0.01}" fill="${BLACK}" stroke="${GREY_LINE}" stroke-width="${size * 0.02}"/>` +
      q(size * 0.25, size * 0.2, size * 0.5, size * 0.6, INK),
  );

/** Qapaqzito, el asistente: la Q con cara sobre insignia negra y un destello ámbar de IA. */
const qapaqzito = (size = 192) =>
  svg(
    size,
    size,
    'Qapaqzito',
    `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - size * 0.01}" fill="${BLACK}" stroke="${GREY_LINE}" stroke-width="${size * 0.02}"/>` +
      qFace(size * 0.22, size * 0.17, size * 0.56, size * 0.66, INK) +
      spark(size * 0.79, size * 0.22, size * 0.085, AMBER),
  );

/**
 * Mascota del Analista IA (453×512, misma proporción que la anterior): Qapaqzito con lupa ámbar.
 * Fondo transparente; la insignia negra la hace legible en tema claro y oscuro.
 */
const aiAnalyst = () =>
  svg(
    453,
    512,
    'Analista IA de QAPAQ',
    `<circle cx="246" cy="214" r="200" fill="${BLACK}" stroke="${GREY_LINE}" stroke-width="6"/>` +
      qFace(146, 74, 200, 280, INK) +
      spark(392, 64, 30, AMBER) +
      spark(428, 128, 14, AMBER) +
      `<path d="M66 466L134 398" stroke="${AMBER}" stroke-width="30" stroke-linecap="round"/>` +
      `<circle cx="168" cy="364" r="66" fill="${BLACK}" fill-opacity=".72" stroke="${AMBER}" stroke-width="20"/>` +
      `<path d="M134 346a40 40 0 0 1 30-24" fill="none" stroke="${INK}" stroke-opacity=".7" stroke-width="9" stroke-linecap="round"/>`,
  );

/** Icono de Ankay (Respuesta) para el menú del dashboard: Q clara con el «ejecutar» ámbar. */
const ANKAY_PLAY = 'M196 158L262 195L196 232Z';
const ankayNav = () =>
  svg(
    256,
    256,
    'Ankay',
    `<g transform="${qTransform(28, 16, 200, 224)}"><path fill="${INK}" fill-rule="evenodd" d="${Q_PATH}"/>` +
      `<path fill="${AMBER}" stroke="${AMBER}" stroke-width="10" stroke-linejoin="round" d="${ANKAY_PLAY}"/></g>`,
  );

/** Fondo del login QAPAQ SecOps (1252×941): negro, luz ámbar tenue y la Q en línea. */
const loginHeroBackdrop = () =>
  svg(
    1252,
    941,
    '',
    `<defs><radialGradient id="a" cx="78%" cy="18%" r="70%"><stop offset="0" stop-color="${AMBER}" stop-opacity=".22"/>` +
      `<stop offset=".55" stop-color="${AMBER}" stop-opacity=".05"/><stop offset="1" stop-color="${AMBER}" stop-opacity="0"/></radialGradient></defs>` +
      `<rect width="1252" height="941" fill="${BLACK}"/><rect width="1252" height="941" fill="url(#a)"/>` +
      q(-60, 120, 640, 760, 'none', ` stroke="${GREY_LINE}" stroke-width="3" opacity=".9"`),
  );

function writeSvgs() {
  mkdirSync(svgDir, { recursive: true });
  const files = {
    'qapaq_mark_on_dark.svg': mark(INK),
    'qapaq_mark_on_light.svg': mark(BLACK),
    'qapaq_wordmark_on_dark.svg': wordmark(360, 72, INK, INK_2),
    'qapaq_wordmark_on_light.svg': wordmark(360, 72, BLACK, '#4a4a4f'),
    'qapaq_splash.svg': splash(),
    'qapaq_head_mark.svg': headMark(256),
    'qapaq_qapaqzito.svg': qapaqzito(192),
    'qapaq_ai_analyst_mascot.svg': aiAnalyst(),
    'ankay.svg': ankayNav(),
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

  // Mascotas, insignia y logo cuadrado servidos en /ui/qapaq/ (nombres que usa el código).
  const imgDir = join(root, 'images');
  mkdirSync(imgDir, { recursive: true });
  const render = (name, w, h) => sharp(Buffer.from(files[name]), { density: 300 }).resize(w, h);
  writeFileSync(join(imgDir, 'qapaq-head-mark.webp'), await render('qapaq_head_mark.svg', 256, 256).webp({ quality: 92 }).toBuffer());
  writeFileSync(join(imgDir, 'qapaq-qapaqzito.webp'), await render('qapaq_qapaqzito.svg', 192, 192).webp({ quality: 92 }).toBuffer());
  writeFileSync(
    join(imgDir, 'qapaq-ai-analyst-qapaqzito.webp'),
    await render('qapaq_ai_analyst_mascot.svg', 453, 512).webp({ quality: 90 }).toBuffer(),
  );
  writeFileSync(
    join(imgDir, 'qapaq-ai-analyst-qapaqzito-160.webp'),
    await render('qapaq_ai_analyst_mascot.svg', 142, 160).webp({ quality: 90 }).toBuffer(),
  );
  writeFileSync(join(imgDir, 'qapaq_app_icon_256.png'), await square(256));

  // Panel de marca del login: fondo + ilustración original de la analista QAPAQ.
  const analyst = await sharp(readFileSync(join(imgDir, 'qapaq_analyst.webp'))).resize(880, 880).toBuffer();
  writeFileSync(
    join(imgDir, 'qapaq_login_hero.webp'),
    await sharp(Buffer.from(loginHeroBackdrop()))
      .resize(1252, 941)
      .composite([{ input: analyst, left: 372, top: 61 }])
      .webp({ quality: 82 })
      .toBuffer(),
  );

  // Informes PDF/Excel (services/qapaq-reports): logo cuadrado y mascota de portada.
  const reportsDir = resolve(root, '../../../services/qapaq-reports/assets');
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(join(reportsDir, 'qapaq-mark-gradient.png'), await square(512));
  writeFileSync(join(reportsDir, 'qapaqzito.png'), await render('qapaq_qapaqzito.svg', 640, 640).png().toBuffer());
}

function writeStatic() {
  mkdirSync(favDir, { recursive: true });
  writeFileSync(join(favDir, 'favicon.svg'), appIcon(64));
  writeFileSync(
    join(favDir, 'manifest.json'),
    JSON.stringify(
      {
        name: 'QAPAQ SecOps',
        short_name: 'QAPAQ SecOps',
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
  console.log('SVG, favicons PNG/ICO, mascotas, login y logos de reportes generados.');
} else {
  console.log('SVG generados (sin --raster: PNG/ICO sin cambios).');
}
