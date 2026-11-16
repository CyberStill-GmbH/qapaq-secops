"""Exportación de IOCs en formatos abiertos de inteligencia de amenazas.

- STIX 2.1 (OASIS): importable en OpenCTI, MISP, Microsoft Sentinel (TI), etc.
- Evento MISP (JSON): importable en MISP mediante "Add event > Import from > MISP JSON".

Ambos se generan sin dependencias externas y con marcado TLP:AMBER, porque los
IOCs de un incidente interno no deben difundirse sin autorización.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

NAMESPACE = uuid.UUID("6f1c7e57-6b2c-4d0b-9e0c-7a3b2f9d8c10")  # UUID determinista por caso/IOC
TLP_AMBER_STIX = "marking-definition--f88d31f6-486f-44da-b317-01333bde0b82"  # TLP 1.0 AMBER (definición oficial STIX)

STIX_PATTERNS = {
    "dominio": lambda v: f"[domain-name:value = '{_q(v)}']",
    "url": lambda v: f"[url:value = '{_q(v)}']",
    "ip": lambda v: f"[{'ipv6' if ':' in v else 'ipv4'}-addr:value = '{_q(v)}']",
    "sha256": lambda v: f"[file:hashes.'SHA-256' = '{_q(v)}']",
    "correo": lambda v: f"[email-addr:value = '{_q(v)}']",
    "asunto": lambda v: f"[email-message:subject = '{_q(v)}']",
}
MISP_TYPES = {
    "dominio": ("domain", "Network activity", True), "url": ("url", "Network activity", True),
    "ip": ("ip-src", "Network activity", True), "sha256": ("sha256", "Payload delivery", True),
    "correo": ("email-src", "Payload delivery", True), "asunto": ("email-subject", "Payload delivery", False),
}
THREAT_LEVEL = {"critico": "1", "alto": "1", "medio": "2", "bajo": "3", "info": "4"}


def _q(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


def _sid(kind: str, *parts: str) -> str:
    return f"{kind}--{uuid.uuid5(NAMESPACE, '|'.join(parts))}"


def _created(case: dict) -> str:
    try:
        dt = datetime.fromisoformat(case["generado_en"]).astimezone(timezone.utc)
    except (KeyError, ValueError):
        dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def to_stix(case: dict) -> dict:
    created = _created(case)
    tool = case["herramienta"]
    identity = {"type": "identity", "spec_version": "2.1", "id": _sid("identity", "qapaq-rnf"),
                "created": created, "modified": created, "name": "Qapaq · Riesgos No Financieros",
                "identity_class": "organization"}
    objects = [identity]
    indicator_ids = []
    for ioc in case["iocs"]:
        builder = STIX_PATTERNS.get(ioc["tipo"])
        if not builder or not ioc["valor"]:
            continue
        oid = _sid("indicator", case["id"], ioc["tipo"], ioc["valor"])
        indicator_ids.append(oid)
        objects.append({
            "type": "indicator", "spec_version": "2.1", "id": oid, "created": created, "modified": created,
            "created_by_ref": identity["id"], "name": f"{ioc['tipo']}: {ioc['valor'][:120]}",
            "description": f"{ioc['contexto']} · riesgo {ioc['riesgo']} · caso {case['id']}",
            "indicator_types": ["malicious-activity"] if ioc["riesgo"] in ("critico", "alto") else ["anomalous-activity"],
            "pattern": builder(ioc["valor"]), "pattern_type": "stix", "valid_from": created,
            "labels": ["phishing", f"riesgo-{ioc['riesgo']}"], "object_marking_refs": [TLP_AMBER_STIX]})
    attack_ids = []
    for tech in case.get("mitre", []):
        aid = _sid("attack-pattern", tech["id"])
        attack_ids.append(aid)
        objects.append({"type": "attack-pattern", "spec_version": "2.1", "id": aid, "created": created, "modified": created,
                        "name": tech["nombre"],
                        "external_references": [{"source_name": "mitre-attack", "external_id": tech["id"], "url": tech["url"]}]})
    for oid in indicator_ids:
        for aid in attack_ids:
            objects.append({"type": "relationship", "spec_version": "2.1", "id": _sid("relationship", oid, aid),
                            "created": created, "modified": created, "relationship_type": "indicates",
                            "source_ref": oid, "target_ref": aid})
    objects.append({
        "type": "report", "spec_version": "2.1", "id": _sid("report", case["id"]), "created": created, "modified": created,
        "created_by_ref": identity["id"], "name": f"{tool['nombre']} — {case['id']}", "published": created,
        "report_types": ["threat-report"], "description": f"{case['veredicto']['etiqueta']}: {case['veredicto']['resumen']}",
        "object_refs": [identity["id"]] + indicator_ids + attack_ids,
        "object_marking_refs": [TLP_AMBER_STIX]})
    return {"type": "bundle", "id": _sid("bundle", case["id"]), "objects": objects}


def to_misp(case: dict) -> dict:
    tool = case["herramienta"]
    attributes = []
    for ioc in case["iocs"]:
        mapping = MISP_TYPES.get(ioc["tipo"])
        if not mapping or not ioc["valor"]:
            continue
        mtype, category, to_ids = mapping
        if ioc["contexto"].endswith("Reply-To") and mtype == "email-src":
            mtype = "email-reply-to"
        attributes.append({"type": mtype, "category": category, "value": ioc["valor"],
                           "to_ids": to_ids and ioc["riesgo"] in ("critico", "alto", "medio"),
                           "comment": f"{ioc['contexto']} · riesgo {ioc['riesgo']}",
                           "uuid": str(uuid.uuid5(NAMESPACE, f"{case['id']}|{ioc['tipo']}|{ioc['valor']}"))})
    tags = [{"name": "tlp:amber"}, {"name": 'circl:incident-classification="phishing"'}]
    tags += [{"name": f'misp-galaxy:mitre-attack-pattern="{t["nombre"]} - {t["id"]}"'} for t in case.get("mitre", [])]
    campaign = (case.get("correlacion") or {}).get("campana")
    if campaign:
        tags.append({"name": f"qapaq:campana={campaign}"})
    return {"Event": {
        "uuid": str(uuid.uuid5(NAMESPACE, case["id"])), "info": f"{tool['nombre']} — {case['id']} — {case['veredicto']['etiqueta']}",
        "date": case["generado_en"][:10], "threat_level_id": THREAT_LEVEL.get(case["veredicto"]["nivel"], "4"),
        "analysis": "2", "distribution": "0", "published": False, "Attribute": attributes, "Tag": tags}}


def write_exports(case: dict, folder) -> dict:
    from pathlib import Path

    folder = Path(folder)
    stix_path = folder / "iocs.stix.json"
    misp_path = folder / "iocs.misp.json"
    stix_path.write_text(json.dumps(to_stix(case), ensure_ascii=False, indent=2), encoding="utf-8")
    misp_path.write_text(json.dumps(to_misp(case), ensure_ascii=False, indent=2), encoding="utf-8")
    return {"stix": str(stix_path), "misp": str(misp_path)}

