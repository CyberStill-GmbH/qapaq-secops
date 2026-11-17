#!/usr/bin/env python3
"""QAPAQ vulnerability prioritization: CISA KEV + FIRST EPSS + exposure for Snyk and Wazuh VD (docs/20).

Subcommands (systemd ``qapaq-vulnprio.timer`` runs ``run`` hourly; ``refresh`` is part of it):

- ``refresh``  Download the CISA KEV JSON and the FIRST EPSS bulk CSV when the cache is older than
               ``refresh_hours`` (default 24). Atomic replace; on failure the previous cache stays.
               Also rebuilds ``exposure.json`` (Snyk projects behind Cloudflare from the CDB list
               ``qapaq-internet-facing-projects`` + configured patterns, exposed agents).
- ``run``      ``refresh`` + prioritize open findings (Wazuh vulnerability detection state from
               ``wazuh-states-vulnerabilities-*`` and the latest Snyk issues from the collector JSONL),
               emit ``qapaq-vulnprio`` events for P1/P2 findings whose priority changed, write the CDB
               lists ``qapaq-vuln-kev`` / ``qapaq-vuln-noise`` for native VD alerts and a daily summary.
- ``report``   Print before/after counts of high+critical (JSON) without emitting.

Why both inline fields and CDB lists: Snyk events are enriched at ingest time by the collector
(``qapaq.vuln.*``; no manager restart, decided before the alert exists). Native Wazuh VD alerts cannot
be enriched in flight, and their CVE is a single field, so a CDB list keyed by CVE is the Wazuh-native
way to re-level them; CDB lists load when analysisd starts, so list updates apply on the next manager
restart (the installer restarts once after ``wazuh-analysisd -t``). P1/P2 changes never wait: they are
emitted as ``qapaq-vulnprio`` events immediately.

Feeds: CISA KEV is CC0 (public domain). FIRST EPSS is published free of charge without registration;
FIRST asks for attribution ("EPSS by FIRST.org"), recorded in the events (``qapaq.vuln.epss_model``) and docs/20.
The bulk CSV is used instead of per-CVE API calls so the CVE inventory never leaves the host.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import pathlib
import re
import sys
import tempfile
from collections import Counter
from datetime import datetime, timedelta, timezone

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from qapaq_platform_common import (  # noqa: E402
    Indexer,
    ProviderError,
    emit,
    https_get,
    iso,
    load_config,
    parse_iso,
    read_state,
    run,
    save_state,
    utc_now,
)
import qapaq_vuln_priority as vp  # noqa: E402  (provider-ingestion/common, on sys.path via qapaq_platform_common)

KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"
EPSS_URL = "https://epss.empiricalsecurity.com/epss_scores-current.csv.gz"
MAX_FEED_BYTES = 64 * 1024 * 1024


# --------------------------------------------------------------------------- feeds


def _atomic_write(path: pathlib.Path, data: bytes) -> None:
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".qapaq-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def fetch(url: str, getter=https_get, redirects: int = 3) -> bytes:
    for _ in range(redirects + 1):
        result = getter(url, timeout=60)
        if result.status in (301, 302, 303, 307, 308):
            location = result.headers.get("Location") or result.headers.get("location")
            if not location or not location.startswith("https://"):
                raise ProviderError("feed redirect is not https")
            url = location
            continue
        if result.status != 200:
            raise ProviderError("feed download failed", result.status)
        return result.body
    raise ProviderError("too many redirects")


def build_kev(raw: bytes, now: datetime) -> dict:
    data = json.loads(raw)
    vulns = data.get("vulnerabilities")
    if not isinstance(vulns, list) or len(vulns) < 100:
        raise ProviderError("KEV feed looks truncated")
    cves = {}
    for item in vulns:
        cve = vp.normalize_cve(item.get("cveID"))
        if cve:
            cves[cve] = {k: str(item.get(k) or "")[:200] for k in
                         ("vendorProject", "product", "dateAdded", "dueDate", "knownRansomwareCampaignUse")}
    return {"generated_at": iso(now), "catalog_version": str(data.get("catalogVersion") or ""),
            "date_released": str(data.get("dateReleased") or ""), "count": len(cves), "cves": cves,
            "source": KEV_URL, "license": "CC0-1.0 (CISA)"}


def validate_epss(raw: bytes) -> int:
    scores, model, _date = vp.parse_epss_csv(raw)
    if len(scores) < 10000:
        raise ProviderError("EPSS feed looks truncated")
    return len(scores)


def cache_age_hours(cache: pathlib.Path, now: datetime) -> float | None:
    try:
        generated = json.loads((cache / "kev.json").read_text(encoding="utf-8")).get("generated_at")
        return (now - parse_iso(generated)).total_seconds() / 3600
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def refresh_feeds(config: dict, now: datetime, getter=https_get, force: bool = False) -> dict:
    cache = pathlib.Path(config["cache_dir"])
    age = cache_age_hours(cache, now)
    if not force and age is not None and age < float(config.get("refresh_hours", 24)) and (cache / "epss.csv.gz").is_file():
        return {"refreshed": False, "age_hours": round(age, 1)}
    kev_raw = fetch(config.get("kev_url", KEV_URL), getter)
    if len(kev_raw) > MAX_FEED_BYTES:
        raise ProviderError("KEV feed too large")
    kev = build_kev(kev_raw, now)
    epss_raw = fetch(config.get("epss_url", EPSS_URL), getter)
    if len(epss_raw) > MAX_FEED_BYTES:
        raise ProviderError("EPSS feed too large")
    count = validate_epss(epss_raw)
    if epss_raw[:2] != b"\x1f\x8b":
        epss_raw = gzip.compress(epss_raw)
    _atomic_write(cache / "epss.csv.gz", epss_raw)
    _atomic_write(cache / "kev.json", json.dumps(kev, separators=(",", ":")).encode())
    return {"refreshed": True, "kev": kev["count"], "epss": count}


def write_policy_and_exposure(config: dict, now: datetime, list_reader=None) -> dict:
    cache = pathlib.Path(config["cache_dir"])
    policy = {k: config.get("policy", {}).get(k, v) for k, v in vp.DEFAULT_POLICY.items()}
    _atomic_write(cache / "policy.json", json.dumps(policy, indent=1).encode())
    exposure_cfg = config.get("exposure") or {}
    projects = set(exposure_cfg.get("snyk_projects") or [])
    reader = list_reader or read_manager_list
    list_name = exposure_cfg.get("cdb_list", "qapaq-internet-facing-projects")
    if list_name:
        for key in reader(config, list_name):
            if not key.endswith(".invalid"):
                projects.add(key)
    exposure = {"generated_at": iso(now), "snyk_projects": sorted(projects),
                "snyk_project_patterns": list(exposure_cfg.get("snyk_project_patterns") or []),
                "agents": sorted(set(exposure_cfg.get("agents") or []))}
    _atomic_write(cache / "exposure.json", json.dumps(exposure, indent=1).encode())
    return exposure


def read_manager_list(config: dict, name: str) -> list[str]:
    """Keys of a CDB list in the manager container (read-only ``docker exec cat``)."""
    container = (config.get("manager") or {}).get("container", "qapaq-wazuh.manager-1")
    if not re.fullmatch(r"[A-Za-z0-9._-]+", name):
        return []
    code, out = run(["docker", "exec", container, "cat", f"/var/ossec/etc/lists/{name}"], timeout=15)
    if code != 0:
        return []
    keys = []
    for line in out.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key = line.split(":", 1)[0].strip().strip('"')
        if key:
            keys.append(key)
    return keys


# --------------------------------------------------------------------------- findings


def wazuh_findings(indexer: Indexer, page: int = 2000, limit: int = 200000) -> list[dict]:
    fields = ["agent.id", "agent.name", "package.name", "package.version", "vulnerability.id",
              "vulnerability.severity", "vulnerability.score.base", "vulnerability.under_evaluation"]
    sort = [{"agent.id": "asc"}, {"vulnerability.id": "asc"}, {"package.name": "asc"}]
    out, after = [], None
    while len(out) < limit:
        body = {"size": page, "_source": fields, "sort": sort, "track_total_hits": False}
        if after:
            body["search_after"] = after
        hits = ((indexer.search("wazuh-states-vulnerabilities-*", body) or {}).get("hits") or {}).get("hits") or []
        if not hits:
            break
        for hit in hits:
            src = hit.get("_source") or {}
            agent, pkg, vuln = src.get("agent") or {}, src.get("package") or {}, src.get("vulnerability") or {}
            out.append({
                "kind": "wazuh-vd",
                "id": f"{agent.get('id')}|{vuln.get('id')}|{pkg.get('name')}|{pkg.get('version')}",
                "asset": str(agent.get("name") or agent.get("id") or ""),
                "agent_id": str(agent.get("id") or ""),
                "cves": vp.extract_cves([vuln.get("id")]),
                "severity": str(vuln.get("severity") or ""),
                "package": str(pkg.get("name") or ""),
                "package_version": str(pkg.get("version") or ""),
                "fixable": None,
                "mature": False,
                "title": str(vuln.get("id") or ""),
            })
        after = hits[-1].get("sort")
        if len(hits) < page or not after:
            break
    return out


def snyk_findings(paths: list[pathlib.Path]) -> list[dict]:
    """Latest state per Snyk issue from the collector JSONL (current + rotated generation)."""
    latest: dict[str, dict] = {}
    for path in paths:
        if not path.is_file():
            continue
        with path.open("r", encoding="utf-8", errors="replace") as stream:
            for line in stream:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if (event.get("qapaq") or {}).get("vendor") != "snyk" or (event.get("qapaq") or {}).get("event_type") == "canary":
                    continue
                issue = (event.get("snyk") or {}).get("issue") or {}
                if not issue.get("id"):
                    continue
                previous = latest.get(issue["id"])
                if previous is None or str(issue.get("updated_at", "")) >= str(previous["issue"].get("updated_at", "")):
                    latest[issue["id"]] = {"issue": issue, "project": (event.get("snyk") or {}).get("project") or {},
                                           "inline": ((event.get("qapaq") or {}).get("vuln") or {}).get("priority")}
    out = []
    for issue_id, item in latest.items():
        issue = item["issue"]
        if issue.get("status") != "open" or issue.get("ignored") == "true":
            continue
        out.append({
            "kind": "snyk",
            "id": issue_id,
            "asset": str(item["project"].get("name") or ""),
            "cves": vp.extract_cves(issue.get("problems") or []),
            "severity": str(issue.get("severity") or ""),
            "package": str((issue.get("package") or {}).get("name") or ""),
            "package_version": str((issue.get("package") or {}).get("version") or ""),
            "fixable": {"true": True, "false": False}.get(issue.get("fixable")),
            "mature": str(issue.get("exploit_maturity") or "").lower() == "mature",
            "title": str(issue.get("title") or "")[:300],
            "inline_priority": item["inline"],
        })
    return out


def evaluate(findings: list[dict], intel: vp.Intel) -> list[dict]:
    for finding in findings:
        exposed = (vp.agent_exposed(finding["asset"], intel) if finding["kind"] == "wazuh-vd"
                   else vp.project_exposed(finding["asset"], intel))
        finding["vuln"] = vp.prioritize(finding["cves"], finding["severity"], intel, exposed=exposed,
                                        fixable=finding["fixable"], exploit_mature=finding["mature"])
        prio = finding["vuln"]["priority"]
        if finding["kind"] == "snyk":
            finding["level_before"] = vp.snyk_level_before(finding["severity"], finding["mature"], exposed)
            finding["level_after"] = vp.snyk_level_after(finding["severity"], finding["mature"], prio, exposed)
        else:
            finding["level_before"] = vp.vd_level_before(finding["severity"])
            finding["level_after"] = vp.vd_level_after(finding["severity"], prio, exposed)
    return findings


def summarize(findings: list[dict]) -> dict:
    def bucket(level: int) -> str:
        return "critical" if level >= 12 else ("high" if level >= 10 else ("medium" if level >= 7 else "low"))

    report = {}
    for kind in sorted({f["kind"] for f in findings} | {"snyk", "wazuh-vd"}):
        items = [f for f in findings if f["kind"] == kind]
        before = Counter(bucket(f["level_before"]) for f in items)
        after = Counter(bucket(f["level_after"]) for f in items)
        report[kind] = {
            "findings": len(items),
            "before": {"critical": before["critical"], "high": before["high"], "high_or_critical": before["critical"] + before["high"]},
            "after": {"critical": after["critical"], "high": after["high"], "high_or_critical": after["critical"] + after["high"]},
            "priority": dict(sorted(Counter(f["vuln"]["priority"] for f in items).items())),
            "kev": sum(1 for f in items if f["vuln"]["kev"] == "true"),
            "epss_high": sum(1 for f in items if f["vuln"]["epss_band"] == "high"),
            "exposed": sum(1 for f in items if f["vuln"]["exposed"] == "true"),
            "raised": sum(1 for f in items if f["level_after"] > f["level_before"]),
            "lowered": sum(1 for f in items if f["level_after"] < f["level_before"]),
        }
    total_before = sum(r["before"]["high_or_critical"] for r in report.values())
    total_after = sum(r["after"]["high_or_critical"] for r in report.values())
    report["total"] = {"before_high_or_critical": total_before, "after_high_or_critical": total_after,
                       "reduction_pct": round((1 - total_after / total_before) * 100, 1) if total_before else 0.0}
    return report


def finding_event(finding: dict, now: datetime, previous: str | None, intel: vp.Intel) -> dict:
    vuln = dict(finding["vuln"])
    vuln.update({
        "asset": finding["asset"], "asset_type": "agent" if finding["kind"] == "wazuh-vd" else "snyk_project",
        "finding_id": finding["id"][:300], "severity": finding["severity"], "package": finding["package"][:200],
        "package_version": finding["package_version"][:100], "title": finding["title"][:300],
        "previous_priority": previous or "none", "epss_model": intel.epss_model, "epss_date": intel.epss_date,
        "kev_catalog": intel.kev_version, "level_before": finding["level_before"], "level_after": finding["level_after"],
    })
    if finding.get("agent_id"):
        vuln["agent_id"] = finding["agent_id"]
    return {"qapaq": {"vendor": "qapaq-vulnprio", "source": finding["kind"], "event_type": "finding",
                    "collected_at": iso(now), "vuln": vuln}}


def changed_events(findings: list[dict], state: dict, now: datetime, intel: vp.Intel, max_events: int = 500) -> tuple[list[dict], dict]:
    """P1/P2 findings whose priority differs from the last one QAPAQ saw (inline or previous run)."""
    known = dict(state.get("priorities") or {})
    events, current = [], {}
    for finding in findings:
        key = f"{finding['kind']}|{finding['id']}"
        prio = finding["vuln"]["priority"]
        current[key] = prio
        previous = known.get(key) or finding.get("inline_priority")
        if prio in ("P1", "P2") and prio != previous and len(events) < max_events:
            events.append(finding_event(finding, now, previous, intel))
    new_state = dict(state)
    new_state["priorities"] = current
    return events, new_state


def summary_event(report: dict, now: datetime, intel: vp.Intel) -> dict:
    flat = {"before_high_or_critical": report["total"]["before_high_or_critical"],
            "after_high_or_critical": report["total"]["after_high_or_critical"],
            "reduction_pct": report["total"]["reduction_pct"], "kev_catalog": intel.kev_version,
            "epss_model": intel.epss_model, "epss_date": intel.epss_date}
    for kind in ("snyk", "wazuh-vd"):
        r = report.get(kind) or {}
        tag = kind.replace("-", "_")
        flat[f"{tag}_findings"] = r.get("findings", 0)
        flat[f"{tag}_before"] = (r.get("before") or {}).get("high_or_critical", 0)
        flat[f"{tag}_after"] = (r.get("after") or {}).get("high_or_critical", 0)
        flat[f"{tag}_p1"] = (r.get("priority") or {}).get("P1", 0)
        flat[f"{tag}_p4"] = (r.get("priority") or {}).get("P4", 0)
    return {"qapaq": {"vendor": "qapaq-vulnprio", "source": "summary", "event_type": "summary",
                    "collected_at": iso(now), "vuln_summary": flat}}


def cdb_lists(findings: list[dict], intel: vp.Intel) -> dict[str, str]:
    """``qapaq-vuln-kev``: every KEV CVE (all sources). ``qapaq-vuln-noise``: VD CVEs that are P4 on every
    asset where they appear (a CVE on an exposed agent is never noise)."""
    kev = "".join(f"{cve}:kev\n" for cve in sorted(intel.kev))
    by_cve: dict[str, set] = {}
    for f in findings:
        if f["kind"] != "wazuh-vd":
            continue
        for cve in f["cves"]:
            by_cve.setdefault(cve, set()).add(f["vuln"]["priority"])
    noise = "".join(f"{cve}:p4\n" for cve, prios in sorted(by_cve.items()) if prios == {"P4"})
    return {"qapaq-vuln-kev": kev or "CVE-0000-0000.invalid:none\n", "qapaq-vuln-noise": noise or "CVE-0000-0000.invalid:none\n"}


def sync_lists(config: dict, lists: dict[str, str], state: dict) -> tuple[list[str], dict]:
    """Copy changed lists into the manager (``etc/lists``). Takes effect on the next analysisd start."""
    import hashlib  # noqa: PLC0415

    container = (config.get("manager") or {}).get("container", "qapaq-wazuh.manager-1")
    hashes = dict(state.get("list_hashes") or {})
    changed = []
    for name, content in lists.items():
        digest = hashlib.sha256(content.encode()).hexdigest()
        if hashes.get(name) == digest:
            continue
        with tempfile.NamedTemporaryFile("w", delete=False, suffix=".cdb", encoding="utf-8") as tmp:
            tmp.write(content)
            local = tmp.name
        try:
            code, _ = run(["docker", "cp", local, f"{container}:/tmp/{name}"], timeout=30)
            if code == 0:
                code, _ = run(["docker", "exec", "-u", "0", container, "install", "-o", "wazuh", "-g", "wazuh", "-m", "0660",
                               f"/tmp/{name}", f"/var/ossec/etc/lists/{name}"], timeout=30)
                run(["docker", "exec", "-u", "0", container, "rm", "-f", f"/tmp/{name}"], timeout=15)
        finally:
            os.unlink(local)
        if code != 0:
            raise ProviderError(f"could not install CDB list {name}")
        hashes[name] = digest
        changed.append(name)
    new_state = dict(state)
    new_state["list_hashes"] = hashes
    return changed, new_state


# --------------------------------------------------------------------------- driver


def gather(config: dict, intel: vp.Intel, indexer=None) -> tuple[list[dict], list[str]]:
    errors = []
    findings = []
    out_dir = pathlib.Path(config.get("snyk_jsonl", "/var/ossec/logs/qapaq-collectors/snyk-issues.jsonl"))
    findings.extend(snyk_findings([out_dir.with_name(out_dir.name + ".1"), out_dir]))
    if config.get("wazuh_vd", True):
        try:
            findings.extend(wazuh_findings(indexer or Indexer(config.get("indexer") or {})))
        except ProviderError as error:
            errors.append(f"wazuh-vd: {error}{' HTTP ' + str(error.status) if error.status else ''}")
    return evaluate(findings, intel), errors


def cmd_run(config: dict, now: datetime, indexer=None, getter=https_get, list_reader=None, do_sync: bool = True) -> dict:
    state_path = pathlib.Path(config["state_file"])
    state = read_state(state_path)
    result = {}
    try:
        result["refresh"] = refresh_feeds(config, now, getter)
    except ProviderError as error:
        result["refresh"] = {"refreshed": False, "error": str(error)}
    write_policy_and_exposure(config, now, list_reader)
    intel = vp.load_intel(config["cache_dir"], now=now)
    findings, errors = gather(config, intel, indexer)
    report = summarize(findings)
    events, state = changed_events(findings, state, now, intel, int(config.get("max_events_per_run", 500)))
    last_summary = state.get("last_summary")
    if not last_summary or (now - parse_iso(last_summary)) >= timedelta(hours=float(config.get("summary_hours", 24))):
        events.append(summary_event(report, now, intel))
        state["last_summary"] = iso(now)
    if do_sync and config.get("sync_cdb_lists", True):
        try:
            changed, state = sync_lists(config, cdb_lists(findings, intel), state)
            result["lists_changed"] = changed
        except ProviderError as error:
            errors.append(str(error))
    emit(config["output_file"], events)
    state["last_success"] = iso(now)
    state["last_report"] = report
    state["errors"] = errors
    save_state(state_path, state)
    pathlib.Path(config["cache_dir"], "report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    result.update({"events": len(events), "report": report, "errors": errors})
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["refresh", "run", "report"])
    parser.add_argument("--config", required=True, type=pathlib.Path)
    parser.add_argument("--force", action="store_true", help="refresh feeds even if the cache is fresh")
    args = parser.parse_args()
    now = utc_now()
    try:
        config = load_config(args.config)
        if args.command == "refresh":
            print(json.dumps(refresh_feeds(config, now, force=args.force)))
            write_policy_and_exposure(config, now)
            return 0
        if args.command == "report":
            intel = vp.load_intel(config["cache_dir"], now=now)
            findings, errors = gather(config, intel)
            print(json.dumps({"report": summarize(findings), "errors": errors}, indent=1))
            return 0
        result = cmd_run(config, now)
    except (ProviderError, OSError, KeyError, ValueError) as error:
        print(f"qapaq-vulnprio: failed ({type(error).__name__}: {error})", file=sys.stderr)
        return 1
    total = result["report"]["total"]
    print(f"qapaq-vulnprio: ok events={result['events']} high+critical {total['before_high_or_critical']}"
          f" -> {total['after_high_or_critical']} lists={result.get('lists_changed', [])} errors={result['errors']}",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
