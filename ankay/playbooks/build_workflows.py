#!/usr/bin/env python3
"""Genera los workflows Shuffle de Ankay a partir de los catálogos QAPAQ.

Fuentes (todas versionadas):
  - docs/security/ankay-playbooks/*catalog*.yaml   (esquema v1 de catalog.yaml)
  - infra/wazuh/launch-detections/ankay/playbooks.json
  - infra/wazuh/launch-detections/ankay/**/*.workflow.json (workflows escritos a mano)

Salida determinista en ankay/playbooks/generated/: ankay-catalog.json (lo lee la app
«QAPAQ Ankay») y workflows/<id>.json (los importa import_playbooks.py). Con --check
falla si generated/ no coincide con lo que generarían las fuentes actuales.

Reglas de seguridad: el triage desde Wazuh es de solo lectura; todo playbook con
efectos arranca solo con un despacho firmado de QAPAQ Core y termina en
hold_for_outbox, sin ejecutar el efecto.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import uuid
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
CATALOG_GLOB = "docs/security/ankay-playbooks/*catalog*.yaml"
SPEC_PATH = Path("infra/wazuh/launch-detections/ankay/playbooks.json")
HANDWRITTEN_GLOB = "infra/wazuh/launch-detections/ankay/**/*.workflow.json"
DIST = Path(__file__).resolve().parent / "generated"

APP_NAME = "QAPAQ Ankay"
APP_VERSION = "1.0.0"
APP_ID_PLACEHOLDER = "__QAPAQ_ANKAY_APP_ID__"
AUTH_ID_PLACEHOLDER = "__QAPAQ_ANKAY_DISPATCH_AUTH_ID__"
ENVIRONMENT = "Shuffle"
NAMESPACE = uuid.UUID("5d0f6a3e-7a4e-5b8e-9d1c-0a9e1c4b2f61")
WAZUH_TRIAGE_ID = "wazuh.alert-intake"
READ_ONLY_EFFECTS = {"none", "notification-only"}
PLAYBOOK_ID = re.compile(r"^[a-z0-9][a-z0-9.-]{2,95}$")
VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
ALLOWED_ACTIONS = {"triage_wazuh_alert", "verify_governed_dispatch", "prepare_read_only_triage", "hold_for_outbox"}


class CatalogError(ValueError):
    pass


def stable_id(*parts: str) -> str:
    return str(uuid.uuid5(NAMESPACE, ":".join(parts)))


def _list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, list) and all(isinstance(item, (str, int)) for item in value):
        return [str(item) for item in value]
    raise CatalogError("expected a list of strings")


def _effects(value: Any) -> str:
    if isinstance(value, list):
        return "none" if not value else ",".join(sorted(str(item) for item in value))
    if isinstance(value, str) and value:
        return value
    raise CatalogError("effects must be declared")


def load_catalogs(root: Path) -> tuple[dict[str, dict[str, Any]], list[str]]:
    playbooks: dict[str, dict[str, Any]] = {}
    sources: list[str] = []

    def add(entry: dict[str, Any]) -> None:
        if not PLAYBOOK_ID.fullmatch(entry["id"]) or not VERSION.fullmatch(entry["version"]):
            raise CatalogError(f"invalid playbook id/version in {entry['catalog']}: {entry['id']}")
        if entry["id"] in playbooks or entry["id"] == WAZUH_TRIAGE_ID:
            raise CatalogError(f"duplicate playbook id {entry['id']} ({entry['catalog']})")
        playbooks[entry["id"]] = entry

    for path in sorted(root.glob(CATALOG_GLOB)):
        rel = path.relative_to(root).as_posix()
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(document, dict) or document.get("schemaVersion") != 1:
            raise CatalogError(f"{rel}: only schemaVersion 1 catalogs are supported")
        catalog_id = str(document.get("catalogId", ""))
        for item in document.get("playbooks", []):
            if not isinstance(item, dict):
                raise CatalogError(f"{rel}: playbook entries must be objects")
            try:
                effects = _effects(item.get("effects"))
                entry = {
                    "id": str(item["id"]),
                    "version": str(item["version"]),
                    "catalog": catalog_id,
                    "status": str(item.get("status", "design-only")),
                    "trigger": str(item.get("trigger", "")),
                    "sources": _list(item.get("sources")),
                    "steps": _list(item.get("actions") or item.get("steps")),
                    "approval": str(item.get("approval", "")),
                    "effects": effects,
                    "required": _list(item.get("requiredInputs")),
                    "prohibited": _list(item.get("prohibitedInputs")),
                    "ruleIds": _list(item.get("ruleIds") or item.get("ruleId")),
                    "ruleGroups": _list(item.get("ruleGroups")),
                    "minLevel": int(item.get("minWazuhLevel", 12)),
                }
            except (KeyError, TypeError, ValueError) as error:
                raise CatalogError(f"{rel}: invalid playbook entry ({error})") from None
            if effects not in READ_ONLY_EFFECTS and "sod" not in entry["approval"].lower() and "dual" not in entry["approval"].lower():
                raise CatalogError(f"{rel}: {entry['id']} declares effects without SoD approval")
            add(entry)
        sources.append(rel)

    spec_path = root / SPEC_PATH
    if spec_path.exists():
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
        for item in spec.get("playbooks", []):
            response = item.get("response", {})
            trigger = item.get("trigger", {})
            add({
                "id": str(item["id"]),
                "version": str(item["version"]),
                "catalog": str(spec.get("profile", "")),
                "status": "prepared-read-only" if response.get("mode") == "read-only" else "disabled",
                "trigger": str(trigger.get("catalogDetection", "")),
                "sources": _list(item.get("sources")),
                "steps": _list(item.get("steps")),
                "approval": str(response.get("approval", "")),
                "effects": _effects(response.get("externalEffects", [])),
                "required": _list(item.get("input", {}).get("required")),
                "prohibited": _list(item.get("input", {}).get("prohibited")),
                "ruleIds": [],
                "ruleGroups": [],
                "minLevel": 12,
            })
        sources.append(SPEC_PATH.as_posix())
    return playbooks, sources


def _position(index: int) -> dict[str, int]:
    return {"x": 200 + index * 260, "y": 200}


def _action(playbook_id: str, name: str, label: str, index: int, parameters: dict[str, str], auth: bool) -> dict[str, Any]:
    return {
        "id": stable_id(playbook_id, "action", name),
        "app_name": APP_NAME,
        "app_version": APP_VERSION,
        "app_id": APP_ID_PLACEHOLDER,
        "name": name,
        "label": label,
        "environment": ENVIRONMENT,
        "is_valid": True,
        "is_start_node": index == 0,
        "authentication_id": AUTH_ID_PLACEHOLDER if auth else "",
        "position": _position(index + 1),
        "parameters": [
            {"name": key, "value": value, "required": True, "multiline": key in {"alert", "envelope", "verified"}, "schema": {"type": "string"}}
            for key, value in parameters.items()
        ],
    }


def _webhook(playbook_id: str) -> dict[str, Any]:
    hook_id = stable_id(playbook_id, "webhook")
    return {
        "id": hook_id,
        "app_name": "Webhook",
        "app_version": "1.0.0",
        "trigger_type": "WEBHOOK",
        "name": "Webhook",
        "label": "qapaq_webhook",
        "status": "uninitialized",
        "environment": "onprem",
        "is_valid": True,
        "position": _position(0),
        "parameters": [
            {"name": "url", "value": f"/api/v1/hooks/webhook_{hook_id}"},
            {"name": "tmp", "value": ""},
            {"name": "auth_headers", "value": "__QAPAQ_ANKAY_WEBHOOK_AUTH__"},
            {"name": "custom_response_body", "value": ""},
        ],
    }


def _branch(source: str, destination: str, condition: tuple[str, str] | None = None) -> dict[str, Any]:
    branch: dict[str, Any] = {
        "id": stable_id(source, destination, "branch"),
        "source_id": source,
        "destination_id": destination,
        "conditions": [],
    }
    if condition:
        field, expected = condition
        branch["conditions"].append({
            "source": {"name": "source", "value": field, "variant": "STATIC_VALUE"},
            "condition": {"name": "condition", "value": "equals"},
            "destination": {"name": "destination", "value": expected, "variant": "STATIC_VALUE"},
        })
    return branch


def _workflow(playbook_id: str, version: str, description: str, effects: str, trigger: dict[str, Any], actions: list[dict[str, Any]], branches: list[dict[str, Any]]) -> dict[str, Any]:
    body = {
        "name": f"QAPAQ · {playbook_id} {version}",
        "description": description,
        "tags": ["qapaq", f"ankay-playbook:{playbook_id}@{version}", f"effects:{effects}"],
        "start": actions[0]["id"],
        "actions": actions,
        "triggers": [trigger],
        "branches": branches,
        "workflow_variables": [],
        "execution_variables": [],
        "configuration": {"exit_on_error": True, "start_from_top": False, "skip_notifications": True},
        "is_valid": True,
        "status": "production",
    }
    digest = hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    body["tags"].append(f"ankay-sha256:{digest[:32]}")
    return body


def wazuh_intake_workflow() -> dict[str, Any]:
    trigger = _webhook(WAZUH_TRIAGE_ID)
    triage = _action(WAZUH_TRIAGE_ID, "triage_wazuh_alert", "triage_wazuh_alert", 0, {"alert": "$exec", "min_level": "12"}, auth=False)
    return _workflow(
        WAZUH_TRIAGE_ID,
        "1.0.0",
        "Entrada Wazuh → Ankay (custom-qapaq-shuffle). Solo lectura: valida, deduplica por alert.id y propone playbooks; no ejecuta acciones.",
        "none",
        trigger,
        [triage],
        [_branch(trigger["id"], triage["id"])],
    )


def catalog_workflow(entry: dict[str, Any]) -> dict[str, Any]:
    pid = entry["id"]
    trigger = _webhook(pid)
    verify = _action(pid, "verify_governed_dispatch", "verify_dispatch", 0, {"envelope": "$exec", "playbook_id": pid}, auth=True)
    read_only = entry["effects"] in READ_ONLY_EFFECTS
    final_name = "prepare_read_only_triage" if read_only else "hold_for_outbox"
    final = _action(pid, final_name, final_name, 1, {"verified": "$verify_dispatch"}, auth=False)
    if read_only:
        description = f"{pid} ({entry['catalog']}). Despacho firmado de QAPAQ Core → triage de solo lectura. Estado de catálogo: {entry['status']}."
    else:
        description = (
            f"{pid} ({entry['catalog']}). Efecto declarado: {entry['effects']}. Requiere aprobación {entry['approval']} en QAPAQ; "
            "Ankay solo verifica y retiene: el efecto lo despacha el outbox QAPAQ."
        )
    return _workflow(
        pid,
        entry["version"],
        description,
        entry["effects"],
        trigger,
        [verify, final],
        [_branch(trigger["id"], verify["id"]), _branch(verify["id"], final["id"], ("$verify_dispatch.status", "verified"))],
    )


def validate_handwritten(workflow: dict[str, Any], rel: str, playbooks: dict[str, dict[str, Any]]) -> None:
    name = workflow.get("name", "")
    tags = workflow.get("tags", [])
    if not isinstance(name, str) or not name.startswith("QAPAQ · "):
        raise CatalogError(f"{rel}: name must start with 'QAPAQ · '")
    tag = next((t for t in tags if isinstance(t, str) and t.startswith("ankay-playbook:")), None)
    if tag is None:
        raise CatalogError(f"{rel}: missing ankay-playbook:<id>@<version> tag")
    playbook_id = tag.split(":", 1)[1].split("@", 1)[0]
    for action in workflow.get("actions", []):
        if action.get("app_name") != APP_NAME or action.get("app_version") != APP_VERSION or action.get("name") not in ALLOWED_ACTIONS:
            raise CatalogError(f"{rel}: only {APP_NAME} {APP_VERSION} read-only actions are allowed")
    for trigger in workflow.get("triggers", []):
        if trigger.get("trigger_type") != "WEBHOOK":
            raise CatalogError(f"{rel}: only webhook triggers are allowed")
    spec = playbooks.get(playbook_id)
    if spec is not None and spec["effects"] not in READ_ONLY_EFFECTS:
        names = [action.get("name") for action in workflow.get("actions", [])]
        if names[:1] != ["verify_governed_dispatch"] or "hold_for_outbox" not in names:
            raise CatalogError(f"{rel}: effectful playbooks must verify the dispatch and end in hold_for_outbox")


def build(root: Path) -> dict[str, str]:
    playbooks, sources = load_catalogs(root)
    files: dict[str, str] = {}
    workflows = {WAZUH_TRIAGE_ID: wazuh_intake_workflow()}
    for pid in sorted(playbooks):
        workflows[pid] = catalog_workflow(playbooks[pid])
    for path in sorted(root.glob(HANDWRITTEN_GLOB)):
        rel = path.relative_to(root).as_posix()
        workflow = json.loads(path.read_text(encoding="utf-8"))
        validate_handwritten(workflow, rel, playbooks)
        key = "handwritten." + path.name.removesuffix(".workflow.json")
        workflows[key] = workflow
        sources.append(rel)

    routes = [
        {"playbookId": pid, "ruleIds": e["ruleIds"], "ruleGroups": e["ruleGroups"], "minLevel": e["minLevel"]}
        for pid, e in sorted(playbooks.items())
        if "wazuh" in " ".join(e["sources"]) and e["effects"] in READ_ONLY_EFFECTS
    ]
    catalog = {
        "schemaVersion": 1,
        "sources": sources,
        "playbooks": {
            pid: {k: e[k] for k in ("version", "catalog", "status", "sources", "steps", "approval", "effects", "required", "prohibited")}
            for pid, e in sorted(playbooks.items())
        },
        "wazuhRoutes": routes,
    }
    files["ankay-catalog.json"] = json.dumps(catalog, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    for key, workflow in workflows.items():
        files[f"workflows/{key}.json"] = json.dumps(workflow, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    return files


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if generated/ is stale")
    args = parser.parse_args()
    try:
        files = build(ROOT)
    except (CatalogError, OSError, json.JSONDecodeError, yaml.YAMLError) as error:
        print(f"build_workflows: {error}", file=sys.stderr)
        return 1
    existing = {p.relative_to(DIST).as_posix() for p in DIST.rglob("*.json")} if DIST.exists() else set()
    if args.check:
        stale = sorted(
            name for name, content in files.items()
            if not (DIST / name).exists() or (DIST / name).read_text(encoding="utf-8") != content
        ) + sorted(existing - set(files))
        if stale:
            print("build_workflows: generated/ desactualizado; ejecuta python3 ankay/playbooks/build_workflows.py: " + ", ".join(stale), file=sys.stderr)
            return 1
        print(f"build_workflows: {len(files) - 1} workflows al día")
        return 0
    for name in existing - set(files):
        (DIST / name).unlink()
    for name, content in files.items():
        target = DIST / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="\n")
    print(f"build_workflows: {len(files) - 1} workflows generados en {DIST.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
