"""Render a readable exhibit from the actual Vitest C-08 contract run."""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "docs/project-management/c-08/assets/2026-09-25-c08-contract-run.json"
TARGET = ROOT / "docs/project-management/c-08/assets/2026-09-25-c08-contract-suite.png"
FONT = Path(r"C:\Windows\Fonts\segoeui.ttf")
MONO = Path(r"C:\Windows\Fonts\CascadiaMono.ttf")


def main() -> None:
    data = json.loads(SOURCE.read_text(encoding="utf-8-sig"))
    if not data.get("success") or data.get("numFailedTests") != 0:
        raise SystemExit("El JSON no contiene una ejecución C-08 aprobada")
    if data.get("numTotalTests") != 26 or data.get("numPassedTests") != 26:
        raise SystemExit("La ejecución C-08 no coincide con los 26 casos registrados")
    assertions = [
        test
        for result in data.get("testResults", [])
        for test in result.get("assertionResults", [])
    ]
    contract_count = sum(
        test.get("fullName", "").split("SecurityEventProvider contract")[-1] != test.get("fullName", "")
        and test.get("status") == "passed"
        for test in assertions
    )
    if contract_count != 18:
        raise SystemExit(f"Se esperaban 18 verificaciones contractuales; encontradas: {contract_count}")

    image = Image.new("RGB", (1600, 940), "#f3f6fa")
    draw = ImageDraw.Draw(image)
    sans = lambda size: ImageFont.truetype(str(FONT), size)
    mono = lambda size: ImageFont.truetype(str(MONO), size)
    draw.rectangle((0, 0, 1600, 16), fill="#00a6a6")
    draw.text((72, 48), "QAPAQ  /  EVIDENCIA DE PRUEBAS", font=sans(20), fill="#087e82")
    draw.text((72, 91), "C-08 - contract suite local", font=sans(38), fill="#10253f")
    draw.text((72, 148), "2026-09-25 | rama codex/c08-wazuh-provider | base main 706fbec", font=mono(17), fill="#52657b")

    draw.rounded_rectangle((72, 208, 1528, 304), radius=18, fill="#e6f6ed")
    draw.text((105, 225), "RESULTADO DE LA SUITE: PASS", font=sans(28), fill="#17623a")
    draw.text((105, 267), "26 de 26 tests pasaron; 0 fallaron", font=sans(20), fill="#344a62")

    cards = [(72, 344, 770, 756), (830, 344, 1528, 756)]
    draw.rounded_rectangle(cards[0], radius=18, fill="#ffffff", outline="#d9e3ed", width=2)
    draw.rounded_rectangle(cards[1], radius=18, fill="#ffffff", outline="#d9e3ed", width=2)
    draw.text((104, 375), "Contrato portable", font=sans(25), fill="#10253f")
    draw.text((104, 420), "18 / 18 verificaciones", font=mono(23), fill="#17623a")
    for index, label in enumerate(("Capabilities y health", "Página, orden y determinismo", "Cursor, alcance y expiración", "Límites, tiempo y cancelación", "Errores sanitizados y read-only")):
        draw.text((118, 482 + index * 42), f"PASS  {label}", font=sans(19), fill="#344a62")

    draw.text((862, 375), "Límite de esta evidencia", font=sans(25), fill="#10253f")
    draw.rounded_rectangle((862, 423, 1496, 500), radius=12, fill="#fff4df")
    draw.text((888, 447), "HARNESS CONTROLADO - cliente simulado", font=sans(18), fill="#895b08")
    draw.text((862, 532), "Esta corrida no contactó Manager ni Indexer.", font=sans(19), fill="#344a62")
    draw.text((862, 576), "No acredita TLS, credenciales, permisos, mapping", font=sans(18), fill="#344a62")
    draw.text((862, 610), "ni consulta autorizada en una instancia real.", font=sans(18), fill="#344a62")
    draw.text((862, 676), "Aprobación real: gate diferido al E2E final del MVP.", font=sans(16), fill="#52657b")

    draw.text((72, 817), "Fuente: JSON completo generado por Vitest y conservado en este repositorio.", font=sans(16), fill="#52657b")
    draw.text((72, 850), "scripts/ci/render-c08-contract-evidence.py", font=mono(14), fill="#60748a")
    image.save(TARGET, optimize=True)


if __name__ == "__main__":
    main()
