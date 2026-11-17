#!/usr/bin/env python3
"""Snyk REST API issues → JSONL for Wazuh. Read-only.

``GET /rest/orgs/{org_id}/issues?version=<dated>&updated_after=<cursor>`` paginated with
``links.next``. One event per (issue id, updated_at): a re-scan that does not change the issue is
not emitted again. The cursor is the newest ``updated_at`` seen, re-queried with an overlap so
late-indexed updates are not missed; the overlap window is covered by the dedupe keys.

``org_id`` is optional: without it the collector reads every org the token can see
(``GET /rest/orgs``). Project names are resolved once per run from ``/rest/orgs/{org}/projects``.
"""

from __future__ import annotations

import argparse
import pathlib
import re
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
import qapaq_vuln_priority as vulnprio  # noqa: E402

API_VERSION = "2024-10-15"
DEFAULT_API = "https://api.snyk.io"
API_PATTERN = re.compile(r"https://api(?:\.[a-z0-9-]+)?\.snyk\.io")
UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
MAX_PAGES = 200
OVERLAP = timedelta(minutes=10)
MATURITY_ORDER = {"mature": 3, "proof of concept": 2, "no known exploit": 1}


class Snyk:
    def __init__(self, api: str, token: str, opener=None) -> None:
        api = api.rstrip("/")
        if not API_PATTERN.fullmatch(api):
            raise ProviderError("Snyk API URL is not an official snyk.io host")
        self.api = api
        self.headers = {"Authorization": f"token {token}"}
        self.opener = opener

    def get(self, path_or_url: str) -> dict:
        if path_or_url.startswith("https://"):
            url = path_or_url
        elif path_or_url.startswith("/rest/"):
            url = self.api + path_or_url
        else:
            url = self.api + "/rest" + path_or_url
        if not url.startswith(self.api + "/"):
            raise ProviderError("Snyk pagination left the API host")
        status, payload = http_json(
            "GET", url, {**self.headers, "Accept": "application/vnd.api+json"}, opener=self.opener
        )
        if status in (401, 403):
            raise ProviderError("Snyk denied the request", status)
        if status != 200 or not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
            raise ProviderError("Snyk request failed", status)
        return payload

    def paged(self, path: str) -> list[dict]:
        items: list[dict] = []
        url: str | None = path
        for _ in range(MAX_PAGES):
            if not url:
                break
            payload = self.get(url)
            items.extend(item for item in payload["data"] if isinstance(item, dict))
            links = payload.get("links") if isinstance(payload.get("links"), dict) else {}
            url = links.get("next") if isinstance(links.get("next"), str) else None
        return items


def exploit_maturity(attributes: dict) -> str:
    details = attributes.get("exploit_details") if isinstance(attributes.get("exploit_details"), dict) else {}
    best = ""
    for entry in details.get("maturity_levels") or []:
        level = str(entry.get("level") or "") if isinstance(entry, dict) else ""
        if MATURITY_ORDER.get(level.lower(), 0) > MATURITY_ORDER.get(best.lower(), 0):
            best = level
    return best


def issue_event(issue: dict, org_id: str, projects: dict, now: str) -> dict:
    attributes = issue.get("attributes") if isinstance(issue.get("attributes"), dict) else {}
    relationships = issue.get("relationships") if isinstance(issue.get("relationships"), dict) else {}
    scan_item = ((relationships.get("scan_item") or {}).get("data") or {}) if isinstance(relationships.get("scan_item"), dict) else {}
    project_id = str(scan_item.get("id") or "")
    problems = [p for p in attributes.get("problems") or [] if isinstance(p, dict)]
    coordinates = [c for c in attributes.get("coordinates") or [] if isinstance(c, dict)]
    package = {}
    for coordinate in coordinates:
        for representation in coordinate.get("representations") or []:
            dependency = representation.get("dependency") if isinstance(representation, dict) else None
            if isinstance(dependency, dict):
                package = {"name": str(dependency.get("package_name") or "")[:200],
                           "version": str(dependency.get("package_version") or "")[:100]}
                break
        if package:
            break
    risk = attributes.get("risk") if isinstance(attributes.get("risk"), dict) else {}
    score = (risk.get("score") or {}).get("value") if isinstance(risk.get("score"), dict) else None
    resolution = attributes.get("resolution") if isinstance(attributes.get("resolution"), dict) else {}
    fixable = any(c.get("is_fixable_snyk") or c.get("is_upgradeable") or c.get("is_patchable") for c in coordinates)
    return {
        "qapaq": {"vendor": "snyk", "source": "issues", "event_type": "issue", "collected_at": now},
        "snyk": {
            "issue": {
                "id": str(issue.get("id") or ""),
                "key": str(attributes.get("key") or "")[:200],
                "title": str(attributes.get("title") or "")[:300],
                "type": str(attributes.get("type") or "")[:64],
                "status": str(attributes.get("status") or "")[:32],
                "severity": str(attributes.get("effective_severity_level") or "")[:16],
                "ignored": "true" if attributes.get("ignored") is True else "false",
                "created_at": str(attributes.get("created_at") or ""),
                "updated_at": str(attributes.get("updated_at") or ""),
                "exploit_maturity": exploit_maturity(attributes),
                "risk_score": score if isinstance(score, int) else None,
                "fixable": "true" if fixable else "false",
                "problems": [str(p.get("id") or "")[:100] for p in problems][:10],
                "resolution": str(resolution.get("type") or "")[:32],
                "package": package,
            },
            "org_id": org_id,
            "project": {"id": project_id, "name": projects.get(project_id, "")[:300]},
        },
    }


def collect(config: dict, state: dict, client: Snyk | None = None) -> tuple[list[dict], dict]:
    if client is None:
        client = Snyk(config.get("api_url") or DEFAULT_API, read_secret(pathlib.Path(config["token_file"])))
    now = utc_now()
    now_text = iso(now)
    org_ids = [config["org_id"]] if config.get("org_id") else [
        str(org.get("id")) for org in client.paged(f"/orgs?version={API_VERSION}&limit=100")
    ]
    if not org_ids or any(not UUID.fullmatch(org) for org in org_ids):
        raise ProviderError("Snyk organization id is invalid or no org is visible to the token")
    cursors = dict(state.get("cursors") or {})
    seen = list(state.get("seen") or [])
    seen_set = set(seen)
    events: list[dict] = []
    lookback = timedelta(hours=int(config.get("initial_lookback_hours", 24)))
    for org_id in org_ids:
        cursor_text = cursors.get(org_id)
        since = parse_iso(cursor_text) - OVERLAP if cursor_text else now - lookback
        projects = {
            str(project.get("id")): str((project.get("attributes") or {}).get("name") or "")
            for project in client.paged(f"/orgs/{org_id}/projects?version={API_VERSION}&limit=100")
        }
        query = urllib.parse.urlencode({"version": API_VERSION, "limit": 100, "updated_after": iso(since)})
        newest = parse_iso(cursor_text) if cursor_text else since
        for issue in client.paged(f"/orgs/{org_id}/issues?{query}"):
            event = issue_event(issue, org_id, projects, now_text)
            data = event["snyk"]["issue"]
            key = f"{data['id']}@{data['updated_at']}"
            if not data["id"] or key in seen_set:
                continue
            seen.append(key)
            seen_set.add(key)
            events.append(event)
            try:
                newest = max(newest, parse_iso(data["updated_at"]))
            except ValueError:
                pass
        cursors[org_id] = iso(newest)
    enrich_events(events, config)
    return events, {"cursors": cursors, "seen": bounded_ids(seen, 50000)}


def enrich_events(events: list[dict], config: dict) -> int:
    """Add ``qapaq.vuln`` (KEV/EPSS/exposure priority) when the daily intel cache is available.

    Optional and fail-safe: without ``vulnprio_dir`` or with a missing/stale cache the events keep
    their original shape and the rules keep the original Snyk level (docs/20).
    """
    directory = config.get("vulnprio_dir")
    if not directory or not events:
        return 0
    try:
        intel = vulnprio.load_intel(pathlib.Path(directory))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"qapaq-snyk: vulnerability intel unavailable ({type(error).__name__}); events not enriched", file=sys.stderr)
        return 0
    enriched = 0
    for event in events:
        issue = event["snyk"]["issue"]
        cves = vulnprio.extract_cves(issue.get("problems") or [])
        fixable = {"true": True, "false": False}.get(issue.get("fixable"))
        block = vulnprio.prioritize(
            cves,
            issue.get("severity", ""),
            intel,
            exposed=vulnprio.project_exposed(event["snyk"]["project"].get("name", ""), intel),
            fixable=fixable,
            exploit_mature=str(issue.get("exploit_maturity") or "").lower() == "mature",
        )
        block["source"] = "inline"
        event["qapaq"]["vuln"] = block
        enriched += 1
    return enriched


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=pathlib.Path)
    return run_collector("qapaq-snyk", parser.parse_args().config, collect)


if __name__ == "__main__":
    raise SystemExit(main())
