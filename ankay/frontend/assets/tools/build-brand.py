#!/usr/bin/env python3
"""
Arte de Ankay (Shuffle rebrandeado) a partir del conejo mantenido de Qapaqzito.

    python ankay/frontend/assets/tools/build-brand.py

Fuente: docs/brand/assets/logo/qapaq-qapaqzito-mark.webp, la cabeza circular del conejo.
La mascota de IA qapaq-qapaqzito.webp es independiente y no se usa como logo.
Se conserva el arte y su transparencia; los SVG incrustan el WebP original sin ampliar
sus pixeles ni incluir el antiguo monograma. El titulo Ankay lo renderiza la interfaz.

Genera (mismos nombres que `targets.tsv`):
  raster/ankay_icon_540.png  raster/ankay_icon_174.png  raster/ankay_icon_144.png  raster/favicon.ico
  svg/ankay_mark.svg (22x22)  svg/ankay_wordmark.svg (131x28)  svg/ankay_app_icon.svg
Los SVG incrustan el PNG escalado a 4x (nítido en pantallas densas).
"""

import base64
import pathlib

from PIL import Image

HERE = pathlib.Path(__file__).resolve().parent
ASSETS = HERE.parent
SOURCE = HERE.parents[3] / 'docs' / 'brand' / 'assets' / 'logo' / 'qapaq-qapaqzito-mark.webp'
UI_MARK = ASSETS / 'raster' / 'qapaq-head-mark.webp'
TITLE = 'Ankay'


def scaled(im, size):
    from PIL import ImageOps
    return ImageOps.pad(im, (size, size), method=Image.LANCZOS, color=(0, 0, 0, 0))


def svg(width, height, image_x, image_size, b64):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" '
        f'role="img" aria-label="{TITLE}"><title>{TITLE}</title>'
        f'<image href="data:image/webp;base64,{b64}" x="{image_x}" y="{(height - image_size) / 2:g}" '
        f'width="{image_size}" height="{image_size}"/></svg>\n'
    )


def main():
    mark = Image.open(SOURCE).convert('RGBA')
    (ASSETS / 'raster').mkdir(parents=True, exist_ok=True)
    (ASSETS / 'svg').mkdir(parents=True, exist_ok=True)
    scaled(mark, 256).save(UI_MARK, 'WEBP', quality=92, method=6)
    scaled(mark, 540).save(ASSETS / 'raster' / 'ankay_icon_540.png', optimize=True)
    scaled(mark, 174).save(ASSETS / 'raster' / 'ankay_icon_174.png', optimize=True)
    scaled(mark, 144).save(ASSETS / 'raster' / 'ankay_icon_144.png', optimize=True)
    mark.save(ASSETS / 'raster' / 'favicon.ico', sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    (ASSETS / 'svg' / 'ankay_mark.svg').write_text(svg(22, 22, 0, 22, base64.b64encode(UI_MARK.read_bytes()).decode()), encoding='utf-8')
    (ASSETS / 'svg' / 'ankay_wordmark.svg').write_text(svg(131, 28, 0, 28, base64.b64encode(UI_MARK.read_bytes()).decode()), encoding='utf-8')
    (ASSETS / 'svg' / 'ankay_app_icon.svg').write_text(svg(512, 512, 0, 512, base64.b64encode(UI_MARK.read_bytes()).decode()), encoding='utf-8')
    (ASSETS / 'raster' / 'qapaq-qapaqzito.webp').write_bytes((HERE.parents[3] / 'wazuh' / 'dashboard' / 'assets' / 'images' / 'qapaq-qapaqzito.webp').read_bytes())
    for path in sorted(ASSETS.glob('raster/*')) + sorted(ASSETS.glob('svg/*')):
        print(f'{path.relative_to(ASSETS)}: {path.stat().st_size} B')


if __name__ == '__main__':
    main()
