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
OFFICIAL_PARENTS = {"91532", "91537", "60106", "60118", "60119", "92651", "92652", "92653"}
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

# ----------------------------------------------------------------------- Catálogo
catalog = yaml.safe_load(catalog_path.read_text(encoding="utf-8"))
base_catalog = yaml.safe_load(base_catalog_path.read_text(encoding="utf-8"))
REQUIRED_PLAYBOOKS = {
    "finance.bec-payment-fraud", "finance.credit-core-account-takeover",
    "finance.customer-data-exfiltration", "finance.privileged-breakglass-abuse",
    "finance.branch-ransomware", "finance.brand-impersonation-phishing",
    "finance.insider-fraud", "finance.significant-incident-regulatory",
}
V1_FIELDS = ("id", "version", "status", "trigger", "sources", "actions", "approval", "effects")
FINANCE_FIELDS = ("name", "priority", "triggerRules", "triage", "humanDecision", "requestableEffects",
                  "evidence", "sla", "metrics", "runbook", "workflow", "regulatory")

if catalog.get("schemaVersion") != base_catalog.get("schemaVersion"):
    error("finance-catalog.yaml debe usar el mismo schemaVersion que catalog.yaml")
if catalog.get("catalogId") != "qapaq-ankay-finance":
    error("catalogId debe ser qapaq-ankay-finance")
if catalog.get("engine") != base_catalog.get("engine"):
    error("engine debe coincidir con catalog.yaml (misma versión fijada de Ankay/Shuffle)")

effects = {item["effect"]: item for item in catalog.get("effectCatalog", [])}
base_playbooks = {item["id"] for item in base_catalog.get("playbooks", [])}
for item in effects.values():
    executor, status = item.get("executor", ""), item.get("status")
    if executor.startswith("containment.") and executor in base_playbooks and status != "disabled":
        error(f"efecto {item['effect']}: el ejecutor del catálogo base debe seguir disabled")
    if executor.startswith("containment.") and executor not in base_playbooks and status != "proposed-disabled":
        error(f"efecto {item['effect']}: ejecutor nuevo {executor} debe marcarse proposed-disabled")
    if executor.startswith("human-runbook:") and status != "manual":
        error(f"efecto {item['effect']}: un ejecutor humano debe marcarse manual")

metric_names = set(catalog.get("metricDefinitions", {}))
sla_levels = set(catalog.get("slaPolicy", {}))
playbooks = catalog.get("playbooks", [])
playbook_ids = [item.get("id") for item in playbooks]
if len(playbook_ids) != len(set(playbook_ids)):
    error("IDs de playbook duplicados en finance-catalog.yaml")
missing = REQUIRED_PLAYBOOKS - set(playbook_ids)
if missing:
    error(f"faltan playbooks obligatorios: {', '.join(sorted(missing))}")
if set(playbook_ids) & base_playbooks:
    error("los IDs financieros no pueden repetir IDs de catalog.yaml")

matrix_path = docs_dir / "matriz-cumplimiento-sbs-anpd.md"
matrix_text = matrix_path.read_text(encoding="utf-8") if matrix_path.exists() else ""
if not matrix_text:
    error(f"falta {matrix_path.relative_to(root)}")

for playbook in playbooks:
    pid = playbook.get("id", "?")
    for field in V1_FIELDS + FINANCE_FIELDS:
        if field not in playbook:
            error(f"{pid}: falta {field}")
    if playbook.get("effects") != "none":
        error(f"{pid}: el workflow financiero no puede tener efectos propios (effects: none)")
    if "dual-control-sod" not in str(playbook.get("approval", "")):
        error(f"{pid}: approval debe exigir control dual y SoD para todo efecto")
    if playbook.get("priority") not in sla_levels or playbook.get("sla") not in sla_levels:
        error(f"{pid}: prioridad o SLA fuera de slaPolicy")
    for metric in playbook.get("metrics", []):
        if metric not in metric_names:
            error(f"{pid}: métrica {metric} sin definición")
    rules = playbook.get("triggerRules", {})
    for rule_id in rules.get("primary", []) + rules.get("context", []):
        if rule_id not in available:
            error(f"{pid}: el disparador {rule_id} no existe")
    if not rules.get("primary") and not rules.get("manualIntake"):
        error(f"{pid}: necesita regla primaria o ingreso manual documentado")
    for request in playbook.get("requestableEffects", []):
        if request.get("effect") not in effects:
            error(f"{pid}: efecto {request.get('effect')} no está en effectCatalog")
        if not request.get("approverRoles") or not request.get("constraints"):
            error(f"{pid}: efecto {request.get('effect')} sin aprobadores o restricciones")
    for path_field in ("runbook", "workflow"):
        if not (root / playbook.get(path_field, "")).is_file():
            error(f"{pid}: no existe {playbook.get(path_field)}")
    for ref in playbook.get("regulatory", []):
        if f"`{ref}`" not in matrix_text:
            error(f"{pid}: la referencia regulatoria {ref} no está en la matriz")

# ---------------------------------------------------------------------- Workflows
build = subprocess.run([sys.executable, str(workflows_dir / "build_workflows.py"), "--check"],
                       capture_output=True, text=True)
if build.returncode:
    error((build.stderr or build.stdout).strip())

ALLOWED_APPS = {("http", "POST"), ("Shuffle Tools", "execute_python")}
READ_ONLY_PATHS = ("/v1/ankay/dispatch/verify", "/v1/ankay/enrichment")
SECRET_PATTERN = re.compile(r"(?i)(bearer\s+[a-z0-9._-]{12,}|api[_-]?key\s*[:=]|client_secret|"
                            r"password\s*[:=]\s*\S|-----BEGIN|sig=|x-functions-key)")
expected_files = {Path(item["workflow"]).name for item in playbooks}
actual_files = {path.name for path in workflows_dir.glob("*.json")}
if expected_files != actual_files:
    error(f"workflows sin playbook o faltantes: {sorted(expected_files ^ actual_files)}")

for path in sorted(workflows_dir.glob("*.json")):
    text = path.read_text(encoding="utf-8")
    try:
        workflow = json.loads(text)
    except json.JSONDecodeError as exc:
        error(f"{path.name}: JSON inválido: {exc}")
        continue
    if SECRET_PATTERN.search(text):
        error(f"{path.name}: contiene un patrón de secreto")
    for key in ("actions", "branches", "triggers", "name", "start", "workflow_variables"):
        if key not in workflow:
            error(f"{path.name}: falta la clave Shuffle {key}")
    ids = {action["id"] for action in workflow.get("actions", [])}
    if workflow.get("start") not in ids:
        error(f"{path.name}: start no apunta a una acción")
    if [t.get("trigger_type") for t in workflow.get("triggers", [])] != ["WEBHOOK"]:
        error(f"{path.name}: debe tener un único trigger WEBHOOK")
    for item in workflow.get("branches", []):
        if item["source_id"] not in ids or item["destination_id"] not in ids:
            error(f"{path.name}: rama con nodos inexistentes")
    reachable, frontier = set(), [workflow.get("start")]
    while frontier:
        current = frontier.pop()
        if current in reachable:
            continue
        reachable.add(current)
        frontier += [b["destination_id"] for b in workflow.get("branches", []) if b["source_id"] == current]
    if reachable != ids:
        error(f"{path.name}: hay acciones inalcanzables")
    for variable in workflow.get("workflow_variables", []):
        if variable.get("value"):
            error(f"{path.name}: la variable {variable.get('name')} debe exportarse vacía")
    for action in workflow.get("actions", []):
        label = action.get("label")
        if (action.get("app_name"), action.get("name")) not in ALLOWED_APPS:
            error(f"{path.name}: {label} usa una app no permitida ({action.get('app_name')})")
            continue
        params = {p["name"]: p.get("value", "") for p in action.get("parameters", [])}
        if params.get("username") or params.get("password"):
            error(f"{path.name}: {label} trae credenciales en el JSON")
        if action.get("app_name") != "http":
            continue
        url = params.get("url", "")
        if not url.startswith("$qapaq_bridge_base_url/v1/ankay/") or urlparse(url).netloc:
            error(f"{path.name}: {label} llama fuera del puente QAPAQ: {url}")
        if params.get("verify") != "true":
            error(f"{path.name}: {label} debe validar TLS")
        body_text = params.get("body", "")
        if label.startswith("enrich_") and not url.endswith(READ_ONLY_PATHS):
            error(f"{path.name}: {label} no es una lectura del puente")
        if "/action-requests" in url and '"state": "pending-human-decision"' not in body_text:
            error(f"{path.name}: {label} solo puede crear solicitudes pendientes de decisión humana")

if errors:
    print("\n".join(f"ERROR: {message}" for message in errors), file=sys.stderr)
    raise SystemExit(1)

print(f"PASS: {len(finance_ids)} reglas, listas y casos de logtest; {len(playbooks)} playbooks "
      f"y {len(actual_files)} workflows Shuffle válidos")
