#!/usr/bin/env node
/*
 * Copyright QAPAQ. Arte de Ankay Qapaq (SOAR de QAPAQ SecOps sobre Shuffle).
 *
 * Misma Q de QAPAQ que el SIEM (wazuh/dashboard/assets/tools/build-brand.mjs) para que ambos se lean
 * como una familia; Ankay se distingue por un triángulo ámbar de «ejecutar» dentro del hueco de la Q
 * (automatización). Paleta QAPAQ: #080808 fondo, #f4f4f5 tinta y #c49a5a ámbar.
 *
 *   node ankay/frontend/assets/tools/build-brand.mjs            # SVG en assets/svg (sin dependencias)
 *   node ankay/frontend/assets/tools/build-brand.mjs --raster   # además PNG y favicon.ico en assets/raster
 *
 * `--raster` necesita `sharp` resoluble (p. ej. NODE_PATH a un `npm install sharp@0.33.5` temporal fuera
 * del repo). Los rasters se versionan, así que el build de la imagen no necesita sharp.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INK = '#f4f4f5';
const INK_2 = '#b0b0b5';
const BLACK = '#080808';
const AMBER = '#c49a5a';
const FONT = "'Segoe UI', Inter, 'Helvetica Neue', Arial, sans-serif";

/** Q de QAPAQ (misma silueta que el SIEM). Caja en coordenadas de origen. */
const Q_PATH =
  'M352.4 401.2C357.3 387.1 361.5 374.9 361.8 374.2C362.1 373.3 360.4 373.0 355.2 373.0C338.2 373.0 312.5 365.6 277.5 350.5C255.7 341.1 255.4 340.9 262.7 339.5C264.8 339.1 270.8 337.2 276.0 335.3C310.7 322.5 338.5 297.6 355.3 264.5C371.0 233.7 375.7 196.4 368.4 161.9C356.6 105.9 315.9 64.5 259.0 50.6C211.7 39.1 160.5 49.6 123.7 78.3C97.7 98.6 80.0 127.1 72.2 161.0C69.8 171.4 69.6 174.5 69.6 193.5C69.5 212.6 69.8 215.6 72.2 227.1C79.1 258.9 93.2 284.0 116.7 306.0C124.8 313.5 138.3 323.3 144.4 326.2C145.8 326.8 147.0 327.6 147.0 327.9C147.0 328.2 143.4 330.4 139.1 332.8C134.8 335.2 128.1 340.1 124.2 343.6L117.1 350.0L125.6 374.6C130.2 388.2 134.0 399.5 134.0 399.8C134.0 400.1 136.2 398.0 138.9 395.2C150.5 383.2 162.7 378.0 181.5 377.3C206.7 376.2 230.8 383.7 284.0 408.8C302.2 417.4 310.2 420.6 320.0 423.3C332.5 426.7 332.7 426.8 338.5 426.9L343.5 427.0L352.4 401.2ZM205.5 284.0C179.4 279.2 157.0 261.3 145.0 235.7C138.5 221.9 136.6 212.2 136.6 194.0C136.6 181.2 137.0 177.1 138.8 170.4C149.3 131.6 180.1 106.9 218.0 106.9C241.1 106.9 260.5 115.2 276.1 131.6C309.0 166.5 308.6 222.6 275.1 260.3C271.1 264.7 259.1 273.5 252.5 276.8C239.3 283.4 219.0 286.5 205.5 284.0Z';
const Q_BOX = { x: 69.5, y: 39.1, w: 304.6, h: 387.9 };
/** Triángulo «ejecutar» centrado en el hueco de la Q (centro ~ 218,195 en origen). */
const PLAY = 'M196 158L262 195L196 232Z';

/** Q más triángulo ámbar, inscritos en (x, y, w, h). */
function ankayMark(x, y, w, h, ink) {
  const s = Math.min(w / Q_BOX.w, h / Q_BOX.h);
  const tx = x + (w - Q_BOX.w * s) / 2;
  const ty = y + (h - Q_BOX.h * s) / 2;
  const t = `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s.toFixed(5)}) translate(${-Q_BOX.x} ${-Q_BOX.y})`;
  return (
    `<path fill="${ink}" fill-rule="evenodd" transform="${t}" d="${Q_PATH}"/>` +
    `<path fill="${AMBER}" stroke="${AMBER}" stroke-width="10" stroke-linejoin="round" transform="${t}" d="${PLAY}"/>`
  );
}

const svg = (w, h, label, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${label}">${body}</svg>\n`;

/** Marca sola (22×22, reemplaza images/logos/orange_logo.svg). */
const mark = (size, ink) =>
  svg(
    size,
    size,
    'Ankay Qapaq',
    ankayMark(size * 0.08, size * 0.04, size * 0.84, size * 0.92, ink),
  );

/** Logotipo «Ankay Qapaq» (131×28, reemplaza images/logos/topleft_logo.svg). */
function wordmark(w, h) {
  const qh = h * 0.92;
  const fontSize = h * 0.56;
  const textX = qh * 0.82 + h * 0.2;
  return svg(
    w,
    h,
    'Ankay Qapaq',
    ankayMark(0, (h - qh) / 2, qh * 0.8, qh, INK) +
      `<text x="${textX.toFixed(1)}" y="${(h * 0.72).toFixed(1)}" font-family="${FONT}" font-size="${fontSize.toFixed(1)}" font-weight="600" fill="${INK}">Ankay<tspan dx="${(fontSize * 0.24).toFixed(1)}" font-weight="400" fill="${INK_2}">Qapaq</tspan></text>`,
  );
}

/** Icono cuadrado sobre negro (PNG de 540 y 174, y favicon). */
const appIcon = (size) =>
  svg(
    size,
    size,
    'Ankay Qapaq',
    `<rect width="${size}" height="${size}" rx="${size * 0.19}" fill="${BLACK}"/>` +
      ankayMark(size * 0.18, size * 0.14, size * 0.64, size * 0.72, INK),
  );

function writeSvgs() {
  const dir = join(root, 'svg');
  mkdirSync(dir, { recursive: true });
  const files = {
    'ankay_mark.svg': mark(22, INK),
    'ankay_wordmark.svg': wordmark(131, 28),
    'ankay_app_icon.svg': appIcon(512),
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return files;
}

/** ICO con PNG embebidos (admitido por los navegadores actuales). */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

async function raster(files) {
  const sharp = createRequire(join(process.cwd(), 'noop.js'))('sharp');
  const dir = join(root, 'raster');
  mkdirSync(dir, { recursive: true });
  const icon = Buffer.from(files['ankay_app_icon.svg']);
  const png = (size) => sharp(icon, { density: 300 }).resize(size, size).png().toBuffer();
  writeFileSync(join(dir, 'ankay_icon_540.png'), await png(540));
  writeFileSync(join(dir, 'ankay_icon_174.png'), await png(174));
  writeFileSync(
    join(dir, 'favicon.ico'),
    ico([
      { size: 16, data: await png(16) },
      { size: 32, data: await png(32) },
      { size: 64, data: await png(64) },
    ]),
  );
}

const files = writeSvgs();
if (process.argv.includes('--raster')) await raster(files);
console.log('arte de Ankay Qapaq generado');
