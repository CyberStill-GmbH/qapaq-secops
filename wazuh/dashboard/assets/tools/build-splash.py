#!/usr/bin/env python3
"""
Genera la pantalla de carga animada de QAPAQ (svg/qapaq_splash.svg) desde la ilustración de marca.

Uso:  python wazuh/dashboard/assets/tools/build-splash.py <ilustracion.png> [--out svg/qapaq_splash.svg]
Requiere: pillow, numpy, opencv-python-headless.

La ilustración original es un único PNG sobre fondo blanco. Para animar «el planeta aparece y la
mascota vuela» se separa en dos capas:

1. Mascota: GrabCut inicializado con el color coral del cuerpo (más cierre morfológico y relleno
   de huecos para gafas, mochila y trazo) y una elipse manual para el cristal derecho.
2. Planeta: la imagen sin la mascota (inpainting) y con el fondo blanco convertido en
   transparencia solo en la región exterior conectada con las esquinas, de modo que el resplandor
   se vea sobre el fondo oscuro sin volver translúcidos los trazos claros interiores.

Ambas capas se incrustan en el SVG como WebP en base64 y se animan con CSS dentro del propio SVG
(una sola petición; el core de OSD lo carga con `<img>` desde `ui/logos/spinner*.svg`).
"""

import argparse
import base64
import io
import pathlib
import sys

import cv2
import numpy as np
from PIL import Image

PLANET_WIDTH = 640
MASCOT_WIDTH = 440


def ellipse(n):
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (n, n))


def mascot_mask(im):
    h, w = im.shape[:2]
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
    coral = ((hsv[..., 0] >= 3) & (hsv[..., 0] <= 18) & (hsv[..., 1] > 90) & (hsv[..., 2] > 150)).astype(np.uint8)
    m = cv2.morphologyEx(coral, cv2.MORPH_CLOSE, ellipse(61))
    flood = m.copy()
    cv2.floodFill(flood, np.zeros((h + 2, w + 2), np.uint8), (0, 0), 1)
    m = m | (1 - flood)
    # Mochila y llama: oscuras, no coral; se marcan como probable primer plano.
    pack = np.zeros_like(m)
    cv2.fillPoly(pack, [np.array([(350, 735), (375, 650), (470, 600), (540, 505), (700, 545), (770, 640), (745, 745), (560, 745)])], 1)
    m = (m | pack).astype(np.uint8)
    gc = np.full((h, w), cv2.GC_BGD, np.uint8)
    gc[cv2.dilate(m, ellipse(41)) > 0] = cv2.GC_PR_BGD
    gc[cv2.dilate(m, ellipse(15)) > 0] = cv2.GC_PR_FGD
    gc[cv2.erode(m, ellipse(21)) > 0] = cv2.GC_FGD
    cv2.grabCut(im, gc, None, np.zeros((1, 65)), np.zeros((1, 65)), 6, cv2.GC_INIT_WITH_MASK)
    res = ((gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD)).astype(np.uint8)
    res = cv2.morphologyEx(res, cv2.MORPH_OPEN, ellipse(5))
    res = cv2.morphologyEx(res, cv2.MORPH_CLOSE, ellipse(9))
    _, lab, st, _ = cv2.connectedComponentsWithStats(res)
    res = (lab == 1 + np.argmax(st[1:, 4])).astype(np.uint8)
    cv2.ellipse(res, (985, 462), (80, 84), 15, 0, 360, 1, -1)  # cristal derecho
    return cv2.morphologyEx(res, cv2.MORPH_CLOSE, ellipse(15))


def webp_b64(arr_bgra, width, quality, alpha_quality):
    pil = Image.fromarray(cv2.cvtColor(arr_bgra, cv2.COLOR_BGRA2RGBA))
    pil = pil.resize((width, round(pil.height * width / pil.width)), Image.LANCZOS)
    buf = io.BytesIO()
    pil.save(buf, 'WEBP', quality=quality, method=6, alpha_quality=alpha_quality)
    return base64.b64encode(buf.getvalue()).decode(), pil.size, len(buf.getvalue())


def fill_planet(im, m):
    """Quita la mascota del planeta sin el borrón del inpainting: dentro del disco del planeta
    el hueco se rellena con el perfil radial de color (mediana por anillo) y se funde con
    el borde; fuera del disco el hueco queda como fondo blanco (luego transparente)."""
    h, w = im.shape[:2]
    hole = cv2.dilate(m, ellipse(17))
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
    blue = ((hsv[..., 0] >= 100) & (hsv[..., 0] <= 125) & (hsv[..., 1] > 120) & (hsv[..., 2] > 60) & (hole == 0)).astype(np.uint8)
    blue = cv2.morphologyEx(blue, cv2.MORPH_CLOSE, ellipse(15))
    _, lab, st, _ = cv2.connectedComponentsWithStats(blue)
    big = (lab == 1 + np.argmax(st[1:, 4])).astype(np.uint8)
    (cx, cy), r = cv2.minEnclosingCircle(cv2.findNonZero(big))
    yy, xx = np.mgrid[0:h, 0:w]
    dist = np.hypot(xx - cx, yy - cy)
    samples = (big > 0)
    bins = np.clip((dist / r * 40).astype(int), 0, 40)
    # Mediana por anillo; los anillos sin muestras (la mascota tapa el centro) se interpolan.
    known, values = [], []
    for b in range(41):
        sel = samples & (bins == b)
        if sel.sum() > 50:
            known.append(b)
            values.append(np.median(im[sel], axis=0))
    values = np.array(values, np.float32)
    profile = np.stack([np.interp(np.arange(41), known, values[:, c]) for c in range(3)], axis=1).astype(np.float32)
    profile = cv2.GaussianBlur(profile.reshape(41, 1, 3), (0, 0), 1.5).reshape(41, 3)
    fill = profile[bins].reshape(h, w, 3)
    inside = dist < r * 1.07
    out = im.astype(np.float32).copy()
    wgt = cv2.GaussianBlur(hole.astype(np.float32), (0, 0), 5)[..., None]
    inside_f = inside[..., None].astype(np.float32)
    target = np.where(inside[..., None], fill, 255.0)
    out = out * (1 - wgt) + target * wgt
    return np.clip(out, 0, 255).astype(np.uint8)


def layers(im):
    h, w = im.shape[:2]
    m = mascot_mask(im)
    soft = cv2.GaussianBlur(cv2.erode(m, ellipse(3)).astype(np.float32), (0, 0), 1.1)
    ys, xs = np.where(m > 0)
    mx0, mx1, my0, my1 = max(xs.min() - 6, 0), xs.max() + 6, max(ys.min() - 6, 0), ys.max() + 6
    mascot = np.dstack([im, (soft * 255).astype(np.uint8)])[my0:my1, mx0:mx1]

    f = fill_planet(im, m).astype(np.float32) / 255
    minc = f.min(axis=2)
    _, lab = cv2.connectedComponents((minc > 0.62).astype(np.uint8))
    corners = [lab[0, 0], lab[0, w - 1], lab[h - 1, 0], lab[h - 1, w - 1]]
    outer = np.isin(lab, corners) & (lab > 0)
    alpha = np.ones((h, w), np.float32)
    alpha[outer] = np.clip((1 - minc) / 0.38, 0, 1)[outer]
    col = np.where(outer[..., None], np.clip((f - (1 - alpha)[..., None]) / np.maximum(alpha, 1e-3)[..., None], 0, 1), f)
    planet = np.dstack([(col * 255).astype(np.uint8), (alpha * 255).astype(np.uint8)])
    ys, xs = np.where(alpha > 0.03)
    px0, px1, py0, py1 = xs.min(), xs.max(), ys.min(), ys.max()
    return planet[py0:py1, px0:px1], mascot, (mx0, my0, mx1, my1), (px0, py0, px1, py1)


SVG = """<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="Cargando QAPAQ SOC">
<defs>
<radialGradient id="glow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#2fd4ff" stop-opacity=".34"/><stop offset=".55" stop-color="#2a6bff" stop-opacity=".16"/><stop offset="1" stop-color="#2a6bff" stop-opacity="0"/></radialGradient>
<linearGradient id="trail" x1="1" x2="0"><stop offset="0" stop-color="#7ff6ff" stop-opacity=".95"/><stop offset="1" stop-color="#7ff6ff" stop-opacity="0"/></linearGradient>
<path id="star" d="M0-1 .22-.22 1 0 .22.22 0 1-.22.22-1 0-.22-.22Z"/>
</defs>
<style>
.halo{{transform-box:fill-box;transform-origin:center;animation:halo 3.6s ease-in-out infinite}}
.planet{{transform-box:fill-box;transform-origin:center;animation:appear 1s cubic-bezier(.16,1,.3,1) both,breathe 7s 1s ease-in-out infinite}}
.enter{{animation:fly 1.2s .3s cubic-bezier(.2,1,.3,1) both}}
.mascot{{transform-box:fill-box;transform-origin:50% 55%;animation:hover 3.4s 1.55s ease-in-out infinite}}
.streak{{stroke:url(#trail);stroke-linecap:round;stroke-dasharray:34 90;animation:streak 1.1s linear infinite}}
.s2{{animation-delay:-.35s}}.s3{{animation-delay:-.7s}}
.tw{{transform-box:fill-box;transform-origin:center;animation:twinkle 2.4s ease-in-out infinite}}
.t2{{animation-delay:-.8s}}.t3{{animation-delay:-1.6s}}
@keyframes appear{{from{{opacity:0;transform:scale(.5) rotate(-16deg)}}60%{{opacity:1}}to{{opacity:1;transform:none}}}}
@keyframes breathe{{0%,100%{{transform:scale(1) rotate(0)}}50%{{transform:scale(1.022) rotate(.8deg)}}}}
@keyframes fly{{from{{opacity:0;transform:translate({FX}px,{FY}px) rotate(-14deg) scale(.72)}}35%{{opacity:1}}to{{opacity:1;transform:none}}}}
@keyframes hover{{0%,100%{{transform:translate(0,0) rotate(0)}}50%{{transform:translate(7px,-13px) rotate(-2.4deg)}}}}
@keyframes streak{{from{{stroke-dashoffset:0;opacity:.9}}to{{stroke-dashoffset:-124;opacity:.2}}}}
@keyframes halo{{0%,100%{{opacity:.75;transform:scale(.97)}}50%{{opacity:1;transform:scale(1.04)}}}}
@keyframes twinkle{{0%,100%{{opacity:.15;transform:scale(.4) rotate(0)}}50%{{opacity:1;transform:scale(1) rotate(45deg)}}}}
@media (prefers-reduced-motion:reduce){{*{{animation:none!important}}}}
</style>
<ellipse class="halo" cx="{CX}" cy="{CY}" rx="{RX}" ry="{RY}" fill="url(#glow)"/>
<image class="planet" href="data:image/webp;base64,{PLANET}" x="0" y="0" width="{W}" height="{H}"/>
<g class="enter"><g class="mascot">
<g fill="none" stroke-width="5">
<path class="streak" d="M{TX} {TY} q-34 8 -66 30"/>
<path class="streak s2" d="M{TX2} {TY2} q-30 4 -58 20"/>
<path class="streak s3" d="M{TX3} {TY3} q-26 14 -50 40"/>
</g>
<image href="data:image/webp;base64,{MASCOT}" x="{MX}" y="{MY}" width="{MW}" height="{MH}"/>
</g></g>
<g fill="#aef3ff"><use class="tw" href="#star" transform="translate({S1X} {S1Y}) scale(11)"/><use class="tw t2" href="#star" fill="#ff5fb8" transform="translate({S2X} {S2Y}) scale(8)"/><use class="tw t3" href="#star" transform="translate({S3X} {S3Y}) scale(9)"/></g>
</svg>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('source')
    ap.add_argument('--out', default=str(pathlib.Path(__file__).resolve().parents[1] / 'svg' / 'qapaq_splash.svg'))
    args = ap.parse_args()
    im = cv2.imread(args.source)
    if im is None:
        sys.exit(f'no se pudo leer {args.source}')
    planet, mascot, (mx0, my0, mx1, my1), (px0, py0, px1, py1) = layers(im)
    p64, (pw, ph), pbytes = webp_b64(planet, PLANET_WIDTH, 60, 70)
    m64, _, mbytes = webp_b64(mascot, MASCOT_WIDTH, 74, 85)
    s = pw / (px1 - px0)
    mw, mh = round((mx1 - mx0) * s), round((my1 - my0) * s)
    mx, my = round((mx0 - px0) * s), round((my0 - py0) * s)
    # Llama de la mochila en coordenadas de la ilustración original → del SVG.
    tx, ty = round((372 - px0) * s), round((690 - py0) * s)
    svg = SVG.format(
        W=pw, H=ph, CX=pw // 2, CY=ph // 2, RX=round(pw * 0.48), RY=round(ph * 0.46),
        PLANET=p64, MASCOT=m64, MX=mx, MY=my, MW=mw, MH=mh,
        FX=-round(pw * 0.2), FY=round(ph * 0.18),
        TX=tx, TY=ty, TX2=tx + 6, TY2=ty - 26, TX3=tx + 2, TY3=ty + 28,
        S1X=round(pw * 0.93), S1Y=round(ph * 0.12), S2X=round(pw * 0.07), S2Y=round(ph * 0.3), S3X=round(pw * 0.8), S3Y=round(ph * 0.92),
    )
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(svg, encoding='utf-8')
    print(f'{out}: {out.stat().st_size // 1024} KB (planeta {pbytes // 1024} KB, mascota {mbytes // 1024} KB)')


if __name__ == '__main__':
    main()
