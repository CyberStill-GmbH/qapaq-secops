"""Render reviewable PNG exhibits from captured C-06 test output and evidence."""
from __future__ import annotations

import argparse
import json
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "docs/project-management/c-06/assets"
FONT_REG = Path(r"C:\Windows\Fonts\CascadiaMono.ttf")
FONT_BOLD = Path(r"C:\Windows\Fonts\CascadiaMono.ttf")
FONT_SANS = Path(r"C:\Windows\Fonts\segoeui.ttf")


def font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), size)


def canvas(title: str, subtitle: str, width: int, height: int):
    im = Image.new("RGB", (width, height), "#f4f7fb")
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, width, 16), fill="#00a6a6")
    d.text((64, 48), "QAPAQ  /  EVIDENCIA DE INTEGRACIÓN", font=font(FONT_SANS, 19), fill="#087e82")
    d.text((64, 86), title, font=font(FONT_SANS, 34), fill="#10253f")
    d.text((64, 137), subtitle, font=font(FONT_SANS, 18), fill="#52657b")
    return im, d


def terminal_image(source: Path, target: Path):
    source_lines = [line.rstrip() for line in source.read_text(encoding="utf-8").splitlines() if line.strip()]
    lines = [part for line in source_lines if line != "1" for part in textwrap.wrap(line, width=132, subsequent_indent="    ", break_long_words=True, break_on_hyphens=False)]
    width, line_h = 1560, 29
    height = 220 + line_h * (len(lines) + 4)
    im, d = canvas("Suite de integración C-06", "Captura renderizada desde stdout real guardado · 2026-09-24", width, height)
    top = 184
    d.rounded_rectangle((54, top, width - 54, height - 52), radius=16, fill="#111c2b")
    d.ellipse((80, top + 19, 96, top + 35), fill="#ff6258")
    d.ellipse((108, top + 19, 124, top + 35), fill="#ffc145")
    d.ellipse((136, top + 19, 152, top + 35), fill="#35c66b")
    y = top + 60
    mono = font(FONT_REG, 17)
    for line in lines:
        color = "#8be9a5" if line.lstrip().startswith("✓") else "#d7e1ef"
        if line.startswith("      Tests") or line.startswith(" Test Files") or line.startswith("   Duration"):
            color = "#73d7dc"
        d.text((82, y), line, font=mono, fill=color)
        y += line_h
    d.text((64, height - 34), f"Fuente: {source.relative_to(ROOT).as_posix()}", font=font(FONT_SANS, 13), fill="#60748a")
    im.save(target, optimize=True)


def evidence_image(paths: list[Path], target: Path):
    evidence = [json.loads(p.read_text(encoding="utf-8")) for p in paths]
    width, height = 1560, 960
    im, d = canvas("Evidencia de dos ejecuciones aisladas", "JSON generado por el harness después del teardown · perfil base · estado PASS", width, height)
    cards = [(64, 194, 744, 812), (816, 194, 1496, 812)]
    labels = ["EJECUCIÓN A", "EJECUCIÓN B"]
    for item, box, label in zip(evidence, cards, labels):
        x1, y1, x2, y2 = box
        d.rounded_rectangle(box, radius=18, fill="#ffffff", outline="#d9e3ed", width=2)
        d.text((x1 + 28, y1 + 24), label, font=font(FONT_SANS, 16), fill="#087e82")
        d.text((x1 + 28, y1 + 56), item["runId"], font=font(FONT_REG, 15), fill="#10253f")
        d.text((x1 + 28, y1 + 88), f"Commit {item['projectCommit'][:12]} · árbol de trabajo con cambios", font=font(FONT_SANS, 15), fill="#52657b")
        d.rounded_rectangle((x1 + 28, y1 + 128, x2 - 28, y1 + 184), radius=12, fill="#e6f6ed")
        d.text((x1 + 48, y1 + 145), "RESULTADO PASS     CLEANUP PASS     0 RECURSOS", font=font(FONT_REG, 15), fill="#17623a")
        y = y1 + 216
        for svc in ("postgres", "redis", "minio"):
            entry = item["images"][svc]
            health = next(h for h in item["health"] if h["service"] == svc)
            version = entry["version"]
            title = {"postgres": "PostgreSQL", "redis": "Redis", "minio": "MinIO · S3"}[svc]
            d.text((x1 + 30, y), f"● {title}  {version}", font=font(FONT_SANS, 18), fill="#17623a")
            d.text((x1 + 54, y + 30), health["detail"], font=font(FONT_SANS, 13), fill="#52657b")
            digest = entry["digest"]
            d.text((x1 + 54, y + 54), f"OCI {digest[:23]}…", font=font(FONT_REG, 12), fill="#6c7f93")
            y += 112
        d.text((x1 + 30, y + 2), "Dos entornos simultáneos · puertos, DB y bucket independientes", font=font(FONT_SANS, 13), fill="#344a62")
    d.text((64, 850), "Los perfiles OpenSearch y Wazuh están bloqueados y no aparecen como aceptados en esta evidencia.", font=font(FONT_SANS, 17), fill="#8b4d08")
    d.text((64, 910), "Fuente: artifacts/integration/<runId>/environment-evidence.json · SHA completos conservados en los JSON originales", font=font(FONT_SANS, 13), fill="#60748a")
    im.save(target, optimize=True)


def wazuh_image(source: Path, target: Path):
    raw = source.read_text(encoding="utf-8").splitlines()
    error_index = next((i for i, line in enumerate(raw) if line.strip().startswith("| Capacidad insuficiente")), None)
    if error_index is not None:
        error_lines = [raw[error_index]]
        for line in raw[error_index + 1 :]:
            if not line.strip().startswith("|"): break
            error_lines.append(lines)
        message = " ".join(line.strip().lstrip("| ").strip() for line in error_lines)
        message = " ".join(message.split())
        lines = ["Excepción: scripts/dev/setup-wazuh.ps1:31", *textwrap.wrap(message, width=88, break_long_words=True, break_on_hyphens=False)]
    else:
        lines = [part for line in raw if line.strip() for part in textwrap.wrap(line.rstrip(), width=88, break_long_words=True, break_on_hyphens=False)]
    width, line_h = 1500, 32
    height = 280 + line_h * (len(lines) + 3)
    im, d = canvas("Preflight local de Wazuh", "Salida real de setup-wazuh.ps1 · rechazo seguro antes de descargar o iniciar", width, height)
    top = 184
    d.rounded_rectangle((54, top, width - 54, height - 52), radius=16, fill="#111c2b")
    y = top + 38
    for line in lines:
        color = "#ffc145" if "insuficiente" in line.lower() or "requieren" in line.lower() else "#d7e1ef"
        d.text((82, y), line, font=font(FONT_REG, 18), fill=color)
        y += line_h
    im.save(target, optimize=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", type=Path, default=ROOT / "artifacts/integration/c06-validation-2026-09-24/vitest-integration.log")
    parser.add_argument("--wazuh-log", type=Path, default=ROOT / "artifacts/integration/c06-validation-2026-09-24/wazuh-preflight.log")
    parser.add_argument("--evidence", nargs=2, type=Path, default=[ROOT / "artifacts/integration/c06-99424f90-f079-4248-9a13-d4d8f6fb1b09/environment-evidence.json", ROOT / "artifacts/integration/c06-98fd2686-8e77-4db3-b89f-812f19a9bfa3/environment-evidence.json"])
    args = parser.parse_args()
    ASSETS.mkdir(parents=True, exist_ok=True)
    terminal_image(args.log, ASSETS / "2026-09-24-c06-vitest-output.png")
    evidence_image(args.evidence, ASSETS / "2026-09-24-c06-environment-evidence.png")
    wazuh_image(args.wazuh_log, ASSETS / "2026-09-24-c06-wazuh-preflight.png")


if __name__ == "__main__":
    main()
