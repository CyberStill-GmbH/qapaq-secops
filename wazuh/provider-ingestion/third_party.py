#!/usr/bin/env python3
"""Read-only collectors for Cloudflare, Snyk, Bitdefender GravityZone, and M365 source health."""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

OUTPUT = pathlib.Path(os.environ.get("QAPAQ_PROVIDER_OUTPUT_DIR", "/opt/qapaq/provider-ingestion/logs"))
STATE = pathlib.Path(os.environ.get("QAPAQ_PROVIDER_STATE_DIR", "/opt/qapaq/provider-ingestion/state"))
CLOUDFLARE_API = "https://api.cloudflare.com/client/v4"
SNYK_API = "https://api.snyk.io/rest"
BITDEFENDER_API = "https://cloud.gravityzone.bitdefender.com/api/v1.2/jsonrpc/incidents"
M365_API = "https://manage.office.com/api/v1.0"


class ProviderError(RuntimeError):
    def __init__(self, status: int | None, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def request_json(url: str, headers: dict[str, str], method: str = "GET", body: dict | None = None) -> dict:
    data = json.dumps(body, separators=(",", ":")).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read(16 * 1024 * 1024)
            result = json.loads(raw)
    except urllib.error.HTTPError as error:
        raise ProviderError(error.code, "http_error") from None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        raise ProviderError(None, "connection_or_response_error") from None
    if not isinstance(result, dict):
        raise ProviderError(None, "invalid_response")
    return result


def append_json(path: pathlib.Path, event: dict) -> None:
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def load_state(vendor: str) -> dict:
    path = STATE / (vendor + ".json")
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
        return result if isinstance(result, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def save_state(vendor: str, state: dict) -> None:
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = STATE / (vendor + ".json")
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, separators=(",", ":")) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def health(vendor: str, event_type: str, status: int | None = None) -> None:
    event = {
        "timestamp": iso(now_utc()),
        "integration": "qapaq-provider",
        "qapaq_vendor": vendor,
        "qapaq_event_type": event_type,
        "qapaq_severity": "low",
        "qapaq_status": "degraded" if event_type != "provider_recovered" else "healthy",
    }
    if status is not None:
        event["qapaq_http_status"] = str(status)
    append_json(OUTPUT / "health.jsonl", event)


def secret(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        path = pathlib.Path(os.environ.get("QAPAQ_PROVIDER_SECRET_DIR", "/opt/qapaq/secrets/provider-services")) / name
        try:
            if path.is_symlink():
                raise ProviderError(None, "secret_missing_or_malformed")
            value = path.read_text(encoding="utf-8").strip()
        except OSError:
            value = ""
    if not value or any(ord(char) < 32 for char in value):
        raise ProviderError(None, "secret_missing_or_malformed")
    return value

def begin(vendor: str) -> dict:
    return load_state(vendor)


def failed(vendor: str, state: dict, error: ProviderError) -> int:
    marker = f"{error.code}:{error.status or 0}"
    if state.get("last_error") != marker:
        health(vendor, "provider_api_error" if error.status not in (401, 403) else "provider_auth_failed", error.status)
    state["last_error"] = marker
    save_state(vendor, state)
    print(f"{vendor}: degraded ({error.code}, HTTP {error.status or 'none'})", file=sys.stderr)
    return 1


def succeeded(vendor: str, state: dict) -> None:
    if state.get("last_error"):
        health(vendor, "provider_recovered")
    state.pop("last_error", None)
    state["last_success"] = iso(now_utc())
    save_state(vendor, state)


def seen_add(state: dict, key: str) -> bool:
    seen = state.get("seen", {})
    if not isinstance(seen, dict):
        seen = {}
    if key in seen:
        state["seen"] = seen
        return False
    seen[key] = iso(now_utc())
    if len(seen) > 20000:
        seen = dict(list(seen.items())[-10000:])
    state["seen"] = seen
    return True


def cf_account(token: str, configured: str) -> str:
    if configured:
        return configured
    response = request_json(CLOUDFLARE_API + "/accounts?per_page=50", {"Authorization": "Bearer " + token})
    accounts = response.get("result", [])
    if not response.get("success") or len(accounts) != 1 or not accounts[0].get("id"):
        raise ProviderError(None, "account_id_missing_or_ambiguous")
    return accounts[0]["id"]


def cloudflare() -> int:
    vendor = "cloudflare"
    state = begin(vendor)
    try:
        token = secret("CLOUDFLARE_API_TOKEN")
        account = cf_account(token, os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip())
        end = now_utc()
        previous = state.get("last_success")
        try:
            start = dt.datetime.fromisoformat(previous.replace("Z", "+00:00")) - dt.timedelta(minutes=10)
        except (AttributeError, ValueError):
            start = end - dt.timedelta(hours=1)
        cursor = ""
        pages = 0
        while True:
            params = {"since": iso(start), "before": iso(end), "limit": "1000", "direction": "asc"}
            if cursor:
                params["cursor"] = cursor
            url = f"{CLOUDFLARE_API}/accounts/{urllib.parse.quote(account, safe='')}/logs/audit?{urllib.parse.urlencode(params)}"
            response = request_json(url, {"Authorization": "Bearer " + token})
            if not response.get("success"):
                raise ProviderError(None, "cloudflare_api_unsuccessful")
            records = response.get("result", [])
            for record in records:
                action = record.get("action") or {}
                actor = record.get("actor") or {}
                resource = record.get("resource") or {}
                product = str(resource.get("product") or "")
                action_type = str(action.get("type") or "")
                description = str(action.get("description") or "")
                words = (product + " " + description).lower()
                sensitive_product = any(term in words for term in ("waf", "firewall", "security", "access", "zero trust", "dns", "api token", "member"))
                destructive = action_type == "delete" or any(term in words for term in ("disable", "turned off", "removed"))
                event_type = "security_control_disabled" if sensitive_product and destructive else "audit_change"
                event_id = str(record.get("id") or hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest())
                if not seen_add(state, event_id):
                    continue
                event = {
                    "timestamp": action.get("time") or iso(end),
                    "integration": "qapaq-provider",
                    "qapaq_vendor": vendor,
                    "qapaq_event_id": event_id[:128],
                    "qapaq_event_type": event_type,
                    "qapaq_severity": "high" if event_type == "security_control_disabled" else "medium",
                    "qapaq_status": str(action.get("result") or "unknown"),
                    "qapaq_action": description[:256],
                    "qapaq_action_type": action_type[:64],
                    "qapaq_product": product[:128],
                    "qapaq_actor": str(actor.get("id") or "")[:128],
                    "qapaq_source_ip": str(actor.get("ip_address") or "")[:64],
                    "qapaq_account_id": account,
                }
                append_json(OUTPUT / "cloudflare.jsonl", event)
            pages += 1
            info = response.get("result_info") or {}
            cursor = str(info.get("cursor") or "")
            if len(records) < 1000 or not cursor or pages >= 20:
                if pages >= 20 and len(records) == 1000:
                    raise ProviderError(None, "pagination_safety_limit")
                break
        succeeded(vendor, state)
        return 0
    except ProviderError as error:
        return failed(vendor, state, error)


def snyk_org(token: str, configured: str) -> str:
    if configured:
        return configured
    url = SNYK_API + "/orgs?version=2024-10-15&limit=100"
    response = request_json(url, {"Authorization": "token " + token, "Accept": "application/vnd.api+json"})
    orgs = response.get("data", [])
    matches = [item for item in orgs if str((item.get("attributes") or {}).get("name", "")).casefold() == "qapaq"]
    if len(matches) != 1:
        raise ProviderError(None, "snyk_org_id_missing_or_ambiguous")
    return str(matches[0].get("id", ""))


def snyk() -> int:
    vendor = "snyk"
    state = begin(vendor)
    try:
        token = secret("SNYK_TOKEN")
        org_id = snyk_org(token, os.environ.get("SNYK_ORG_ID", "").strip())
        end = now_utc()
        previous = state.get("last_success")
        try:
            start = dt.datetime.fromisoformat(previous.replace("Z", "+00:00")) - dt.timedelta(minutes=10)
        except (AttributeError, ValueError):
            start = end - dt.timedelta(days=1)
        base = f"{SNYK_API}/orgs/{urllib.parse.quote(org_id, safe='')}/issues"
        params = {"version": "2024-10-15", "limit": "100", "updated_after": iso(start)}
        url = base + "?" + urllib.parse.urlencode(params)
        pages = 0
        while url:
            if urllib.parse.urlparse(url).hostname != "api.snyk.io":
                raise ProviderError(None, "unsafe_pagination_url")
            response = request_json(url, {"Authorization": "token " + token, "Accept": "application/vnd.api+json"})
            for issue in response.get("data", []):
                attributes = issue.get("attributes") or {}
                severity = str(attributes.get("effective_severity_level") or "").lower()
                status = str(attributes.get("status") or "").lower()
                if status not in ("open", "active", "new") or severity not in ("critical", "high", "medium", "low"):
                    continue
                issue_id = str(issue.get("id") or "")
                updated = str(attributes.get("updated_at") or attributes.get("created_at") or "")
                fingerprint = issue_id + ":" + updated + ":" + status
                if not issue_id or not seen_add(state, fingerprint):
                    continue
                relationships = issue.get("relationships") or {}
                scan_item = (relationships.get("scan_item") or {}).get("data") or {}
                risk = attributes.get("risk") or {}
                event = {
                    "timestamp": updated or iso(end),
                    "integration": "qapaq-provider",
                    "qapaq_vendor": vendor,
                    "qapaq_event_id": issue_id[:128],
                    "qapaq_event_type": "vulnerability_found",
                    "qapaq_severity": severity,
                    "qapaq_status": status,
                    "qapaq_issue_type": str(attributes.get("type") or "")[:64],
                    "qapaq_issue_title": str(attributes.get("title") or "")[:256],
                    "qapaq_issue_id": issue_id[:128],
                    "qapaq_project_id": str(scan_item.get("id") or "")[:128],
                    "qapaq_risk_score": str((risk.get("score") or {}).get("value") or "")[:32],
                    "qapaq_exploitable": "unknown",
                    "qapaq_org_id": org_id,
                }
                append_json(OUTPUT / "snyk.jsonl", event)
            pages += 1
            links = response.get("links") or {}
            next_link = links.get("next")
            url = str(next_link) if next_link else ""
            if pages >= 20 and url:
                raise ProviderError(None, "pagination_safety_limit")
        succeeded(vendor, state)
        return 0
    except ProviderError as error:
        return failed(vendor, state, error)


def bitdefender() -> int:
    vendor = "bitdefender"
    state = begin(vendor)
    try:
        key = secret("BITDEFENDER_API_KEY")
        region = os.environ.get("BITDEFENDER_REGION", "us").lower()
        hosts = {"us": "cloud.gravityzone.bitdefender.com", "eu": "cloud.gravityzone.bitdefender.net"}
        if region not in hosts:
            raise ProviderError(None, "unsupported_region")
        url = "https://" + hosts[region] + "/api/v1.2/jsonrpc/incidents"
        auth = base64.b64encode((key + ":").encode()).decode()
        response = request_json(url, {"Authorization": "Basic " + auth, "Content-Type": "application/json"}, "POST", {
            "id": "qapaq-monitor",
            "jsonrpc": "2.0",
            "method": "getIncidentsList",
            "params": {"page": 1, "perPage": 100, "filters": {"status": ["open", "in_progress"]}},
        })
        result = response.get("result") or {}
        pages = min(int(result.get("pagesCount") or 1), 20)
        items = list(result.get("items") or [])
        for page in range(2, pages + 1):
            follow = request_json(url, {"Authorization": "Basic " + auth, "Content-Type": "application/json"}, "POST", {
                "id": "qapaq-monitor-" + str(page), "jsonrpc": "2.0", "method": "getIncidentsList",
                "params": {"page": page, "perPage": 100, "filters": {"status": ["open", "in_progress"]}},
            })
            items.extend((follow.get("result") or {}).get("items") or [])
        for incident in items:
            severity = str(incident.get("priority") or "unknown").lower()
            status = str(incident.get("status") or "open").lower()
            incident_id = str(incident.get("incidentId") or "")
            changed = str(incident.get("lastIncidentChange") or incident.get("lastUpdated") or "")
            fingerprint = incident_id + ":" + changed + ":" + status
            if not incident_id or not seen_add(state, fingerprint):
                continue
            event = {
                "timestamp": changed or iso(now_utc()),
                "integration": "qapaq-provider",
                "qapaq_vendor": vendor,
                "qapaq_event_id": incident_id[:128],
                "qapaq_event_type": "endpoint_incident",
                "qapaq_severity": severity,
                "qapaq_status": status,
                "qapaq_endpoint_id": str(incident.get("endpointId") or "")[:128],
                "qapaq_incident_number": str(incident.get("incidentNumber") or ""),
                "qapaq_main_action": str(incident.get("mainAction") or "")[:64],
            }
            append_json(OUTPUT / "bitdefender.jsonl", event)
        succeeded(vendor, state)
        return 0
    except ProviderError as error:
        return failed(vendor, state, error)


def m365_health() -> int:
    vendor = "m365"
    state = begin(vendor)
    try:
        tenant = secret("TENANT_ID")
        client_id = secret("CLIENT_ID")
        client_secret = secret("CLIENT_SECRET")
        form = urllib.parse.urlencode({
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
            "scope": "https://manage.office.com/.default",
        }).encode()
        token_req = urllib.request.Request(
            f"https://login.microsoftonline.com/{urllib.parse.quote(tenant, safe='')}/oauth2/v2.0/token",
            data=form,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(token_req, timeout=30) as response:
                token_data = json.loads(response.read(1024 * 1024))
        except urllib.error.HTTPError as error:
            raise ProviderError(error.code, "oauth_failed") from None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
            raise ProviderError(None, "oauth_connection_error") from None
        access_token = token_data.get("access_token")
        if not access_token:
            raise ProviderError(None, "oauth_token_missing")
        url = f"{M365_API}/{urllib.parse.quote(tenant, safe='')}/activity/feed/subscriptions/list"
        request_json(url, {"Authorization": "Bearer " + access_token})
        succeeded(vendor, state)
        return 0
    except ProviderError as error:
        return failed(vendor, state, error)


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"cloudflare", "snyk", "bitdefender", "m365"}:
        print("usage: third_party.py {cloudflare|snyk|bitdefender|m365}", file=sys.stderr)
        return 2
    OUTPUT.mkdir(mode=0o750, parents=True, exist_ok=True)
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    provider = sys.argv[1]
    return {"cloudflare": cloudflare, "snyk": snyk, "bitdefender": bitdefender, "m365": m365_health}[provider]()


if __name__ == "__main__":
    raise SystemExit(main())