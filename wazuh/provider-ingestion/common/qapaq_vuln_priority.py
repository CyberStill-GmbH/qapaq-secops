#!/usr/bin/env python3
"""QAPAQ vulnerability prioritization core (CISA KEV + FIRST EPSS + exposure). Stdlib only.

Shared by the Snyk collector (inline enrichment at ingest time) and by
``wazuh/platform-monitoring/qapaq_vulnprio.py`` (feed refresh, Wazuh vulnerability-detection
findings, re-prioritization and the before/after report). docs/20-monitoreo-de-plataforma-y-priorizacion.md.

Cache directory written daily by ``qapaq_vulnprio.py refresh`` (read-only here):

- ``kev.json``      ``{"generated_at", "catalog_version", "date_released", "cves": {CVE: {...}}}``
- ``epss.csv.gz``   FIRST EPSS bulk CSV as published (``cve,epss,percentile`` + a ``#model_version`` line)
- ``exposure.json`` ``{"generated_at", "snyk_projects": [...], "snyk_project_patterns": [...], "agents": [...]}``
- ``policy.json``   thresholds (optional; defaults below)

Priority model (P1 highest). The same function decides the Wazuh field ``qapaq.vuln.priority``
that the rules ``qapaq_watch_vulnprio_rules.xml`` turn into a level:

- **P1** CVE in KEV, or EPSS >= ``epss_high`` on an Internet-exposed asset.
- **P2** EPSS >= ``epss_high`` (not exposed), or severity critical on an exposed asset.
- **P4** (noise) only with positive evidence: not in KEV, EPSS known and < ``epss_low``, the source
  says explicitly that no fix exists (``fixable is False``), not exposed and no mature exploit. The
  finding stays visible but stops paging. An *unknown* fix status (Wazuh vulnerability detection does
  not report fixes) never demotes: the original severity is kept.
- **P3** everything else: the original source level is kept.

A finding without CVE (license, code or CWE-only issues) or without intel (cache missing) is
never lowered: missing data fails safe to the original level.
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import pathlib
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

CVE_RE = re.compile(r"^CVE-\d{4}-\d{4,7}$")
DEFAULT_POLICY = {
    "epss_high": 0.5,
    "epss_low": 0.1,
    "p4_requires_no_fix": True,
    "max_cache_age_hours": 72,
}
SEVERITY_ORDER = {"low": 1, "medium": 2, "high": 3, "critical": 4}


@dataclass
class Intel:
    kev: dict = field(default_factory=dict)
    epss: dict = field(default_factory=dict)  # CVE -> (score, percentile)
    exposure_projects: set = field(default_factory=set)
    exposure_patterns: list = field(default_factory=list)
    exposure_agents: set = field(default_factory=set)
    policy: dict = field(default_factory=lambda: dict(DEFAULT_POLICY))
    epss_model: str = ""
    epss_date: str = ""
    kev_version: str = ""

    @property
    def loaded(self) -> bool:
        return bool(self.kev) and bool(self.epss)


def normalize_cve(value: object) -> str | None:
    text = str(value or "").strip().upper()
    return text if CVE_RE.match(text) else None


def extract_cves(values) -> list[str]:
    """CVE ids from a list (Snyk ``problems``) or a comma-joined string, de-duplicated, ordered."""
    if isinstance(values, str):
        values = re.split(r"[,\s]+", values)
    out: list[str] = []
    for value in values or []:
        cve = normalize_cve(value)
        if cve and cve not in out:
            out.append(cve)
    return out


def parse_epss_csv(raw: bytes) -> tuple[dict, str, str]:
    """Parse the FIRST EPSS bulk CSV (gzip or plain). Returns ``(scores, model, score_date)``."""
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    text = raw.decode("utf-8", errors="replace")
    model = date = ""
    lines = text.splitlines()
    body_start = 0
    for index, line in enumerate(lines[:3]):
        if line.startswith("#"):
            for part in line.lstrip("#").split(","):
                key, _, value = part.partition(":")
                if key.strip() == "model_version":
                    model = value.strip()
                elif key.strip() == "score_date":
                    date = value.strip()
            body_start = index + 1
    scores: dict = {}
    reader = csv.DictReader(io.StringIO("\n".join(lines[body_start:])))
    for row in reader:
        cve = normalize_cve(row.get("cve"))
        if not cve:
            continue
        try:
            scores[cve] = (float(row.get("epss") or 0), float(row.get("percentile") or 0))
        except ValueError:
            continue
    return scores, model, date


def load_intel(cache_dir: pathlib.Path | str, max_age_hours: float | None = None, now: datetime | None = None) -> Intel:
    """Load the cache. Raises ``ValueError`` if it is missing, unreadable or too old."""
    base = pathlib.Path(cache_dir)
    intel = Intel()
    policy_path = base / "policy.json"
    if policy_path.is_file():
        loaded = json.loads(policy_path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            intel.policy.update({key: loaded[key] for key in DEFAULT_POLICY if key in loaded})
    kev = json.loads((base / "kev.json").read_text(encoding="utf-8"))
    intel.kev = dict(kev.get("cves") or {})
    intel.kev_version = str(kev.get("catalog_version") or "")
    generated = kev.get("generated_at")
    limit = max_age_hours if max_age_hours is not None else float(intel.policy["max_cache_age_hours"])
    if generated and limit:
        age = ((now or datetime.now(timezone.utc)) - _parse_time(generated)).total_seconds() / 3600
        if age > limit:
            raise ValueError("vulnerability intel cache is stale")
    intel.epss, intel.epss_model, intel.epss_date = parse_epss_csv((base / "epss.csv.gz").read_bytes())
    exposure_path = base / "exposure.json"
    if exposure_path.is_file():
        exposure = json.loads(exposure_path.read_text(encoding="utf-8"))
        intel.exposure_projects = {str(p).strip().lower() for p in exposure.get("snyk_projects") or [] if str(p).strip()}
        intel.exposure_patterns = [re.compile(p, re.I) for p in exposure.get("snyk_project_patterns") or []]
        intel.exposure_agents = {str(a).strip().lower() for a in exposure.get("agents") or [] if str(a).strip()}
    if not intel.loaded:
        raise ValueError("vulnerability intel cache is empty")
    return intel


def _parse_time(value: str) -> datetime:
    text = str(value).strip().replace("Z", "+00:00")
    parsed = datetime.fromisoformat(text)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def project_exposed(name: str, intel: Intel) -> bool:
    key = (name or "").strip().lower()
    if not key:
        return False
    return key in intel.exposure_projects or any(p.search(key) for p in intel.exposure_patterns)


def agent_exposed(name: str, intel: Intel) -> bool:
    return (name or "").strip().lower() in intel.exposure_agents


def prioritize(
    cves: list[str],
    severity: str,
    intel: Intel,
    *,
    exposed: bool,
    fixable: bool | None,
    exploit_mature: bool = False,
) -> dict:
    """Return the enrichment block (``qapaq.vuln``). Values are strings/numbers safe for Wazuh JSON."""
    policy = intel.policy
    high, low = float(policy["epss_high"]), float(policy["epss_low"])
    kev_hits = [cve for cve in cves if cve in intel.kev]
    scored = [(intel.epss[cve][0], intel.epss[cve][1], cve) for cve in cves if cve in intel.epss]
    best = max(scored) if scored else None
    epss = best[0] if best else None
    sev = (severity or "").strip().lower()
    reasons: list[str] = []
    if kev_hits:
        priority = "P1"
        reasons.append("kev")
        if exposed:
            reasons.append("expuesta")
    elif epss is not None and epss >= high and exposed:
        priority, reasons = "P1", ["epss_alto", "expuesta"]
    elif epss is not None and epss >= high:
        priority, reasons = "P2", ["epss_alto"]
    elif exposed and sev == "critical":
        priority, reasons = "P2", ["critica_expuesta"]
    elif (
        cves
        and epss is not None
        and epss < low
        and not exposed
        and not exploit_mature
        and (fixable is False or not policy.get("p4_requires_no_fix", True))
    ):
        priority = "P4"
        reasons = ["epss_bajo", "no_expuesta"] + (["sin_fix"] if fixable is False else [])
    else:
        priority = "P3"
        if not cves:
            reasons = ["sin_cve"]
        elif epss is None:
            reasons = ["sin_epss"]
        elif epss < low and fixable is None and not exposed:
            reasons = ["fix_desconocido"]
        else:
            reasons = ["sin_cambio"]
    main_cve = kev_hits[0] if kev_hits else (best[2] if best else (cves[0] if cves else ""))
    block = {
        "priority": priority,
        "reason": ",".join(reasons),
        "cve": main_cve,
        "cves": cves[:10],
        "kev": "true" if kev_hits else "false",
        "exposed": "true" if exposed else "false",
        "fix": "true" if fixable is True else ("false" if fixable is False else "unknown"),
        "epss_band": "unknown" if epss is None else ("high" if epss >= high else ("low" if epss < low else "medium")),
    }
    if epss is not None:
        block["epss"] = round(epss, 5)
        block["epss_percentile"] = round(best[1], 5)
    if kev_hits:
        entry = intel.kev.get(kev_hits[0]) or {}
        block["kev_date_added"] = str(entry.get("dateAdded") or "")
        block["kev_due_date"] = str(entry.get("dueDate") or "")
        block["kev_ransomware"] = str(entry.get("knownRansomwareCampaignUse") or "Unknown")
    return block


# --------------------------------------------------------------------------- levels
# Mirror of the production rule chain so the report and the tests can compute "before" and "after"
# without a manager: qapaq_snyk_rules.xml, the detection team's calibration
# (detections/snyk/severity-calibration 101732-101734, exposed-critical-exploit 101730-101731) and
# qapaq_watch_vulnprio_rules.xml. "before" = what production does today without KEV/EPSS.

SNYK_P1_LEVEL = {"low": 12, "medium": 12, "high": 13, "critical": 14}
SNYK_P2_LEVEL = {"medium": 10, "high": 11, "critical": 12}
SNYK_P4_LEVEL = {"high": 6, "critical": 6}


def snyk_level_before(severity: str, mature: bool, exposed: bool = False) -> int:
    sev = (severity or "").lower()
    if mature:
        if sev == "critical":
            return 14 if exposed else 13
        if sev == "high":
            return 12 if exposed else 11
    return {
        "low": 3 if mature else 2,
        "medium": 5,
        "high": 10 if exposed else 7,
        "critical": 12 if exposed else 10,
    }.get(sev, 0)


def snyk_level_after(severity: str, mature: bool, priority: str, exposed: bool = False) -> int:
    sev = (severity or "").lower()
    before = snyk_level_before(sev, mature, exposed)
    if priority == "P1" and sev in SNYK_P1_LEVEL:
        return max(before, SNYK_P1_LEVEL[sev])
    if priority == "P2" and sev in SNYK_P2_LEVEL:
        return max(before, SNYK_P2_LEVEL[sev])
    if priority == "P4" and sev in SNYK_P4_LEVEL and not mature:
        return min(before, SNYK_P4_LEVEL[sev])
    return before


# Wazuh vulnerability detection (0520-vulnerability-detector_rules.xml): native alerts stay as they
# are; the QAPAQ view of a finding is the qapaq-vulnprio event level.
WAZUH_VD_LEVEL = {"low": 5, "medium": 7, "untriaged": 7, "high": 10, "critical": 13}
VULNPRIO_EVENT_LEVEL = {"P1": 13, "P1x": 14, "P2": 10, "P3": 3, "P4": 3}


def vd_level_before(severity: str) -> int:
    return WAZUH_VD_LEVEL.get((severity or "").lower(), 3)


def vd_level_after(severity: str, priority: str, exposed: bool) -> int:
    """Level of the finding in the QAPAQ view: P1/P2 come from qapaq-vulnprio, P3 keeps native, P4 is noise."""
    if priority == "P1":
        return 14 if exposed else 13
    if priority == "P2":
        return max(10, vd_level_before(severity)) if (severity or "").lower() in ("high", "critical") else 10
    if priority == "P4":
        return {"critical": 6, "high": 5}.get((severity or "").lower(), vd_level_before(severity))
    return vd_level_before(severity)
