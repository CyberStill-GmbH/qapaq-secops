#!/usr/bin/env python3
"""Static validation for the launch detection manifest and local Wazuh IDs."""

from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

root = Path(__file__).resolve().parents[3]
catalog_path = root / "docs/security/launch-detection-catalog-2026-10-20.json"
catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
detections = catalog["detections"]
playbook_path = Path(__file__).resolve().parent / "ankay/playbooks.json"
playbook_catalog = json.loads(playbook_path.read_text(encoding="utf-8"))
package = Path(__file__).resolve().parent

errors: list[str] = []
if catalog.get("detectionCount") != 30 or len(detections) != 30:
    errors.append(f"se requieren exactamente 30 detecciones; catálogo={len(detections)}")

ids = [d.get("id") for d in detections]
if len(set(ids)) != len(ids):
    errors.append("IDs QPD duplicados")

known_rules: set[str] = set()
for path in (root / "infra/wazuh").rglob("*.xml"):
    try:
        ET.parse(path)
    except ET.ParseError as exc:
        errors.append(f"XML inválido en {path.relative_to(root)}: {exc}")
        continue
    known_rules.update(re.findall(r'<rule\s+id="(\d+)"', path.read_text(encoding="utf-8")))

local_rules = ET.parse(package / "rules/qapaq_launch_provider_rules.xml").getroot()
local_ids = [rule.attrib.get("id") for rule in local_rules.findall(".//rule")]
if len(local_ids) != len(set(local_ids)):
    errors.append("IDs duplicados en las reglas de lanzamiento")
if any(not rule_id or not 101200 <= int(rule_id) <= 101215 for rule_id in local_ids):
    errors.append("las reglas locales deben usar únicamente el rango 101200-101215")

fixtures = [json.loads(line) for line in (package / "tests/provider-cases.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
expected = [line.strip() for line in (package / "tests/expected-rules.txt").read_text(encoding="utf-8").splitlines() if line.strip()]
if len(fixtures) != len(expected):
    errors.append(f"fixtures={len(fixtures)} no coincide con expected-rules={len(expected)}")

for profile in (package / "agent-groups").glob("*.agent.conf"):
    try:
        ET.parse(profile)
    except ET.ParseError as exc:
        errors.append(f"perfil XML inválido en {profile.relative_to(root)}: {exc}")

for detection in detections:
    for field in ("priority", "name", "sources", "engine", "logic", "requires", "activation"):
        if not detection.get(field):
            errors.append(f"{detection.get('id')}: falta {field}")
    if detection.get("priority") not in {"P0", "P1", "P2"}:
        errors.append(f"{detection.get('id')}: prioridad inválida")
    for rule_id in detection.get("ruleRefs", []):
        if rule_id not in known_rules:
            errors.append(f"{detection.get('id')}: referencia inexistente a regla {rule_id}")

catalog_detection_ids = set(ids)
playbooks = playbook_catalog.get("playbooks", [])
if len(playbooks) < 6:
    errors.append(f"se requieren seis playbooks de triage; catálogo={len(playbooks)}")
for playbook in playbooks:
    if playbook.get("trigger", {}).get("catalogDetection") not in catalog_detection_ids:
        errors.append(f"{playbook.get('id')}: detection trigger no existe en catálogo")
    if playbook.get("response", {}).get("externalEffects") != []:
        errors.append(f"{playbook.get('id')}: efecto externo habilitado en perfil read-only")
    if not playbook.get("input", {}).get("prohibited"):
        errors.append(f"{playbook.get('id')}: faltan campos prohibidos en el contrato de entrada")
if playbook_catalog.get("status") != "spec-only-not-importable":
    errors.append("playbooks Ankay deben permanecer marcados como no importables hasta validar con Shuffle")

if errors:
    print("\n".join(f"ERROR: {error}" for error in errors), file=sys.stderr)
    raise SystemExit(1)

print(f"PASS: {len(detections)} detecciones, IDs únicos y referencias Wazuh válidas")
