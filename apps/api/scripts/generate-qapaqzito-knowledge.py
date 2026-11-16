#!/usr/bin/env python3
"""Genera el conocimiento estático de Qapaqzito: runbooks, playbooks, reglas QAPAQ y su mapeo MITRE.

Fuentes (docs/17 · ingeniería de detección):
  - docs/detection-engineering/runbooks/*.md         → runbooks de triage e investigación
  - docs/detection-engineering/04-playbooks-*.md     → playbooks de Ankay
  - detections/*/*/metadata.yaml                     → casos de uso (MITRE, prioridad, falsos positivos)
  - XML de reglas QAPAQ (rutas de RULE_FILES)          → descripción, nivel y técnicas por regla
  - detections/mitre/attack-qapaq.json                 → nombres y tácticas de técnicas
  - detections/wazuh-stock/stock-rules.yaml          → reglas estándar de Wazuh con volumen y su guía

Salida: apps/api/src/assistant/soc-knowledge.generated.ts (versionado; la imagen de la API no
necesita docs/ ni detections/). Regenerar al cambiar runbooks o reglas:

    python apps/api/scripts/generate-qapaqzito-knowledge.py           # escribe
    python apps/api/scripts/generate-qapaqzito-knowledge.py --check   # falla si está desactualizado
"""

from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "apps/api/src/assistant/soc-knowledge.generated.ts"
RUNBOOKS = ROOT / "docs/detection-engineering/runbooks"
PLAYBOOKS = ROOT / "docs/detection-engineering/04-playbooks-ankay.md"
ATTACK = ROOT / "detections/mitre/attack-qapaq.json"
STOCK = ROOT / "detections/wazuh-stock/stock-rules.yaml"
RULE_FILES = sorted(
    {
        *(p.relative_to(ROOT).as_posix() for p in ROOT.glob("detections/*/*/rule.xml")),
        "infra/wazuh/active-directory/rules/qapaq_active_directory_rules.xml",
        "infra/wazuh/endpoint/rules/qapaq_endpoint_rules.xml",
        "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
        "infra/wazuh/launch-detections/rules/qapaq_provider_service_rules.xml",
        "wazuh/aws-events/rules/qapaq_aws_rules.xml",
        "wazuh/office365/rules/qapaq_office365_rules.xml",
        "wazuh/platform-monitoring/rules/qapaq_watch_platform_rules.xml",
        "wazuh/platform-monitoring/rules/qapaq_watch_vulnprio_rules.xml",
        "wazuh/provider-ingestion/rules/qapaq_bitdefender_rules.xml",
        "wazuh/provider-ingestion/rules/qapaq_cloudflare_rules.xml",
        "wazuh/provider-ingestion/rules/qapaq_snyk_rules.xml",
    }
)
RULE_ID = re.compile(r"\b(10[01]\d{3})\b")
RANGE = re.compile(r"\b(10[01]\d{3})\s*[–-]\s*(10[01]\d{3})\b")


def parse_rules(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8")
    # Los archivos de Wazuh tienen varios <group> raíz: se envuelven para que sea XML válido.
    text = re.sub(r"<\?xml[^>]*\?>", "", text)
    root = ET.fromstring(f"<root>{text}</root>")
    rules = []
    for rule in root.iter("rule"):
        rule_id = rule.get("id", "")
        if not RULE_ID.fullmatch(rule_id):
            continue
        description = " ".join((rule.findtext("description") or "").split())
        mitre = [m.text.strip() for m in rule.iter("id") if m.text and m.text.strip().startswith("T")]
        groups = ",".join((g.text or "") for g in rule.iter("group")).strip(",")
        rules.append(
            {
                "id": rule_id,
                "level": int(rule.get("level", "0")),
                "description": description,
                "mitre": mitre,
                "groups": [g for g in re.split(r"[,\s]+", groups) if g][:8],
                "file": path.relative_to(ROOT).as_posix(),
            }
        )
    return rules


def rule_ids_in(text: str) -> list[str]:
    ids = set(RULE_ID.findall(text))
    for start, end in RANGE.findall(text):
        a, b = int(start), int(end)
        if 0 < b - a <= 100:
            ids.update(str(n) for n in range(a, b + 1))
    return sorted(ids)


def section_titles(markdown: str) -> list[str]:
    return [line[3:].strip() for line in markdown.splitlines() if line.startswith("## ")]


def main() -> int:
    attack = json.loads(ATTACK.read_text(encoding="utf-8"))
    tactic_es = {t["key"]: t["es"] for t in attack["tactics"]}
    tactic_id = {t["key"]: t["id"] for t in attack["tactics"]}
    techniques_src = attack["techniques"]
    techniques_items = techniques_src.items() if isinstance(techniques_src, dict) else techniques_src

    rules: dict[str, dict] = {}
    for rel in RULE_FILES:
        path = ROOT / rel
        if path.exists():
            for rule in parse_rules(path):
                rules.setdefault(rule["id"], rule)

    # Reglas estándar de Wazuh: metadatos del ruleset y guía QAPAQ (no se instalan; solo contexto).
    stock = yaml.safe_load(STOCK.read_text(encoding="utf-8")) if STOCK.exists() else {}
    stock_ids: list[str] = []
    for rule in stock.get("rules") or []:
        rule_id = str(rule["id"])
        stock_ids.append(rule_id)
        rules.setdefault(
            rule_id,
            {
                "id": rule_id,
                "level": int(rule.get("level", 0)),
                "description": " ".join(str(rule.get("description", "")).split()),
                "mitre": [str(t) for t in rule.get("mitre") or []],
                "groups": [str(g) for g in rule.get("groups") or []][:8],
                "file": f"wazuh-ruleset/{rule.get('file', '')} ({stock.get('ruleset', 'wazuh')})",
            },
        )

    use_cases = []
    for item in stock.get("use_cases") or []:
        ids = [str(i) for i in item.get("rule_ids") or []]
        use_case = {
            "id": item["id"],
            "title": item["title"],
            "source": "wazuh-stock",
            "useCase": item["use_case"],
            "status": "stable",
            "ruleIds": ids,
            "mitre": [str(t) for t in item.get("mitre") or []],
            "priorityHint": item.get("priority_hint"),
            "falsePositives": [str(fp) for fp in (item.get("false_positives") or [])][:6],
            "dataSources": [str(ds) for ds in (item.get("data_sources") or [])][:4],
            "escalateWhen": [str(e) for e in (item.get("escalate_when") or [])][:6],
        }
        use_cases.append(use_case)
        for rule_id in ids:
            if rule_id in rules:
                rules[rule_id].setdefault("useCases", []).append(use_case["id"])

    for meta_path in sorted(ROOT.glob("detections/*/*/metadata.yaml")):
        meta = yaml.safe_load(meta_path.read_text(encoding="utf-8")) or {}
        ids = [str(i) for i in ((meta.get("rules") or {}).get("ids") or [])]
        severity = meta.get("severity") or {}
        use_case = {
            "id": meta.get("id"),
            "title": meta.get("title"),
            "source": meta.get("source"),
            "useCase": meta.get("use_case"),
            "status": meta.get("status"),
            "ruleIds": ids,
            "mitre": [m.get("technique") for m in meta.get("mitre") or [] if m.get("technique")],
            "priorityHint": severity.get("priority_hint"),
            "falsePositives": [str(fp) for fp in (meta.get("false_positives") or [])][:5],
            "dataSources": [str(ds) for ds in (meta.get("data_sources") or [])][:4],
        }
        use_cases.append(use_case)
        for rule_id in ids:
            if rule_id in rules:
                rules[rule_id].setdefault("useCases", []).append(use_case["id"])

    runbooks = []
    for path in sorted(RUNBOOKS.glob("*.md")):
        if path.name == "README.md":
            continue
        markdown = path.read_text(encoding="utf-8").strip()
        title = markdown.splitlines()[0].lstrip("# ").replace("Runbook · ", "").strip()
        scope = next((l for l in markdown.splitlines() if l.startswith("Alcance")), "")
        # El alcance manda; incluye ids de reglas estándar nombradas en él.
        scoped = set(rule_ids_in(scope)) | {i for i in stock_ids if re.search(rf"(?<!\d){i}(?!\d)", scope)}
        ids = scoped or set(rule_ids_in(markdown))
        # Los runbooks citan casos de uso como `fuente/caso-de-uso`: sus reglas también aplican.
        linked = [u for u in use_cases if f"{u['source']}/{u['useCase']}" in markdown]
        for use_case in linked:
            ids.update(use_case["ruleIds"])
        ids = sorted(ids)
        runbook = {
            "id": path.stem,
            "title": title,
            "path": path.relative_to(ROOT).as_posix(),
            "sections": section_titles(markdown),
            "ruleIds": ids,
            "useCases": [u["id"] for u in linked],
            "markdown": markdown,
        }
        runbooks.append(runbook)
        for rule_id in ids:
            if rule_id in rules:
                rules[rule_id].setdefault("runbooks", [])
                if path.stem not in rules[rule_id]["runbooks"]:
                    rules[rule_id]["runbooks"].append(path.stem)

    index_md = (RUNBOOKS / "README.md").read_text(encoding="utf-8").strip()
    playbooks_md = PLAYBOOKS.read_text(encoding="utf-8").strip()

    used = {t for r in rules.values() for t in r["mitre"]} | {t for u in use_cases for t in u["mitre"]}
    techniques = {}
    for tech_id, info in techniques_items:
        if tech_id in used:
            techniques[tech_id] = {
                "name": info.get("name"),
                "tactics": [
                    {"id": tactic_id.get(t, ""), "name": tactic_es.get(t, t)} for t in info.get("tactics", [])
                ],
            }

    knowledge = {
        "attackVersion": attack.get("attack_version"),
        "runbookIndex": index_md,
        "playbooks": playbooks_md,
        "runbooks": runbooks,
        "useCases": use_cases,
        "rules": dict(sorted(rules.items())),
        "techniques": dict(sorted(techniques.items())),
    }
    body = json.dumps(knowledge, ensure_ascii=False, indent=1)
    output = (
        "// GENERADO por apps/api/scripts/generate-qapaqzito-knowledge.py. No editar a mano.\n"
        "// Fuentes: docs/detection-engineering (runbooks, playbooks), detections/ y XML de reglas QAPAQ.\n"
        "/* eslint-disable */\n"
        "import type { SocKnowledge } from './soc-knowledge.js';\n\n"
        f"export const SOC_KNOWLEDGE: SocKnowledge = {body};\n"
    )
    if "--check" in sys.argv:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if current != output:
            print(f"{OUT.relative_to(ROOT)} está desactualizado: regenéralo.", file=sys.stderr)
            return 1
        return 0
    OUT.write_text(output, encoding="utf-8", newline="\n")
    print(
        f"{OUT.relative_to(ROOT)}: {len(runbooks)} runbooks, {len(rules)} reglas, "
        f"{len(use_cases)} casos de uso, {len(techniques)} técnicas"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
