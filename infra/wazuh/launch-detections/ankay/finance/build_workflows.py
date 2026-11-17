#!/usr/bin/env python3
"""Genera los workflows Shuffle 2.x de los playbooks financieros desde finance-catalog.yaml.

Un archivo `<playbook-id>.json` por playbook, con el formato de exportación de Shuffle
(actions, branches, triggers, start, workflow_variables). Todos siguen la misma forma:

  Webhook (outbox QAPAQ) → verify_dispatch → enrich_* (solo lectura) → assess
    → attach_evidence → [request_actions si hay candidato a contención]
    → notify_outbox → record_result
  verify_dispatch rechazado → record_rejected

Cada nodo HTTP llama únicamente al puente QAPAQ ($qapaq_bridge_base_url/v1/ankay/...).
Ningún nodo llama a Microsoft, Sophos, Cato, el ERP ni el core: las lecturas pasan por
adaptadores QAPAQ y los efectos solo se solicitan (QAPAQ aprueba con SoD y despacha por
el outbox hacia un playbook containment.* separado).

Las credenciales no viajan en el JSON: los nodos HTTP usan la autenticación de app de
Shuffle `qapaq-ankay-bridge`, que se asigna al importar (ver README de esta carpeta).

Uso: python3 build_workflows.py [--check]
"""

from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path

import yaml

here = Path(__file__).resolve().parent
root = here.parents[4]
catalog_path = root / "docs/security/ankay-playbooks/finance-catalog.yaml"
NAMESPACE = uuid.UUID("6f1f6c5e-6a8b-4d0e-9a51-6b8e2a0c9f10")

HTTP_APP = {"app_name": "http", "app_version": "1.4.0"}
TOOLS_APP = {"app_name": "Shuffle Tools", "app_version": "1.2.0"}
BRIDGE_AUTH_NAME = "qapaq-ankay-bridge"
JSON_HEADERS = "Content-Type: application/json\nAccept: application/json"


def node_id(playbook: str, name: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"{playbook}:{name}"))


def param(name: str, value: str, *, description: str = "", required: bool = False,
          multiline: bool = False, configuration: bool = False) -> dict:
    return {
        "description": description,
        "id": "",
        "name": name,
        "example": "",
        "value": value,
        "multiline": multiline,
        "options": None,
        "action_field": "",
        "variant": "STATIC_VALUE",
        "required": required,
        "configuration": configuration,
        "tags": None,
        "schema": {"type": "string"},
        "skip_multicheck": False,
        "value_replace": None,
    }


def http_post(playbook: str, name: str, label: str, path: str, body: dict, x: int, y: int,
              *, start: bool = False) -> dict:
    return {
        **HTTP_APP,
        "app_id": "",
        "errors": [],
        "id": node_id(playbook, name),
        "is_valid": True,
        "isStartNode": start,
        "sharing": False,
        "label": label,
        "environment": "Shuffle",
        "name": "POST",
        "parameters": [
            param("url", f"$qapaq_bridge_base_url{path}", required=True),
            param("headers", JSON_HEADERS, multiline=True),
            param("body", json.dumps(body, ensure_ascii=False, indent=2), multiline=True),
            param("username", "", configuration=True,
                  description=f"Se completa con la autenticación de app {BRIDGE_AUTH_NAME}"),
            param("password", "", configuration=True,
                  description=f"Se completa con la autenticación de app {BRIDGE_AUTH_NAME}"),
            param("verify", "true"),
            param("timeout", "15"),
            param("to_file", "false"),
        ],
        "execution_variable": {"description": "", "id": "", "name": "", "value": ""},
        "position": {"x": x, "y": y},
        "authentication_id": "",
        "auth_not_required": False,
    }


def python_node(playbook: str, name: str, label: str, code: str, x: int, y: int) -> dict:
    return {
        **TOOLS_APP,
        "app_id": "",
        "errors": [],
        "id": node_id(playbook, name),
        "is_valid": True,
        "isStartNode": False,
        "sharing": False,
        "label": label,
        "environment": "Shuffle",
        "name": "execute_python",
        "parameters": [param("code", code, required=True, multiline=True)],
        "execution_variable": {"description": "", "id": "", "name": "", "value": ""},
        "position": {"x": x, "y": y},
        "authentication_id": "",
        "auth_not_required": True,
    }


def condition(source: str, operator: str, destination: str) -> dict:
    def part(name: str, value: str) -> dict:
        return {**param(name, value), "variant": "" if name == "condition" else "STATIC_VALUE"}
    return {
        "source": part("source", source),
        "condition": part("condition", operator),
        "destination": part("destination", destination),
    }


def branch(playbook: str, source: dict, destination: dict, conditions: list[dict] | None = None,
           label: str = "") -> dict:
    return {
        "destination_id": destination["id"],
        "id": node_id(playbook, f"branch:{source['label']}->{destination['label']}"),
        "source_id": source["id"],
        "label": label,
        "has_errors": False,
        "conditions": conditions,
    }


def assess_code(playbook: dict, query_labels: list[str]) -> str:
    """Código determinista: agrega resultados del puente sin decidir efectos."""
    lines = [
        "import json",
        "",
        "# Generado por build_workflows.py. Ankay no decide efectos: solo agrega el",
        "# resultado de las lecturas y marca si existe candidato a contención para que un",
        "# humano decida en QAPAQ con control dual y SoD.",
        "def load(raw):",
        "    try:",
        "        value = json.loads(raw) if isinstance(raw, str) else raw",
        "    except ValueError:",
        "        return {'status': 'degraded', 'reason': 'respuesta no JSON'}",
        "    if not isinstance(value, dict):",
        "        return {'status': 'degraded', 'reason': 'respuesta vacía'}",
        "    if value.get('status') != 200:",
        "        return {'status': 'degraded', 'reason': 'HTTP %s' % value.get('status')}",
        "    body = value.get('body')",
        "    return body if isinstance(body, dict) else {'status': 'degraded', 'reason': 'cuerpo inválido'}",
        "",
        "results = {",
    ]
    for label in query_labels:
        lines.append(f"    '{label}': load(r'''${label}'''),")
    lines += [
        "}",
        "degraded = sorted(name for name, body in results.items() if body.get('status') != 'ok')",
        "signals = sorted({signal for body in results.values() for signal in body.get('signals', [])",
        "                  if isinstance(signal, str)})",
        "candidate = any(body.get('containmentCandidate') is True for body in results.values())",
        "print(json.dumps({",
        f"    'playbookId': '{playbook['id']}',",
        f"    'playbookVersion': '{playbook['version']}',",
        "    'state': 'degraded' if degraded else 'complete',",
        "    'degradedSources': degraded,",
        "    'signals': signals,",
        "    'containmentCandidate': 'true' if candidate else 'false',",
        "    'evidenceRefs': sorted({ref for body in results.values() for ref in body.get('evidenceRefs', [])",
        "                            if isinstance(ref, str)}),",
        "}))",
    ]
    return "\n".join(lines)


def build(playbook: dict, catalog: dict) -> dict:
    pid = playbook["id"]
    dispatch = "$verify_dispatch.body"
    common = {
        "playbookId": pid,
        "playbookVersion": playbook["version"],
        "executionKey": f"{dispatch}.executionKey",
        "incidentRef": f"{dispatch}.incidentRef",
    }
    x, y, step = 0, 200, 260
    actions: list[dict] = []

    verify = http_post(pid, "verify_dispatch", "verify_dispatch", "/v1/ankay/dispatch/verify", {
        "playbookId": pid,
        "playbookVersion": playbook["version"],
        "envelope": "$exec",
    }, x, y, start=True)
    actions.append(verify)

    query_nodes = []
    for query in playbook["triage"]["queries"]:
        x += step
        label = "enrich_" + query.replace(".", "_")
        query_nodes.append(http_post(pid, label, label, "/v1/ankay/enrichment", {
            **common,
            "query": query,
            "scopeRef": f"{dispatch}.scopeRef",
            "window": f"{dispatch}.window",
        }, x, y))
    actions += query_nodes

    x += step
    assess = python_node(pid, "assess", "assess",
                         assess_code(playbook, [node["label"] for node in query_nodes]), x, y)
    actions.append(assess)

    x += step
    evidence = http_post(pid, "attach_evidence", "attach_evidence",
                         f"/v1/ankay/incidents/{dispatch}.incidentRef/evidence", {
                             **common,
                             "kind": "playbook-triage-summary",
                             "summary": "$assess.message",
                         }, x, y)
    actions.append(evidence)

    request_actions = None
    if playbook.get("requestableEffects"):
        request_actions = http_post(pid, "request_actions", "request_actions",
                                    "/v1/ankay/action-requests", {
                                        **common,
                                        "state": "pending-human-decision",
                                        "decision": playbook["humanDecision"]["question"],
                                        "options": [
                                            {"effect": item["effect"],
                                             "approverRoles": item["approverRoles"],
                                             "constraints": item["constraints"]}
                                            for item in playbook["requestableEffects"]
                                        ],
                                        "approvalPolicy": "dual-control-and-sod",
                                        "triageRef": "$assess.message",
                                    }, x + step // 2, y + 180)
        actions.append(request_actions)

    x += step
    notify = http_post(pid, "notify_outbox", "notify_outbox", "/v1/ankay/notification-intents", {
        **common,
        "priority": playbook["priority"],
        "template": f"{pid}.triage-complete",
        "dedupeKey": f"{dispatch}.executionKey",
    }, x, y)
    actions.append(notify)

    x += step
    record = http_post(pid, "record_result", "record_result",
                       f"/v1/ankay/executions/{dispatch}.executionKey/result", {
                           **common,
                           "outcome": "triage-complete",
                           "triage": "$assess.message",
                       }, x, y)
    actions.append(record)

    rejected = http_post(pid, "record_rejected", "record_rejected",
                         "/v1/ankay/executions/rejected", {
                             "playbookId": pid,
                             "playbookVersion": playbook["version"],
                             "outcome": "dispatch-rejected",
                             "reason": f"{dispatch}.reason",
                         }, step, y + 220)
    actions.append(rejected)

    accept = [condition(f"{dispatch}.decision", "equals", "accept")]
    branches = [
        branch(pid, verify, query_nodes[0], accept, "despacho válido"),
        branch(pid, verify, rejected, [condition(f"{dispatch}.decision", "does not equal", "accept")],
               "despacho rechazado o duplicado"),
    ]
    for previous, current in zip(query_nodes, query_nodes[1:]):
        branches.append(branch(pid, previous, current))
    branches.append(branch(pid, query_nodes[-1], assess))
    branches.append(branch(pid, assess, evidence))
    if request_actions:
        branches.append(branch(pid, evidence, request_actions,
                               [condition("$assess.message.containmentCandidate", "equals", "true")],
                               "candidato a contención: decide un humano en QAPAQ"))
        branches.append(branch(pid, request_actions, notify))
        branches.append(branch(pid, evidence, notify,
                               [condition("$assess.message.containmentCandidate", "does not equal", "true")],
                               "sin candidato a contención"))
    else:
        branches.append(branch(pid, evidence, notify))
    branches.append(branch(pid, notify, record))

    trigger = {
        "app_name": "Webhook",
        "description": "Recibe el despacho firmado del outbox QAPAQ",
        "long_description": "",
        "status": "uninitialized",
        "app_version": "1.0.0",
        "errors": None,
        "id": node_id(pid, "trigger"),
        "is_valid": True,
        "isStartNode": False,
        "label": "qapaq_outbox_dispatch",
        "small_image": "",
        "large_image": "",
        "environment": "cloud",
        "trigger_type": "WEBHOOK",
        "name": "Webhook",
        "tags": None,
        "parameters": [
            param("url", ""),
            param("tmp", ""),
            param("auth_headers", ""),
        ],
        "position": {"x": -260, "y": y},
        "priority": 0,
    }

    description = (
        f"{playbook['name']}. Playbook {pid} v{playbook['version']} del catálogo "
        f"{catalog['catalogId']} (estado {playbook['status']}). Triage de solo lectura vía "
        "puente QAPAQ; toda acción con efecto se solicita a QAPAQ (control dual y SoD) y la "
        f"despacha el outbox. Runbook: {playbook['runbook']}. Generado por build_workflows.py; "
        "no editar a mano."
    )
    return {
        "actions": actions,
        "branches": branches,
        "triggers": [trigger],
        "schedules": None,
        "configuration": {
            "exit_on_error": False,
            "start_from_top": False,
            "skip_notifications": False,
        },
        "tags": ["qapaq", "finance", playbook["priority"], playbook["status"]],
        "id": node_id(pid, "workflow"),
        "is_valid": True,
        "name": f"QAPAQ · {playbook['name']}",
        "description": description,
        "start": verify["id"],
        "owner": "",
        "sharing": "private",
        "execution_org": {"name": "", "org": "", "users": None, "id": "", "role": "", "child_orgs": None},
        "workflow_variables": [
            {"description": "URL HTTPS del puente QAPAQ para Ankay (no secreta; se fija al importar)",
             "id": node_id(pid, "var:qapaq_bridge_base_url"),
             "name": "qapaq_bridge_base_url", "value": ""},
        ],
    }


def render() -> dict[Path, str]:
    catalog = yaml.safe_load(catalog_path.read_text(encoding="utf-8"))
    outputs = {}
    for playbook in catalog["playbooks"]:
        workflow = build(playbook, catalog)
        outputs[root / playbook["workflow"]] = json.dumps(workflow, ensure_ascii=False, indent=2) + "\n"
    return outputs


if __name__ == "__main__":
    outputs = render()
    if "--check" in sys.argv[1:]:
        stale = [path.name for path, text in outputs.items()
                 if not path.exists() or path.read_text(encoding="utf-8") != text]
        if stale:
            sys.exit(f"Workflows desactualizados, ejecutar build_workflows.py: {', '.join(stale)}")
        print(f"PASS: {len(outputs)} workflows sincronizados con el catálogo")
    else:
        for path, text in outputs.items():
            path.write_text(text, encoding="utf-8", newline="\n")
        print(f"{len(outputs)} workflows escritos")
