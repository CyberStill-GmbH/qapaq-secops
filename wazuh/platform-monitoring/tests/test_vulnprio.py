"""KEV/EPSS prioritization: core model, Snyk inline enrichment, prioritizer job and report."""

from __future__ import annotations

import importlib.util
import json
import pathlib
import re

import pytest

import qapaq_vuln_priority as vp
import qapaq_vulnprio as job
from qapaq_platform_common import HttpResult, ProviderError
from conftest import NOW, epss_csv, kev_json

PM = pathlib.Path(__file__).resolve().parents[1]
PI = PM.parent / "provider-ingestion"


def load_snyk():
    spec = importlib.util.spec_from_file_location("qapaq_snyk_vp", PI / "snyk" / "issues.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --------------------------------------------------------------------------- core


def test_extract_cves_filters_and_dedupes():
    assert vp.extract_cves(["SNYK-JS-1", "cve-2021-44228", "CVE-2021-44228", "CVE-2023-0001"]) == ["CVE-2021-44228", "CVE-2023-0001"]
    assert vp.extract_cves("CVE-2020-0003,SNYK-X") == ["CVE-2020-0003"]
    assert vp.extract_cves(None) == []


def test_parse_epss_csv_reads_header(cache_dir):
    scores, model, date = vp.parse_epss_csv((cache_dir / "epss.csv.gz").read_bytes())
    assert scores["CVE-2021-44228"] == (0.97, 0.9999)
    assert model == "v2025.03.14" and date.startswith("2026-11-09")


def test_load_intel_rejects_stale_cache(cache_dir):
    with pytest.raises(ValueError):
        vp.load_intel(cache_dir, max_age_hours=1, now=NOW)
    assert vp.load_intel(cache_dir, now=NOW).loaded


@pytest.mark.parametrize(
    "cves,severity,exposed,fixable,mature,priority",
    [
        (["CVE-2021-44228"], "medium", False, True, False, "P1"),       # KEV wins regardless
        (["CVE-2023-0001"], "high", True, True, False, "P1"),           # EPSS >= 0.5 + exposed
        (["CVE-2023-0001"], "high", False, True, False, "P2"),          # EPSS >= 0.5
        (["CVE-2023-0002"], "critical", True, True, False, "P2"),       # critical + exposed
        (["CVE-2020-0003"], "critical", False, False, False, "P4"),     # low EPSS, no fix, internal
        (["CVE-2020-0003"], "critical", False, True, False, "P3"),      # has a fix → keep
        (["CVE-2020-0003"], "high", True, False, False, "P3"),          # exposed → keep
        (["CVE-2020-0003"], "critical", False, False, True, "P3"),      # mature exploit → keep
        (["CVE-2020-0003"], "high", False, None, False, "P3"),          # fix unknown never demotes
        ([], "critical", False, False, False, "P3"),                    # no CVE → never lowered
        (["CVE-2099-9999"], "critical", False, False, False, "P3"),     # CVE without EPSS → keep
        (["CVE-2023-0002"], "high", False, False, False, "P3"),         # medium EPSS
    ],
)
def test_priority_model(cache_dir, cves, severity, exposed, fixable, mature, priority):
    intel = vp.load_intel(cache_dir, now=NOW)
    block = vp.prioritize(cves, severity, intel, exposed=exposed, fixable=fixable, exploit_mature=mature)
    assert block["priority"] == priority
    assert block["kev"] == ("true" if "CVE-2021-44228" in cves else "false")


def test_priority_block_fields(cache_dir):
    intel = vp.load_intel(cache_dir, now=NOW)
    block = vp.prioritize(["CVE-2023-0001", "CVE-2021-44228"], "high", intel, exposed=False, fixable=True)
    assert block["cve"] == "CVE-2021-44228" and block["kev_ransomware"] == "Known"
    assert block["epss"] == 0.97 and block["epss_band"] == "high"


def test_policy_thresholds_are_configurable(cache_dir):
    (cache_dir / "policy.json").write_text(json.dumps({"epss_high": 0.25}))
    intel = vp.load_intel(cache_dir, now=NOW)
    assert vp.prioritize(["CVE-2023-0002"], "high", intel, exposed=False, fixable=True)["priority"] == "P2"


def test_exposure_sources(cache_dir):
    intel = vp.load_intel(cache_dir, now=NOW)
    assert vp.project_exposed("WEB/portal.example", intel)
    assert vp.project_exposed("public-api", intel)
    assert not vp.project_exposed("internal/batch", intel)
    assert vp.agent_exposed("qapaq-soc-dev-node", intel)


def test_level_mirror_matches_logtest_expectations():
    expected = (PM / "tests" / "logtest-expected.txt").read_text(encoding="utf-8").split()
    assert "101850:14" in expected and vp.snyk_level_after("critical", False, "P1") == 14
    assert "101852:13" in expected and vp.snyk_level_after("high", False, "P1") == 13
    assert "101856:11" in expected and vp.snyk_level_after("high", False, "P2") == 11
    assert "101858:6" in expected and vp.snyk_level_after("critical", False, "P4") == 6
    assert "101867:12" in expected and vp.snyk_level_after("critical", False, "P2") == 12
    assert "101733:7" in expected and vp.snyk_level_before("high", False) == 7
    assert "101734:10" in expected and vp.snyk_level_before("critical", False) == 10
    assert "101732:2" in expected and vp.snyk_level_before("low", False) == 2
    assert "101456:12" in expected and vp.snyk_level_before("critical", False, exposed=True) == 12
    assert "101730:14" in expected and vp.snyk_level_before("critical", True, exposed=True) == 14
    assert vp.snyk_level_after("critical", True, "P4") == 13  # mature is never lowered
    assert vp.vd_level_after("High", "P4", False) == 5 and vp.vd_level_after("Medium", "P1", True) == 14


def test_rule_file_ids_are_in_reserved_range():
    for name in ("qapaq_watch_platform_rules.xml", "qapaq_watch_vulnprio_rules.xml"):
        ids = [int(i) for i in re.findall(r'rule id="(\d+)"', (PM / "rules" / name).read_text(encoding="utf-8"))]
        assert ids and all(101800 <= i <= 101879 for i in ids)
        assert len(ids) == len(set(ids))


# --------------------------------------------------------------------------- Snyk inline


def snyk_event(severity="critical", problems=("CVE-2020-0003",), fixable="false", project="internal/batch", maturity=""):
    return {"qapaq": {"vendor": "snyk"}, "snyk": {"issue": {"id": "i1", "severity": severity, "problems": list(problems),
            "fixable": fixable, "exploit_maturity": maturity, "status": "open", "ignored": "false"},
            "project": {"name": project}}}


def test_snyk_inline_enrichment(cache_dir):
    snyk = load_snyk()
    events = [snyk_event(), snyk_event(problems=("CVE-2021-44228",)), snyk_event(project="web/portal.example", problems=("CVE-2023-0001",))]
    assert snyk.enrich_events(events, {"vulnprio_dir": str(cache_dir)}) == 3
    assert [e["qapaq"]["vuln"]["priority"] for e in events] == ["P4", "P1", "P1"]
    assert events[0]["qapaq"]["vuln"]["source"] == "inline"


def test_snyk_inline_fail_safe_without_cache(tmp_path):
    snyk = load_snyk()
    events = [snyk_event()]
    assert snyk.enrich_events(events, {"vulnprio_dir": str(tmp_path / "missing")}) == 0
    assert "vuln" not in events[0]["qapaq"]
    assert snyk.enrich_events(events, {}) == 0


# --------------------------------------------------------------------------- feeds


class FakeGetter:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __call__(self, url, timeout=60):
        self.calls.append(url)
        return self.responses[url]


def feed_config(tmp_path):
    return {"cache_dir": str(tmp_path / "cache"), "kev_url": "https://kev.example/kev.json",
            "epss_url": "https://epss.example/current.csv.gz", "refresh_hours": 24}


def test_refresh_downloads_follows_redirect_and_caches(tmp_path):
    config = feed_config(tmp_path)
    getter = FakeGetter({
        "https://kev.example/kev.json": HttpResult(200, kev_json(count_pad=150)),
        "https://epss.example/current.csv.gz": HttpResult(302, b"", {"Location": "https://cdn.example/e.csv.gz"}),
        "https://cdn.example/e.csv.gz": HttpResult(200, epss_csv(extra=10001)),
    })
    result = job.refresh_feeds(config, NOW, getter)
    assert result["refreshed"] and result["kev"] == 151 and result["epss"] >= 10001
    again = job.refresh_feeds(config, NOW, getter)
    assert again["refreshed"] is False and len(getter.calls) == 3


def test_refresh_rejects_truncated_feeds_and_keeps_cache(tmp_path, cache_dir):
    config = feed_config(tmp_path)
    config["cache_dir"] = str(cache_dir)
    before = (cache_dir / "kev.json").read_bytes()
    getter = FakeGetter({"https://kev.example/kev.json": HttpResult(200, kev_json())})
    with pytest.raises(ProviderError):
        job.refresh_feeds(config, NOW, getter, force=True)
    assert (cache_dir / "kev.json").read_bytes() == before
    getter = FakeGetter({"https://kev.example/kev.json": HttpResult(503, b"")})
    with pytest.raises(ProviderError):
        job.refresh_feeds(config, NOW, getter, force=True)


def test_redirect_must_stay_https():
    getter = FakeGetter({"https://a.example/": HttpResult(301, b"", {"Location": "http://b.example/"})})
    with pytest.raises(ProviderError):
        job.fetch("https://a.example/", getter)


# --------------------------------------------------------------------------- prioritizer job


def write_snyk_jsonl(path: pathlib.Path):
    lines = [
        {"qapaq": {"vendor": "snyk", "event_type": "issue"}, "snyk": {"issue": {"id": "a", "status": "open", "ignored": "false",
         "severity": "critical", "problems": ["CVE-2020-0003"], "fixable": "false", "updated_at": "2026-11-01T00:00:00Z"},
         "project": {"name": "internal/batch"}}},
        {"qapaq": {"vendor": "snyk", "event_type": "issue", "vuln": {"priority": "P3"}}, "snyk": {"issue": {"id": "b", "status": "open",
         "ignored": "false", "severity": "high", "problems": ["CVE-2021-44228"], "fixable": "true",
         "updated_at": "2026-11-01T00:00:00Z"}, "project": {"name": "internal/batch"}}},
        {"qapaq": {"vendor": "snyk", "event_type": "issue"}, "snyk": {"issue": {"id": "c", "status": "open", "ignored": "false",
         "severity": "high", "problems": [], "updated_at": "2026-11-01T00:00:00Z"}, "project": {"name": "x"}}},
        # later update resolves c
        {"qapaq": {"vendor": "snyk", "event_type": "issue"}, "snyk": {"issue": {"id": "c", "status": "resolved", "ignored": "false",
         "severity": "high", "problems": [], "updated_at": "2026-11-05T00:00:00Z"}, "project": {"name": "x"}}},
        {"qapaq": {"vendor": "snyk", "event_type": "canary", "canary": {"id": "x"}}},
        "not json",
    ]
    path.write_text("\n".join(l if isinstance(l, str) else json.dumps(l) for l in lines) + "\n")


class FakeIndexer:
    def __init__(self, hits):
        self.hits = hits
        self.calls = 0

    def search(self, index, body):
        assert index == "wazuh-states-vulnerabilities-*"
        self.calls += 1
        page = self.hits if self.calls == 1 else []
        return {"hits": {"hits": page}}


def vd_hit(agent, cve, severity, n=0):
    return {"_source": {"agent": {"id": "001", "name": agent}, "package": {"name": f"pkg{n}", "version": "1"},
                        "vulnerability": {"id": cve, "severity": severity}}, "sort": [agent, cve, n]}


def test_snyk_findings_latest_open_only(tmp_path):
    path = tmp_path / "snyk-issues.jsonl"
    write_snyk_jsonl(path)
    findings = job.snyk_findings([path.with_name("missing.1"), path])
    assert sorted(f["id"] for f in findings) == ["a", "b"]
    assert {f["id"]: f["inline_priority"] for f in findings}["b"] == "P3"


def test_run_end_to_end(tmp_path, cache_dir):
    snyk_path = tmp_path / "snyk-issues.jsonl"
    write_snyk_jsonl(snyk_path)
    config = {"cache_dir": str(cache_dir), "state_file": str(tmp_path / "state.json"), "output_file": str(tmp_path / "out.jsonl"),
              "snyk_jsonl": str(snyk_path), "refresh_hours": 24,
              "exposure": {"cdb_list": "qapaq-internet-facing-projects", "agents": ["qapaq-soc-dev-node"]}}
    indexer = FakeIndexer([
        vd_hit("qapaq-soc-dev-node", "CVE-2021-44228", "Critical", 1),   # KEV + exposed → P1
        vd_hit("internal-node", "CVE-2020-0003", "High", 2),           # low EPSS, fix UNKNOWN → stays P3
        vd_hit("internal-node", "CVE-2023-0002", "High", 3),           # P3
        vd_hit("qapaq-soc-dev-node", "CVE-2020-0004", "High", 4),        # exposed host → never P4
    ])
    result = job.cmd_run(config, NOW, indexer=indexer, getter=None, list_reader=lambda c, n: ["web/portal.example", "x.invalid"],
                         do_sync=False)
    report = result["report"]
    # Snyk a: critical, explicit no-fix, low EPSS, internal → P4 (10 → 6); b: high in KEV → P1 (7 → 13)
    assert report["snyk"]["before"]["high_or_critical"] == 1 and report["snyk"]["after"]["high_or_critical"] == 1
    assert report["snyk"]["priority"] == {"P1": 1, "P4": 1} and report["snyk"]["raised"] == 1
    # VD: fix status unknown → nothing demoted; KEV still raises
    assert report["wazuh-vd"]["before"]["high_or_critical"] == 4 and report["wazuh-vd"]["after"]["high_or_critical"] == 4
    assert report["wazuh-vd"]["priority"].get("P4", 0) == 0
    events = [json.loads(l) for l in (tmp_path / "out.jsonl").read_text(encoding="utf-8").splitlines()]
    findings = [e for e in events if e["qapaq"]["event_type"] == "finding"]
    # P1 Snyk issue b (inline P3 → P1) and the VD P1; P4/P3 are not emitted one by one
    assert sorted(e["qapaq"]["vuln"]["finding_id"].split("|")[0] for e in findings) == ["001", "b"]
    assert any(e["qapaq"]["event_type"] == "summary" for e in events)
    exposure = json.loads((cache_dir / "exposure.json").read_text(encoding="utf-8"))
    assert exposure["snyk_projects"] == ["web/portal.example"]
    # second run: no change → no new findings, no new summary
    indexer.calls = 0
    again = job.cmd_run(config, NOW, indexer=indexer, getter=None, list_reader=lambda c, n: [], do_sync=False)
    assert again["events"] == 0


def test_cdb_lists_never_demote_on_unknown_fix(cache_dir):
    intel = vp.load_intel(cache_dir, now=NOW)
    findings = job.evaluate([
        {"kind": "wazuh-vd", "id": "1", "asset": "internal", "cves": ["CVE-2020-0003"], "severity": "High", "fixable": None,
         "mature": False, "package": "", "package_version": "", "title": ""},
        {"kind": "wazuh-vd", "id": "2", "asset": "internal", "cves": ["CVE-2020-0004"], "severity": "High", "fixable": None,
         "mature": False, "package": "", "package_version": "", "title": ""},
        {"kind": "wazuh-vd", "id": "3", "asset": "qapaq-soc-dev-node", "cves": ["CVE-2020-0004"], "severity": "High",
         "fixable": None, "mature": False, "package": "", "package_version": "", "title": ""},
    ], intel)
    lists = job.cdb_lists(findings, intel)
    assert lists["qapaq-vuln-noise"].startswith("CVE-0000-0000.invalid")  # fix unknown → never noise
    assert lists["qapaq-vuln-kev"] == "CVE-2021-44228:kev\n"
