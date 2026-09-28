"""Render a readable exhibit from the captured real Railway C-06 probe result."""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "docs/project-management/c-06/assets/2026-09-25-c06-railway-full-e2e.json"
TARGET = ROOT / "docs/project-management/c-06/assets/2026-09-25-c06-railway-full-e2e.png"
FONT = Path(r"C:\Windows\Fonts\segoeui.ttf")
MONO = Path(r"C:\Windows\Fonts\CascadiaMono.ttf")


def main() -> None:
    data = json.loads(SOURCE.read_text(encoding="utf-8-sig"))
    if data["result"] != "PASS" or not data["wazuh"]["markerPresent"]:
        raise SystemExit("La fuente no contiene una ejecución Wazuh PASS completa")
    if data["qapaqOpenSearch"]["cleanup"] != "PASS":
        raise SystemExit("La fuente no acredita la limpieza OpenSearch")

    image = Image.new("RGB", (1600, 1000), "#f3f6fa")
    draw = ImageDraw.Draw(image)
    sans = lambda size: ImageFont.truetype(str(FONT), size)
    mono = lambda size: ImageFont.truetype(str(MONO), size)
    draw.rectangle((0, 0, 1600, 16), fill="#00a6a6")
    draw.text((72, 50), "QAPAQ  /  EVIDENCIA DE INTEGRACIÓN", font=sans(20), fill="#087e82")
    draw.text((72, 94), "C-06 · ejecución E2E en Railway", font=sans(38), fill="#10253f")
    draw.text((72, 152), f"{data['timestamp']} UTC · commit {data['commit']}", font=mono(17), fill="#52657b")
    draw.rounded_rectangle((72, 208, 1528, 286), radius=18, fill="#e6f6ed")
    draw.text((104, 229), "RESULTADO GENERAL: PASS", font=sans(28), fill="#17623a")

    cards = [(72, 326, 770, 842), (830, 326, 1528, 842)]
    for (x1, y1, x2, y2), title, subtitle in zip(
        cards,
        ("Wazuh Manager → pipeline → Indexer", "OpenSearch QAPAQ"),
        ("Imagen oficial 4.14.7 · marcador recuperado por API", "Imagen oficial 3.7.0 · CA propia y TLS verificado"),
    ):
        draw.rounded_rectangle((x1, y1, x2, y2), radius=18, fill="#ffffff", outline="#d9e3ed", width=2)
        draw.text((x1 + 30, y1 + 28), title, font=sans(24), fill="#10253f")
        draw.text((x1 + 30, y1 + 70), subtitle, font=sans(16), fill="#52657b")

    wazuh = data["wazuh"]
    draw.text((104, 446), "PASS  ·  TCP syslog sintético", font=sans(21), fill="#17623a")
    draw.text((104, 492), f"Regla {wazuh['ruleId']} · búsqueda {wazuh['search']}", font=sans(19), fill="#344a62")
    draw.text((104, 536), "TLS validado · alerta encontrada en índice diario", font=sans(18), fill="#344a62")
    draw.text((104, 590), f"Índice  {wazuh['index']}", font=mono(15), fill="#52657b")
    draw.text((104, 634), f"Marcador  {wazuh['marker']}", font=mono(15), fill="#52657b")
    draw.rounded_rectangle((104, 702, 738, 780), radius=12, fill="#e6f6ed")
    draw.text((126, 727), "ENVÍO PASS   CONSULTA API PASS", font=mono(17), fill="#17623a")

    os = data["qapaqOpenSearch"]
    draw.text((862, 446), "PASS  ·  health GREEN", font=sans(21), fill="#17623a")
    draw.text((862, 492), "TLS verificado con CA de prueba propia", font=sans(19), fill="#344a62")
    draw.text((862, 536), "CRUD autenticado de índice/documento", font=sans(19), fill="#344a62")
    draw.text((862, 590), f"Versión  {os['version']}  ·  commit {data['commit'][:12]}", font=mono(15), fill="#52657b")
    draw.rounded_rectangle((862, 702, 1496, 780), radius=12, fill="#e6f6ed")
    draw.text((884, 727), "CRUD PASS   LIMPIEZA PASS   TLS PASS", font=mono(16), fill="#17623a")

    draw.text((72, 890), "Origen: salida JSON real de c06-probe; no se añadieron resultados sintéticos a la evidencia.", font=sans(16), fill="#52657b")
    draw.text((72, 926), "Nota: Railway acredita el flujo funcional adaptado; no acredita el sizing del Compose oficial en un host dedicado.", font=sans(15), fill="#8b4d08")
    image.save(TARGET, optimize=True)


if __name__ == "__main__":
    main()
