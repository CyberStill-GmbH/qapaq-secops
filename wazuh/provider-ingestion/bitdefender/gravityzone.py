#!/usr/bin/env python3
"""Bitdefender GravityZone Cloud API (JSON-RPC) → JSONL for Wazuh. Read-only.

What the QAPAQ key can call (verified 2026-11-03): Network, Quarantine, Accounts, Companies,
Policies, Reports. Not allowed: Push, Licensing, Packages, Integrations. ``incidents`` answers
"company does not have access to the EDR feature", so incidents are not collected.

Collected:
- ``endpoint_status``: per managed endpoint (``network.getManagedEndpointDetails``) emitted when the
  security-relevant fingerprint changes (infected/detection/isolated/outdated/modules/policy) and
  as a full snapshot every ``snapshot_hours`` (default 24).
- ``quarantine_item``: new items from ``quarantine/computers.getQuarantineItemsList`` (dedupe by id).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import pathlib
import re
import sys
import time
from datetime import timedelta

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "common"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from qapaq_collector import (  # noqa: E402
    ProviderError,
    bounded_ids,
    http_json,
    iso,
    parse_iso,
    read_secret,
    run_collector,
    utc_now,
)

REGION_BASES = {
    "us": "https://cloud.gravityzone.bitdefender.com/api",
    "eu": "https://cloudgz.gravityzone.bitdefender.com/api",
}
BASE_PATTERN = re.compile(r"https://[a-z0-9.-]+\.gravityzone\.bitdefender\.com/api")
MAX_PAGES = 50
PER_PAGE = 100


class GravityZone:
    def __init__(self, base: str, api_key: str, opener=None, pause: float = 0.1) -> None:
        if not BASE_PATTERN.fullmatch(base):
            raise ProviderError("GravityZone API base is not an official gravityzone.bitdefender.com host")
        self.base = base
        self.auth = "Basic " + base64.b64encode((api_key + ":").encode()).decode()
        self.opener = opener
        self.pause = pause
        self.calls = 0

    def call(self, service: str, method: str, params: dict) -> object:
        if self.calls and self.pause:
            time.sleep(self.pause)  # GravityZone throttles bursts per key
        self.calls += 1
        body = {"jsonrpc": "2.0", "method": method, "params": params, "id": f"qapaq-{self.calls}"}
        status, payload = http_json(
            "POST", f"{self.base}/v1.0/jsonrpc/{service}", {"Authorization": self.auth}, body, opener=self.opener
        )
        if status in (401, 403):
            raise ProviderError(f"GravityZone denied {service}.{method}", status)
        if status != 200 or not isinstance(payload, dict):
            raise ProviderError(f"GravityZone {service}.{method} failed", status)
        if payload.get("error"):
            raise ProviderError(f"GravityZone {service}.{method} returned a JSON-RPC error", status)
        return payload.get("result")

    def paged(self, service: str, method: str, params: dict | None = None) -> list[dict]:
        items: list[dict] = []
        for page in range(1, MAX_PAGES + 1):
            result = self.call(service, method, {**(params or {}), "page": page, "perPage": PER_PAGE})
            if not isinstance(result, dict) or not isinstance(result.get("items"), list):
                raise ProviderError(f"GravityZone {service}.{method} response is invalid")
            items.extend(item for item in result["items"] if isinstance(item, dict))
            if page >= int(result.get("pagesCount") or 0):
                break
        return items


def _bool(value: object) -> bool:
    return bool(value) if isinstance(value, bool) else False


def endpoint_view(summary: dict, details: dict) -> dict:
    agent = details.get("agent") if isinstance(details.get("agent"), dict) else {}
    malware = details.get("malwareStatus") if isinstance(details.get("malwareStatus"), dict) else {}
    modules = details.get("modules") if isinstance(details.get("modules"), dict) else {}
    policy = details.get("policy") if isinstance(details.get("policy"), dict) else {}
    group = details.get("group") if isinstance(details.get("group"), dict) else {}
    disabled = sorted(name for name in ("antimalware", "advancedThreatControl", "firewall", "antiTampering")
                      if name in modules and modules.get(name) is False)
    return {
        "id": str(details.get("id") or summary.get("id") or ""),
        "name": str(details.get("name") or summary.get("name") or "")[:200],
        "fqdn": str(summary.get("fqdn") or "")[:255],
        "ip": str(details.get("ip") or summary.get("ip") or "")[:64],
        "os": str(details.get("operatingSystem") or summary.get("operatingSystemVersion") or "")[:200],
        "group": str(group.get("name") or "")[:200],
        "infected": _bool(malware.get("infected")),
        "detection": _bool(malware.get("detection")),
        "isolated": _bool(details.get("isIsolated", summary.get("isIsolated"))),
        "signature_outdated": _bool(agent.get("signatureOutdated")),
        "product_outdated": _bool(agent.get("productOutdated")),
        "product_version": str(agent.get("productVersion") or "")[:64],
        "last_update": str(agent.get("lastUpdate") or "")[:64],
        "policy_name": str(policy.get("name") or "")[:200],
        "policy_applied": _bool(policy.get("applied")),
        "modules_disabled": disabled,
        # El firewall suele estar apagado por política; solo antimalware/ATC cuentan como protección caída.
        "antimalware_disabled": "antimalware" in disabled,
        "atc_disabled": "advancedThreatControl" in disabled,
        "last_seen": str(details.get("lastSeen") or "")[:64],
        "state": details.get("state") if isinstance(details.get("state"), int) else None,
    }


FINGERPRINT_FIELDS = (
    "infected", "detection", "isolated", "signature_outdated", "product_outdated",
    "policy_applied", "modules_disabled", "policy_name",
)


def fingerprint(view: dict) -> str:
    material = json.dumps({key: view.get(key) for key in FINGERPRINT_FIELDS}, sort_keys=True)
    return hashlib.sha256(material.encode()).hexdigest()[:16]


def envelope(event_type: str, payload_key: str, payload: dict, now: str) -> dict:
    return {
        "qapaq": {"vendor": "bitdefender", "source": "gravityzone", "event_type": event_type, "collected_at": now},
        "bitdefender": {payload_key: payload, "event_type": event_type},
    }


def quarantine_view(item: dict) -> dict:
    details = item.get("details") if isinstance(item.get("details"), dict) else {}
    return {
        "id": str(item.get("id") or ""),
        "threat_name": str(item.get("threatName") or "")[:300],
        "file_path": str(details.get("filePath") or item.get("filePath") or "")[:1024],
        "endpoint_id": str(item.get("endpointId") or "")[:64],
        "endpoint_name": str(item.get("endpointName") or "")[:200],
        "endpoint_ip": str(item.get("endpointIP") or "")[:64],
        "quarantined_on": str(item.get("quarantinedOn") or "")[:64],
        "action_status": item.get("actionStatus") if isinstance(item.get("actionStatus"), int) else None,
    }


def collect(config: dict, state: dict, client: GravityZone | None = None) -> tuple[list[dict], dict]:
    if client is None:
        base = config.get("api_base") or REGION_BASES.get(str(config.get("region", "us")))
        if not base:
            raise ProviderError("GravityZone region is not supported")
        client = GravityZone(base, read_secret(pathlib.Path(config["api_key_file"])))
    now = utc_now()
    now_text = iso(now)
    snapshot_hours = int(config.get("snapshot_hours", 24))
    last_snapshot = state.get("last_snapshot")
    snapshot_due = not last_snapshot or now - parse_iso(last_snapshot) >= timedelta(hours=snapshot_hours)
    max_endpoints = int(config.get("max_endpoints", 2000))

    events: list[dict] = []
    known: dict = dict(state.get("endpoints") or {})
    current: dict = {}
    endpoints = [item for item in client.paged("network", "getEndpointsList", {"isManaged": True})
                 if item.get("isManaged") is not False][:max_endpoints]
    for summary in endpoints:
        endpoint_id = str(summary.get("id") or "")
        if not endpoint_id:
            continue
        details = client.call("network", "getManagedEndpointDetails", {"endpointId": endpoint_id})
        if not isinstance(details, dict):
            raise ProviderError("GravityZone endpoint details response is invalid")
        view = endpoint_view(summary, details)
        print_ = fingerprint(view)
        current[endpoint_id] = print_
        previous = known.get(endpoint_id)
        if snapshot_due or previous != print_:
            view["change"] = "new" if previous is None else ("changed" if previous != print_ else "snapshot")
            events.append(envelope("endpoint_status", "endpoint", view, now_text))

    seen = list(state.get("quarantine_seen") or [])
    seen_set = set(seen)
    first_run = "quarantine_seen" not in state
    lookback = now - timedelta(days=int(config.get("initial_quarantine_days", 7)))
    for item in client.paged("quarantine/computers", "getQuarantineItemsList"):
        view = quarantine_view(item)
        if not view["id"] or view["id"] in seen_set:
            continue
        seen.append(view["id"])
        seen_set.add(view["id"])
        if first_run and view["quarantined_on"]:
            try:
                if parse_iso(view["quarantined_on"]) < lookback:
                    continue
            except ValueError:
                pass
        events.append(envelope("quarantine_item", "quarantine", view, now_text))

    next_state = {
        "endpoints": current,
        "quarantine_seen": bounded_ids(seen, 20000),
        "last_snapshot": now_text if snapshot_due else last_snapshot,
    }
    return events, next_state


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=pathlib.Path)
    return run_collector("qapaq-bitdefender", parser.parse_args().config, collect)


if __name__ == "__main__":
    raise SystemExit(main())
