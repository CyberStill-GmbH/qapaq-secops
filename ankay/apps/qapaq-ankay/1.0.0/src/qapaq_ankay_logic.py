"""Lógica de la app Shuffle «QAPAQ Ankay» (sin dependencias del SDK, para pruebas).

Ankay solo hace triage de lectura y prepara contexto. Las acciones con efecto se
retienen: QAPAQ Core las aprueba (SoD) y las despacha por su outbox; esta app nunca
llama a proveedores ni guarda credenciales. Toda entrada se trata como no confiable.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from typing import Any, Callable

WAZUH_SCHEMA = "1.0.0"
DISPATCH_SCHEMA = "1.0.0"
REPLAY_WINDOW_SECONDS = 300
MAX_INPUT_BYTES = 64 * 1024
READ_ONLY_EFFECTS = {"none", "notification-only"}

ALERT_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
REFERENCE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._/-]{0,159}$")
EXECUTION_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._-]{15,127}$")
NONCE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
MAC = re.compile(r"^[0-9a-f]{64}$")
RULE_ID = re.compile(r"^[0-9]{1,8}$")

# Campos que nunca deben viajar en un despacho a Ankay, además de los que prohíbe cada
# playbook en su especificación.
GLOBAL_PROHIBITED = {
    "password", "accesstoken", "refreshtoken", "token", "apikey", "secret", "clientsecret",
    "authheader", "authorization", "cookie", "mailbody", "attachmentbytes", "samplebytes",
    "documentbytes", "privatefilecontent", "providertoken", "rawurlwithquery",
}


class TriageError(ValueError):
    """Entrada rechazada. El mensaje no incluye valores recibidos."""


def parse_json_object(raw: Any, label: str) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        raise TriageError(f"{label} must be a JSON object")
    if len(raw.encode("utf-8", errors="replace")) > MAX_INPUT_BYTES:
        raise TriageError(f"{label} exceeds {MAX_INPUT_BYTES} bytes")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        raise TriageError(f"{label} is not valid JSON") from None
    if not isinstance(value, dict):
        raise TriageError(f"{label} must be a JSON object")
    return value


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _text(value: Any, limit: int = 160) -> str:
    if not isinstance(value, (str, int)) or isinstance(value, bool):
        return ""
    return re.sub(r"[\x00-\x1f\x7f]", " ", str(value)).strip()[:limit]


def route_alert(rule_id: str, groups: list[str], level: int, routes: list[dict[str, Any]]) -> list[str]:
    """Playbooks de solo lectura cuyo disparador coincide con la alerta."""
    matches = []
    for route in routes:
        if level < int(route.get("minLevel", 12)):
            continue
        ids = set(route.get("ruleIds", []))
        wanted = set(route.get("ruleGroups", []))
        if (ids and rule_id in ids) or (wanted and wanted.intersection(groups)) or (not ids and not wanted):
            matches.append(route["playbookId"])
    return sorted(set(matches))


def triage_wazuh_alert(
    raw_alert: Any,
    catalog: dict[str, Any],
    already_seen: Callable[[str], bool],
    min_level: int = 12,
) -> dict[str, Any]:
    """Valida el payload mínimo de custom-qapaq-shuffle, deduplica y clasifica."""
    alert_doc = parse_json_object(raw_alert, "alert")
    if alert_doc.get("schemaVersion") != WAZUH_SCHEMA or alert_doc.get("source") != "wazuh":
        raise TriageError("unsupported Wazuh payload schema")
    alert = alert_doc.get("alert")
    if not isinstance(alert, dict):
        raise TriageError("alert object is missing")
    alert_id = _text(alert.get("id"), 64)
    if not ALERT_ID.fullmatch(alert_id) or alert_id == "unknown":
        raise TriageError("alert id is missing or invalid")
    rule = alert.get("rule")
    if not isinstance(rule, dict):
        raise TriageError("rule object is missing")
    rule_id = _text(rule.get("id"), 8)
    if not RULE_ID.fullmatch(rule_id):
        raise TriageError("rule id is invalid")
    level = rule.get("level")
    if not isinstance(level, int) or isinstance(level, bool) or not 0 <= level <= 16:
        raise TriageError("rule level is invalid")
    groups_raw = rule.get("groups", [])
    if not isinstance(groups_raw, list):
        raise TriageError("rule groups must be a list")
    groups = [group for group in (_text(item, 64) for item in groups_raw[:12]) if group]

    if level < min_level:
        return {"status": "ignored-below-threshold", "alertId": alert_id, "ruleId": rule_id, "level": level, "effects": "none"}
    if already_seen(f"wazuh-alert:{alert_id}"):
        return {"status": "duplicate", "alertId": alert_id, "ruleId": rule_id, "level": level, "effects": "none"}

    playbooks = route_alert(rule_id, groups, level, catalog.get("wazuhRoutes", []))
    return {
        "status": "triaged",
        "alertId": alert_id,
        "ruleId": rule_id,
        "level": level,
        "groups": groups,
        "agent": _text((alert.get("agent") or {}).get("name") if isinstance(alert.get("agent"), dict) else "", 64),
        "candidatePlaybooks": playbooks,
        "nextStep": "request-qapaq-case-admission" if playbooks else "analyst-review",
        "effects": "none",
    }


def _keys_lower(value: Any, found: set[str]) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            found.add(re.sub(r"[^a-z0-9]", "", str(key).lower()))
            _keys_lower(item, found)
    elif isinstance(value, list):
        for item in value:
            _keys_lower(item, found)


def verify_dispatch(
    raw_envelope: Any,
    key: str,
    catalog: dict[str, Any],
    expected_playbook: str,
    already_seen: Callable[[str], bool],
    now: Callable[[], float] = time.time,
) -> dict[str, Any]:
    """Verifica un despacho firmado por QAPAQ Core (HMAC-SHA256 con timestamp y nonce)."""
    if not isinstance(key, str) or len(key.encode("utf-8")) < 32:
        raise TriageError("dispatch HMAC key is not configured")
    envelope = parse_json_object(raw_envelope, "dispatch envelope")
    if envelope.get("schemaVersion") != DISPATCH_SCHEMA:
        raise TriageError("unsupported dispatch schema")
    dispatch = envelope.get("dispatch")
    signature = envelope.get("signature")
    if not isinstance(dispatch, dict) or not isinstance(signature, dict):
        raise TriageError("dispatch or signature is missing")
    if signature.get("alg") != "HMAC-SHA256":
        raise TriageError("unsupported signature algorithm")
    timestamp = signature.get("timestamp")
    nonce = signature.get("nonce")
    mac = signature.get("mac")
    if not isinstance(timestamp, int) or isinstance(timestamp, bool) or not isinstance(nonce, str) or not NONCE.fullmatch(nonce):
        raise TriageError("signature timestamp or nonce is invalid")
    if not isinstance(mac, str) or not MAC.fullmatch(mac):
        raise TriageError("signature mac is invalid")
    if abs(now() - timestamp) > REPLAY_WINDOW_SECONDS:
        raise TriageError("dispatch is outside the replay window")
    message = f"{timestamp}.{nonce}.{canonical_json(dispatch)}".encode("utf-8")
    expected = hmac.new(key.encode("utf-8"), message, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, mac):
        raise TriageError("dispatch signature does not verify")

    playbooks = catalog.get("playbooks", {})
    playbook_id = dispatch.get("playbookId")
    if playbook_id != expected_playbook or playbook_id not in playbooks:
        raise TriageError("dispatch targets a different or unknown playbook")
    spec = playbooks[playbook_id]
    if dispatch.get("playbookVersion") != spec["version"]:
        raise TriageError("dispatch playbook version is not the imported version")
    execution_key = dispatch.get("executionKey")
    if not isinstance(execution_key, str) or not EXECUTION_KEY.fullmatch(execution_key):
        raise TriageError("executionKey is invalid")
    for field in ("incidentRef", "alertRef"):
        if not isinstance(dispatch.get(field), str) or not REFERENCE.fullmatch(dispatch[field]):
            raise TriageError(f"{field} is invalid")
    effects = spec.get("effects", "none")
    if effects not in READ_ONLY_EFFECTS:
        approval = dispatch.get("approvalRef")
        if not isinstance(approval, str) or not REFERENCE.fullmatch(approval):
            raise TriageError("effectful playbooks require a QAPAQ approvalRef")

    inputs = dispatch.get("inputs", {})
    if not isinstance(inputs, dict):
        raise TriageError("inputs must be an object")
    present: set[str] = set()
    _keys_lower(inputs, present)
    prohibited = GLOBAL_PROHIBITED | {re.sub(r"[^a-z0-9]", "", item.lower()) for item in spec.get("prohibited", [])}
    if present & prohibited:
        raise TriageError("dispatch carries prohibited fields")
    missing = [name for name in spec.get("required", []) if name not in inputs and name not in dispatch]
    if missing:
        raise TriageError("dispatch is missing required references")

    if already_seen(f"dispatch-nonce:{nonce}") or already_seen(f"execution:{execution_key}"):
        return {"status": "duplicate", "playbookId": playbook_id, "executionKey": execution_key, "effects": "none"}
    return {
        "status": "verified",
        "playbookId": playbook_id,
        "playbookVersion": spec["version"],
        "executionKey": execution_key,
        "incidentRef": dispatch["incidentRef"],
        "alertRef": dispatch["alertRef"],
        "approvalRef": dispatch.get("approvalRef", ""),
        "declaredEffects": effects,
    }


def prepare_read_only_triage(verified: Any, catalog: dict[str, Any]) -> dict[str, Any]:
    """Arma el checklist de triage de un playbook sin efectos ya verificado."""
    result = parse_json_object(verified, "verified dispatch")
    if result.get("status") != "verified":
        raise TriageError("dispatch was not verified")
    spec = catalog.get("playbooks", {}).get(result.get("playbookId"))
    if spec is None or spec.get("effects", "none") not in READ_ONLY_EFFECTS:
        raise TriageError("playbook is not read-only")
    return {
        "status": "triage-prepared",
        "playbookId": result["playbookId"],
        "playbookVersion": result["playbookVersion"],
        "executionKey": result["executionKey"],
        "incidentRef": result["incidentRef"],
        "steps": [{"step": step, "state": "pending-qapaq-read-adapter"} for step in spec.get("steps", [])],
        "sources": spec.get("sources", []),
        "evidencePolicy": "references-only",
        "effects": "none",
    }


def hold_for_outbox(verified: Any, catalog: dict[str, Any]) -> dict[str, Any]:
    """Nunca ejecuta efectos: deja constancia de que el efecto pertenece al outbox QAPAQ."""
    result = parse_json_object(verified, "verified dispatch")
    if result.get("status") != "verified":
        raise TriageError("dispatch was not verified")
    spec = catalog.get("playbooks", {}).get(result.get("playbookId"))
    if spec is None:
        raise TriageError("unknown playbook")
    return {
        "status": "blocked-awaiting-qapaq-outbox",
        "playbookId": result["playbookId"],
        "playbookVersion": result["playbookVersion"],
        "executionKey": result["executionKey"],
        "approvalRef": result.get("approvalRef", ""),
        "declaredEffects": spec.get("effects"),
        "catalogStatus": spec.get("status"),
        "effects": "none",
        "reason": "Ankay no ejecuta acciones con efecto; QAPAQ Core las despacha tras aprobación SoD.",
    }
