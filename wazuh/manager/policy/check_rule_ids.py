#!/usr/bin/env python3
"""Detecta colisiones de IDs entre las reglas QAPAQ y el resto del ruleset (docs/16-politicas.md).

Uso: check_rule_ids.py [--installed <ids.txt>] <regla.xml>...

- Cada ID QAPAQ aparece una sola vez entre todos los archivos QAPAQ (salvo overwrite="yes").
- Todos los IDs QAPAQ están en el rango de usuario de Wazuh (100000–120000).
- Con --installed: archivo "<id> <archivo>" por línea con los IDs que ya existen en el manager
  fuera de los archivos QAPAQ (ruleset oficial y etc/rules ajenos). Ninguno debe coincidir con un
  ID QAPAQ salvo overwrite="yes" deliberado.
Sale 1 si hay colisiones; imprime un resumen por archivo.
"""

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

USER_RANGE = range(100000, 120001)


def rules_in(path):
    text = Path(path).read_text(encoding="utf-8")
    # Los archivos de reglas tienen varios <group> raíz: se envuelven para parsearlos.
    text = re.sub(r"<\?xml[^>]*\?>", "", text)
    root = ET.fromstring(f"<root>{text}</root>")
    for rule in root.iter("rule"):
        yield int(rule.attrib["id"]), rule.attrib.get("overwrite", "no") == "yes"


def main(argv):
    installed = {}
    if argv[:1] == ["--installed"]:
        for line in Path(argv[1]).read_text(encoding="utf-8").splitlines():
            parts = line.split(maxsplit=1)
            if parts and parts[0].isdigit():
                installed.setdefault(int(parts[0]), parts[1] if len(parts) > 1 else "?")
        argv = argv[2:]
    if not argv:
        sys.exit(__doc__)

    seen, errors = {}, []
    for path in argv:
        ids = []
        for rid, overwrite in rules_in(path):
            ids.append(rid)
            name = Path(path).name
            if rid not in USER_RANGE and not overwrite:
                errors.append(f"{name}: ID {rid} fuera del rango de usuario 100000-120000")
            if rid in seen and not overwrite:
                errors.append(f"{name}: ID {rid} duplicado (ya en {seen[rid]})")
            if rid in installed and not overwrite:
                errors.append(f"{name}: ID {rid} ya existe en el manager ({installed[rid]})")
            seen.setdefault(rid, name)
        span = f"{min(ids)}-{max(ids)}" if ids else "vacío"
        print(f"{Path(path).name}: {len(ids)} reglas ({span})")
    if errors:
        print("\n".join(errors))
        return 1
    print(f"OK: {len(seen)} IDs QAPAQ únicos, sin colisiones")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
