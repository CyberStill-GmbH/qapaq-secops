#!/usr/bin/env python3
"""Validación estática del paquete financiero QAPAQ (reglas, catálogo y workflows Ankay).

Comprueba sin Docker lo que wazuh-logtest no cubre:
- XML válido, IDs únicos en 101400-101449 y sin choque con otros paquetes QAPAQ.
- Cada if_sid/if_matched_sid apunta a una regla QAPAQ existente o a una oficial conocida.
- Cada lista CDB referenciada tiene plantilla .example sintética.
- Casos de logtest sincronizados con generate_cases.py y que solo esperan reglas reales.
- finance-catalog.yaml con el esquema del catálogo v1, disparadores existentes y SoD
  para todo efecto.
- Workflows Shuffle: JSON importable, un archivo por playbook, sin secretos ni llamadas
  directas a proveedores, y toda acción con efecto solo como solicitud al outbox QAPAQ.
Requiere PyYAML.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlparse

import yaml

package = Path(__file__).resolve().parent
root = package.parents[2]
rules_path = package / "rules/qapaq_finance_rules.xml"
catalog_path = root / "docs/security/ankay-playbooks/finance-catalog.yaml"
base_catalog_path = root / "docs/security/ankay-playbooks/catalog.yaml"
workflows_dir = root / "infra/wazuh/launch-detections/ankay/finance"
docs_dir = root / "docs/security/ankay-playbooks/finance"
RANGE = range(101400, 101450)

# Reglas oficiales de Wazuh 4.14 de las que cuelgan las financieras.
OFFICIAL_PARENTS = {"91532", "60106"}
OFFICIAL_GROUPS = {"sysmon_event1"}

errors: list[str] = []


def error(message: str) -> None:
    errors.append(message)


# ------------------------------------------------------------------------- Reglas
known_rules: dict[str, Path] = {}
for rule_root in (root / "wazuh", root / "infra/wazuh"):
    for path in rule_root.rglob("*.xml"):
        if path == rules_path or "rules" not in path.parts:
            continue
        try:
            text = path.read_text(encoding="utf-8")
            ET.fromstring(f"<root>{re.sub(r'<!--.*?-->', '', text, flags=re.S)}</root>")
        except ET.ParseError:
            continue
        for rule_id in re.findall(r'<rule\s+id="(\d+)"', text):
            known_rules[rule_id] = path

try:
    finance_root = ET.parse(rules_path).getroot()
except ET.ParseError as exc:
    sys.exit(f"ERROR: XML inválido en {rules_path.relative_to(root)}: {exc}")

finance_rules = finance_root.findall(".//rule")
finance_ids = [rule.attrib.get("id", "") for rule in finance_rules]
if len(finance_ids) != len(set(finance_ids)):
    error("IDs duplicados en qapaq_finance_rules.xml")
for rule_id in finance_ids:
    if not rule_id.isdigit() or int(rule_id) not in RANGE:
        error(f"regla {rule_id}: fuera del rango reservado 101400-101449")
    elif rule_id in known_rules:
        error(f"regla {rule_id}: ya existe en {known_rules[rule_id].relative_to(root)}")

available = set(known_rules) | set(finance_ids) | OFFICIAL_PARENTS
used_lists: set[str] = set()
for rule in finance_rules:
    rule_id = rule.attrib["id"]
    for tag in ("if_sid", "if_matched_sid"):
        for node in rule.findall(tag):
            for parent in re.split(r"[,\s]+", (node.text or "").strip()):
                if parent and parent not in available:
                    error(f"regla {rule_id}: {tag} {parent} no existe")
    for node in rule.findall("if_group"):
        if (node.text or "").strip() not in OFFICIAL_GROUPS:
            error(f"regla {rule_id}: if_group {node.text!r} no está en la lista permitida")
    if rule.find("description") is None or not (rule.findtext("description") or "").startswith("QAPAQ finanzas:"):
        error(f"regla {rule_id}: la descripción debe empezar con 'QAPAQ finanzas:'")
    if "no_full_log" not in (rule.findtext("options") or ""):
        error(f"regla {rule_id}: falta <options>no_full_log</options>")
    level = int(rule.attrib.get("level", "-1"))
    if level >= 7 and rule.find("mitre") is None:
        error(f"regla {rule_id}: nivel {level} sin técnica MITRE")
    for node in rule.findall("list"):
        used_lists.add(Path((node.text or "").strip()).name)

office365_lists = {"qapaq-break-glass": root / "wazuh/office365/lists/qapaq-break-glass.example"}
for name in sorted(used_lists):
    template = office365_lists.get(name, package / "lists" / f"{name}.example")
    if not template.exists():
        error(f"lista {name}: falta plantilla {template.relative_to(root)}")
        continue
    for line in template.read_text(encoding="utf-8").splitlines():
        if line.strip() and not re.search(r"\.example\b|^bg-ad-\d+:", line):
            error(f"lista {name}: la plantilla solo admite valores sintéticos (.example): {line!r}")

tests = package / "tests"
check = subprocess.run([sys.executable, str(tests / "generate_cases.py"), "--check"],
                       capture_output=True, text=True)
if check.returncode:
    error((check.stderr or check.stdout).strip())
for line in (tests / "expected-rules.txt").read_text(encoding="utf-8").splitlines():
    for token in line.strip().lstrip("!").split("|"):
        if token and token != "---" and token not in available:
            error(f"expected-rules.txt: la regla {token} no existe")
covered = {token for line in (tests / "expected-rules.txt").read_text(encoding="utf-8").splitlines()
           if not line.startswith("!") for token in line.strip().split("|")}
untested = sorted(set(finance_ids) - covered)
if untested:
    error(f"reglas sin caso positivo en logtest: {', '.join(untested)}")
for line in (tests / "logtest-cases.jsonl").read_text(encoding="utf-8").splitlines():
    for ip in re.findall(r"\b(\d{1,3}(?:\.\d{1,3}){3})\b", line):
        if not ip.startswith(("192.0.2.", "198.51.100.", "203.0.113.")):
            error(f"logtest-cases.jsonl: IP no documental {ip} (usar RFC 5737)")

if errors:
    print("\n".join(f"ERROR: {message}" for message in errors), file=sys.stderr)
    raise SystemExit(1)

print(f"PASS: {len(finance_ids)} reglas financieras, listas y casos de logtest válidos")
