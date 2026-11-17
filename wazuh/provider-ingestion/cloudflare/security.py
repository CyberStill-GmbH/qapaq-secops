#!/usr/bin/env python3
"""Cloudflare account audit logs and zone security (firewall) events → JSONL for Wazuh. Read-only.

Verified token scope (2026-11-03): ``/user/tokens/verify`` active; 1 account, 3 zones; account
audit logs readable; GraphQL ``firewallEventsAdaptive`` readable for every zone.

- ``audit``: ``GET /accounts/{id}/audit_logs?since=&direction=asc`` paginated; dedupe by log id;
  cursor = newest ``when``.
- ``firewall``: GraphQL ``firewallEventsAdaptive`` per zone in windows of at most 1 h, from the
  cursor to now-2 min (Cloudflare indexes with a short delay). Events carry no id, so the dedupe
  key is a hash of the record; the cursor is the newest ``datetime`` and the next query starts at
  that instant (inclusive) to avoid gaps.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
import urllib.parse
from datetime import timedelta

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "common"))
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

API = "https://api.cloudflare.com/client/v4"
FIREWALL_FIELDS = (
    "action source datetime clientIP clientCountryName clientAsn clientRequestHTTPHost "
    "clientRequestPath clientRequestHTTPMethodName rayName ruleId description userAgent edgeResponseStatus"
)
FIREWALL_QUERY = (
    "query($zone:String!,$since:Time!,$until:Time!,$limit:Int!){viewer{zones(filter:{zoneTag:$zone}){"
    "firewallEventsAdaptive(limit:$limit,filter:{datetime_geq:$since,datetime_lt:$until},"
    "orderBy:[datetime_ASC]){" + FIREWALL_FIELDS + "}}}}"
)
FIREWALL_LIMIT = 5000
WINDOW = timedelta(hours=1)
INGEST_DELAY = timedelta(minutes=2)
MAX_WINDOWS_PER_RUN = 24
MAX_AUDIT_PAGES = 50


class Cloudflare:
    def __init__(self, token: str, opener=None) -> None:
        self.headers = {"Authorization": f"Bearer {token}"}
        self.opener = opener

    def rest(self, path: str) -> dict:
        status, payload = http_json("GET", API + path, dict(self.headers), opener=self.opener)
        if status in (401, 403):
            raise ProviderError("Cloudflare denied the request", status)
        if status != 200 or not isinstance(payload, dict) or payload.get("success") is not True:
            raise ProviderError("Cloudflare request failed", status)
        return payload

    def graphql(self, query: str, variables: dict) -> dict:
        status, payload = http_json(
            "POST", API + "/graphql", dict(self.headers), {"query": query, "variables": variables}, opener=self.opener
        )
        if status in (401, 403):
            raise ProviderError("Cloudflare GraphQL denied the request", status)
        if status != 200 or not isinstance(payload, dict) or payload.get("errors") or not isinstance(payload.get("data"), dict):
            raise ProviderError("Cloudflare GraphQL request failed", status)
        return payload["data"]


def audit_event(record: dict, account_id: str, now: str) -> dict:
    action = record.get("action") if isinstance(record.get("action"), dict) else {}
    actor = record.get("actor") if isinstance(record.get("actor"), dict) else {}
    resource = record.get("resource") if isinstance(record.get("resource"), dict) else {}
    metadata = record.get("metadata") if isinstance(record.get("metadata"), dict) else {}
    return {
        "qapaq": {"vendor": "cloudflare", "source": "audit_logs", "event_type": "audit", "collected_at": now},
        "cloudflare": {
            "account_id": account_id,
            "audit": {
                "id": str(record.get("id") or ""),
                "when": str(record.get("when") or ""),
                "action": str(action.get("type") or "")[:100],
                "result": "true" if action.get("result") is True else "false",
                "actor_type": str(actor.get("type") or "")[:32],
                "actor_email": str(actor.get("email") or "")[:200],
                "actor_ip": str(actor.get("ip") or "")[:64],
                "resource_type": str(resource.get("type") or "")[:100],
                "resource_id": str(resource.get("id") or "")[:100],
                "zone_name": str(metadata.get("zone_name") or "")[:255],
                "interface": str(record.get("interface") or "")[:32],
            },
        },
    }


def firewall_event(record: dict, zone: dict, now: str) -> dict:
    return {
        "qapaq": {"vendor": "cloudflare", "source": "firewall_events", "event_type": "firewall", "collected_at": now},
        "cloudflare": {
            "zone_id": zone["id"],
            "zone_name": zone["name"],
            "firewall": {
                "datetime": str(record.get("datetime") or ""),
                "action": str(record.get("action") or "")[:32],
                "source": str(record.get("source") or "")[:64],
                "client_ip": str(record.get("clientIP") or "")[:64],
                "country": str(record.get("clientCountryName") or "")[:8],
                "asn": str(record.get("clientAsn") or "")[:16],
                "host": str(record.get("clientRequestHTTPHost") or "")[:255],
                "path": str(record.get("clientRequestPath") or "")[:512],
                "method": str(record.get("clientRequestHTTPMethodName") or "")[:16],
                "ray": str(record.get("rayName") or "")[:32],
                "rule_id": str(record.get("ruleId") or "")[:64],
                "rule_description": str(record.get("description") or "")[:255],
                "user_agent": str(record.get("userAgent") or "")[:300],
                "status": str(record.get("edgeResponseStatus") or "")[:8],
            },
        },
    }


def record_key(record: dict) -> str:
    return hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()[:24]


def collect_audit(client: Cloudflare, account_id: str, since_text: str, seen: set, now: str) -> tuple[list[dict], str, list[str]]:
    events, keys, newest = [], [], since_text
    for page in range(1, MAX_AUDIT_PAGES + 1):
        query = urllib.parse.urlencode({"since": since_text, "direction": "asc", "per_page": 100, "page": page})
        records = client.rest(f"/accounts/{account_id}/audit_logs?{query}").get("result") or []
        for record in records:
            if not isinstance(record, dict) or not record.get("id") or record["id"] in seen:
                continue
            keys.append(record["id"])
            events.append(audit_event(record, account_id, now))
            when = str(record.get("when") or "")
            if when:
                try:
                    if parse_iso(when) > parse_iso(newest):
                        newest = iso(parse_iso(when))
                except ValueError:
                    pass
        if len(records) < 100:
            break
    return events, newest, keys


def collect_firewall(client: Cloudflare, zone: dict, since, until, seen: set, now: str) -> tuple[list[dict], object, list[str]]:
    events, keys, cursor = [], [], since
    windows = 0
    while cursor < until and windows < MAX_WINDOWS_PER_RUN:
        windows += 1
        window_end = min(cursor + WINDOW, until)
        data = client.graphql(FIREWALL_QUERY, {"zone": zone["id"], "since": iso(cursor), "until": iso(window_end), "limit": FIREWALL_LIMIT})
        zones = ((data.get("viewer") or {}).get("zones")) or []
        records = (zones[0] or {}).get("firewallEventsAdaptive") if zones else []
        records = [r for r in records or [] if isinstance(r, dict)]
        newest = cursor
        for record in records:
            key = record_key(record)
            try:
                newest = max(newest, parse_iso(str(record.get("datetime"))))
            except ValueError:
                pass
            if key in seen:
                continue
            keys.append(key)
            seen.add(key)
            events.append(firewall_event(record, zone, now))
        if len(records) >= FIREWALL_LIMIT:
            # Truncated window: resume from the newest instant seen (inclusive, dedupe by key).
            cursor = newest if newest > cursor else window_end
        else:
            cursor = window_end
    return events, cursor, keys


def collect(config: dict, state: dict, client: Cloudflare | None = None) -> tuple[list[dict], dict]:
    if client is None:
        client = Cloudflare(read_secret(pathlib.Path(config["token_file"])))
    now = utc_now()
    now_text = iso(now)
    lookback = timedelta(hours=int(config.get("initial_lookback_hours", 1)))
    max_lookback = timedelta(hours=int(config.get("max_lookback_hours", 24)))
    events: list[dict] = []

    audit_cursors = dict(state.get("audit_cursors") or {})
    audit_seen = list(state.get("audit_seen") or [])
    if config.get("audit", True):
        accounts = config.get("account_ids") or [str(a.get("id")) for a in client.rest("/accounts?per_page=50").get("result") or []]
        for account_id in accounts:
            since_text = audit_cursors.get(account_id) or iso(now - lookback)
            batch, newest, keys = collect_audit(client, account_id, since_text, set(audit_seen), now_text)
            events.extend(batch)
            audit_seen.extend(keys)
            audit_cursors[account_id] = newest

    fw_cursors = dict(state.get("firewall_cursors") or {})
    fw_seen = list(state.get("firewall_seen") or [])
    if config.get("firewall", True):
        zones = [
            {"id": str(z.get("id")), "name": str(z.get("name") or "")}
            for z in client.rest("/zones?per_page=50").get("result") or []
            if isinstance(z, dict) and z.get("id")
        ]
        if config.get("zone_ids"):
            zones = [z for z in zones if z["id"] in set(config["zone_ids"])]
        until = now - INGEST_DELAY
        seen_set = set(fw_seen)
        for zone in zones:
            cursor_text = fw_cursors.get(zone["id"])
            since = parse_iso(cursor_text) if cursor_text else until - lookback
            since = max(since, until - max_lookback)
            batch, cursor, keys = collect_firewall(client, zone, since, until, seen_set, now_text)
            events.extend(batch)
            fw_seen.extend(keys)
            fw_cursors[zone["id"]] = iso(cursor)

    return events, {
        "audit_cursors": audit_cursors,
        "audit_seen": bounded_ids(audit_seen, 20000),
        "firewall_cursors": fw_cursors,
        "firewall_seen": bounded_ids(fw_seen, 50000),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=pathlib.Path)
    return run_collector("qapaq-cloudflare", parser.parse_args().config, collect)


if __name__ == "__main__":
    raise SystemExit(main())
