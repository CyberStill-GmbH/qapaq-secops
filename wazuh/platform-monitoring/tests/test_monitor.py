"""Platform health monitor: checks, state machine (transitions, re-notify, recovery) and snapshots."""

from __future__ import annotations

import json
import shutil
import subprocess
from datetime import timedelta

import pytest

import qapaq_platform_monitor as mon
from qapaq_platform_common import ProviderError, iso
from conftest import NOW


def units(states):
    return lambda name: states.get(name, {"LoadState": "loaded", "Result": "success", "ActiveState": "active"})


def collector_config(tmp_path, last_success):
    state = tmp_path / "snyk.json"
    if last_success is not None:
        state.write_text(json.dumps({"last_success": iso(last_success)}))
    return {"collectors": {"snyk": {"unit": "qapaq-collector-snyk", "state_file": str(state), "interval_minutes": 15,
                                    "fail_after_intervals": 3}}}


def test_collector_ok_and_heartbeat(tmp_path):
    findings, beats = mon.check_collectors(collector_config(tmp_path, NOW - timedelta(minutes=10)), NOW, units({}))
    assert [f.problem for f in findings] == [False]
    assert beats["snyk"] == NOW - timedelta(minutes=10)


def test_collector_stale_failed_and_timer_off(tmp_path):
    config = collector_config(tmp_path, NOW - timedelta(minutes=50))
    findings, _ = mon.check_collectors(config, NOW, units({
        "qapaq-collector-snyk.service": {"LoadState": "loaded", "Result": "exit-code", "ExecMainStatus": "1"},
        "qapaq-collector-snyk.timer": {"ActiveState": "inactive"},
    }))
    (finding,) = findings
    assert finding.problem and finding.check == "collector_failing" and finding.severity == "warning"
    assert "exit-code" in finding.summary and "timer inactive" in finding.summary


def test_collector_never_succeeded_is_critical(tmp_path):
    (finding,), _ = mon.check_collectors(collector_config(tmp_path, None), NOW, units({}))
    assert finding.problem and finding.severity == "critical"


def test_collector_not_installed(tmp_path):
    (finding,), _ = mon.check_collectors(collector_config(tmp_path, NOW), NOW,
                                         units({"qapaq-collector-snyk.service": {"LoadState": "not-found"}}))
    assert finding.problem and "no está instalado" in finding.summary


SOURCES = {"sources": {
    "cloudflare": {"mode": "events", "max_silence_minutes": 30, "query": {"term": {"rule.groups": "cloudflare"}}},
    "snyk": {"mode": "heartbeat", "heartbeat": {"collector": "snyk"}, "max_silence_minutes": 45, "event_window_hours": 168,
             "query": {"term": {"rule.groups": "snyk"}}},
    "aws": {"mode": "heartbeat", "heartbeat": {"container": "qapaq-aws-events-1"}, "max_silence_minutes": 15,
            "event_window_hours": 72, "query": {}},
    "office365": {"enabled": False, "query": {}},
}}


def test_sources_events_and_heartbeat_logic():
    last = {"cloudflare": NOW - timedelta(minutes=45), "snyk": NOW - timedelta(days=3), "aws": None}
    beats = {"snyk": NOW - timedelta(minutes=5)}
    containers = {"qapaq-aws-events-1": {"running": True, "health": "healthy"}}
    found = {f.source: f for f in mon.check_sources(SOURCES, NOW, last, beats, containers)}
    assert found["cloudflare"].problem and "silenciosa" in found["cloudflare"].summary
    assert not found["snyk"].problem          # quiet for 3 days but the collector beats; window is 7 d
    assert found["aws"].problem and found["aws"].severity == "warning"  # alive but no events in 72 h
    assert "office365" not in found


def test_heartbeat_dead_is_critical():
    found = {f.source: f for f in mon.check_sources(SOURCES, NOW, {"snyk": NOW}, {"snyk": NOW - timedelta(hours=2)},
                                                     {"qapaq-aws-events-1": {"running": False, "health": "unhealthy"}})}
    assert found["snyk"].problem and found["snyk"].severity == "critical"
    assert found["aws"].problem and "sin latido" in found["aws"].summary


def test_wazuh_agent_alert_quiet_is_not_source_silence_when_manager_is_alive():
    config = {"sources": {
        "wazuh-agents": {
            "mode": "heartbeat",
            "heartbeat": {"container": "qapaq-wazuh.manager-1"},
            "max_silence_minutes": 15,
            "event_window_hours": 0,
        },
    }}
    found, = mon.check_sources(
        config,
        NOW,
        {"wazuh-agents": NOW - timedelta(minutes=114)},
        {},
        {"qapaq-wazuh.manager-1": {"running": True, "health": "healthy"}},
    )
    assert not found.problem
    assert "con latido" in found.summary

    # A quiet alert stream with a live Manager must also close a stale finding
    # created by the previous event-volume policy.
    stale_key = found.key
    stale_state = {"problems": {stale_key: {
        "since": iso(NOW - timedelta(hours=2)),
        "notified": iso(NOW - timedelta(hours=1)),
        "check": "source_silent",
        "severity": "warning",
    }}}
    events, reconciled = mon.reconcile([found], stale_state, NOW, 6)
    assert len(events) == 1
    assert events[0]["qapaq"]["health"]["status"] == "ok"
    assert stale_key not in reconciled["problems"]


def test_event_query_has_one_filter_per_source():
    query = mon.source_event_query({k: v for k, v in SOURCES["sources"].items() if v.get("enabled") is not False}, NOW)
    assert set(query["aggs"]) == {"cloudflare", "snyk", "aws"} and query["size"] == 0


def test_reconcile_transitions_renotify_and_recovery():
    problem = mon.Finding("source_silent", "snyk", True, "silencio", "warning")
    events, state = mon.reconcile([problem], {}, NOW, 6)
    assert len(events) == 1 and events[0]["qapaq"]["health"]["status"] == "problem"
    events, state = mon.reconcile([problem], state, NOW + timedelta(hours=1), 6)
    assert events == []
    worse = mon.Finding("source_silent", "snyk", True, "silencio largo", "critical")
    events, state = mon.reconcile([worse], state, NOW + timedelta(hours=2), 6)
    assert events[0]["qapaq"]["health"]["renotify"] == "true" and events[0]["qapaq"]["health"]["severity"] == "critical"
    events, state = mon.reconcile([worse], state, NOW + timedelta(hours=9), 6)
    assert len(events) == 1
    ok = mon.Finding("source_silent", "snyk", False, "con eventos")
    events, state = mon.reconcile([ok], state, NOW + timedelta(hours=10), 6)
    assert events[0]["qapaq"]["health"]["status"] == "ok" and events[0]["qapaq"]["health"]["summary"].startswith("Recuperado")
    assert state["problems"] == {}


def test_reconcile_keeps_problems_of_checks_that_did_not_run():
    state = {"problems": {"agent_disconnected:wazuh:agent-002": {"since": iso(NOW), "notified": iso(NOW), "check": "agent_disconnected"}}}
    _, new = mon.reconcile([mon.Finding("host_disk", "host", False)], state, NOW, 6)
    assert "agent_disconnected:wazuh:agent-002" in new["problems"]
    _, new = mon.reconcile([mon.Finding("agent_disconnected", "wazuh", False, component="agent-001")], state, NOW, 6)
    assert new["problems"] == {}


def test_health_event_contract():
    event = mon.health_event(mon.Finding("host_disk", "host", True, "Disco / al 90%", "warning", "/", value=90.0, unit="%"),
                             NOW, "problem")
    qapaq = event["qapaq"]
    assert qapaq["vendor"] == "qapaq-platform" and qapaq["event_type"] == "health"
    assert qapaq["health"] == {"check": "host_disk", "status": "problem", "severity": "warning", "source": "host",
                             "key": "host_disk:host:/", "summary": "Disco / al 90%", "component": "/", "value": 90.0, "unit": "%"}


def test_snapshots_hourly_per_source():
    findings = [mon.Finding("source_silent", "snyk", False, "ok", last_seen="2026-11-09T10:00:00Z"),
                mon.Finding("collector_failing", "cloudflare", True, "falla")]
    events, state = mon.source_snapshots(findings, SOURCES, {}, NOW)
    by = {e["qapaq"]["health"]["source"]: e["qapaq"]["health"] for e in events}
    assert by["snyk"]["source_state"] == "ok" and by["snyk"]["last_seen"] == "2026-11-09T10:00:00Z"
    assert by["cloudflare"]["source_state"] == "failing" and by["office365"]["source_state"] == "disabled"
    assert all(h["check"] == "source_status" for h in by.values())
    again, _ = mon.source_snapshots(findings, SOURCES, state, NOW + timedelta(minutes=30))
    assert again == []


def test_containers():
    containers = {
        "qapaq-wazuh.manager-1": {"state": "running", "running": True, "health": "none", "status": "Up 5 days"},
        "qapaq-api-1": {"state": "running", "running": True, "health": "unhealthy", "status": "Up (unhealthy)"},
        "qapaq-migrator-run-1": {"state": "exited", "running": False, "health": "none", "status": "Exited (0)"},
        "qapaq-shuffle-orborus-1": {"state": "restarting", "running": False, "health": "none", "status": "Restarting (1)"},
    }
    config = {"containers": {"required": ["qapaq-wazuh.manager-1", "qapaq-api-1", "qapaq-edge-1"],
                             "optional": ["qapaq-shuffle-orborus-1"]}}
    found = {f.component: f for f in mon.check_containers(config, containers)}
    assert not found["qapaq-wazuh.manager-1"].problem
    assert found["qapaq-api-1"].problem and found["qapaq-api-1"].severity == "critical"
    assert found["qapaq-edge-1"].problem and "no existe" in found["qapaq-edge-1"].summary
    assert "qapaq-migrator-run-1" not in found
    assert found["qapaq-shuffle-orborus-1"].problem and found["qapaq-shuffle-orborus-1"].severity == "warning"


class FakeApi:
    def get(self, path):
        assert path.startswith("/agents")
        return {"data": {"affected_items": [
            {"id": "000", "name": "manager", "status": "active"},
            {"id": "001", "name": "qapaq-soc-dev-node", "status": "active", "lastKeepAlive": iso(NOW)},
            {"id": "002", "name": "srv02", "status": "disconnected", "lastKeepAlive": iso(NOW - timedelta(hours=1))},
            {"id": "003", "name": "srv03", "status": "never_connected"},
        ]}}


def test_agents():
    found = {f.component: f for f in mon.check_agents({"agents": {"max_disconnected_minutes": 15}}, FakeApi(), NOW)}
    assert set(found) == {"agent-001", "agent-002"}
    assert found["agent-002"].problem and found["agent-002"].fields["agent_name"] == "srv02"
    assert not found["agent-001"].problem


class FakeIndexer:
    def __init__(self, status="yellow", pct="91", blocked=False, ism_fail=False, ism_404=False):
        self.status, self.pct, self.blocked, self.ism_fail, self.ism_404 = status, pct, blocked, ism_fail, ism_404

    def get(self, path):
        if path.startswith("/_cluster/health"):
            return {"status": self.status, "unassigned_shards": 6}
        if path.startswith("/_cat/allocation"):
            return [{"node": "wazuh.indexer", "disk.percent": self.pct}, {"node": "UNASSIGNED", "disk.percent": None}]
        if "_settings" in path:
            return {"wazuh-alerts-4.x-2026.11.09": {"settings": {"index.blocks.read_only_allow_delete": "true" if self.blocked else "false"}}}
        if "_ism/explain" in path:
            if self.ism_404:
                raise ProviderError("x", 404)
            return {"total_managed_indices": 1, "wazuh-alerts-4.x-2026.11.01": {"action": {"failed": self.ism_fail}, "info": {}}}
        raise AssertionError(path)

    def search(self, index, body):
        return {"aggregations": {name: {"last": {"value": (NOW - timedelta(minutes=3)).timestamp() * 1000}}
                                 for name in body.get("aggs", {})}}


def test_indexer_checks():
    found = {(f.check, f.component): f for f in mon.check_indexer({}, FakeIndexer(blocked=True, ism_fail=True))}
    assert found[("indexer_cluster", "cluster")].problem and found[("indexer_cluster", "cluster")].severity == "warning"
    assert found[("indexer_disk", "wazuh.indexer")].severity == "critical"
    assert found[("indexer_disk", "read-only-blocks")].problem
    assert found[("ism_error", "ism")].problem
    healthy = {(f.check, f.component): f for f in mon.check_indexer({}, FakeIndexer("green", "60", ism_404=True))}
    assert not any(f.problem for f in healthy.values())
    assert mon.check_indexer({}, FakeIndexer("red"))[0].severity == "critical"


def test_ingestion_lag():
    rows = [["wazuh-indexer", "wazuh-alerts", "2026-11-09 11:58:00+00", "success", "2026-11-09 11:50:00+00", "2026-11-09 11:58:00+00"]]
    (ok,) = mon.check_ingestion({}, NOW, NOW - timedelta(minutes=2), lambda *a: rows)
    assert not ok.problem
    (late,) = mon.check_ingestion({}, NOW, NOW - timedelta(minutes=2), lambda *a: [
        ["wazuh-indexer", "wazuh-alerts", "2026-11-09 11:00:00+00", "retryable_error", "2026-11-09 10:00:00+00", "2026-11-09 11:00:00+00"]])
    assert late.problem and "retryable_error" in late.summary and "detrás" in late.summary
    (none,) = mon.check_ingestion({}, NOW, None, lambda *a: [])
    assert none.problem and none.severity == "critical"


def test_host_checks(tmp_path):
    proc = tmp_path / "proc"
    proc.mkdir()
    (proc / "meminfo").write_text("MemTotal:       1000 kB\nMemAvailable:     20 kB\n")
    (proc / "loadavg").write_text("0.1 0.2 0.3 1/100 1\n")
    found = {f.check: f for f in mon.check_host({"host": {"disk_paths": [str(tmp_path)], "disk_warn_pct": 0.0001}}, str(proc))}
    assert found["host_disk"].problem
    assert found["host_memory"].problem and found["host_memory"].fields["value"] == 98.0
    assert not found["host_load"].problem


@pytest.mark.skipif(not shutil.which("openssl"), reason="openssl no disponible")
def test_certificate_expiry(tmp_path):
    cert = tmp_path / "c.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(tmp_path / "k.pem"),
                    "-out", str(cert), "-days", "5", "-subj", "/CN=test.example"], check=True, capture_output=True)
    found = mon.check_certificates({"certificates": {"files": [{"name": "edge", "path": str(cert)},
                                                              {"name": "gone", "path": str(tmp_path / "x.pem"), "required": False}]}},
                                   mon.utc_now())
    assert len(found) == 1 and found[0].problem and found[0].severity == "critical"


def test_vuln_intel_freshness(cache_dir):
    (f,) = mon.check_vuln_intel({"vulnprio": {"cache_dir": str(cache_dir), "max_age_hours": 48}}, NOW)
    assert not f.problem
    (f,) = mon.check_vuln_intel({"vulnprio": {"cache_dir": str(cache_dir), "max_age_hours": 1}}, NOW)
    assert f.problem


def test_canary_verdicts(tmp_path):
    path = tmp_path / "canary.json"
    path.write_text(json.dumps({"verdicts": {
        "snyk": {"result": "ok", "verified_at": iso(NOW)},
        "aws": {"result": "missing", "stage": "wazuh", "detail": "no llegó", "verified_at": iso(NOW)},
        "cloudflare": {"result": "ok", "verified_at": iso(NOW - timedelta(days=3))}}}))
    found = {f.source: f for f in mon.check_canaries({"canary": {"state_file": str(path)}}, NOW)}
    assert not found["snyk"].problem and found["aws"].problem and found["cloudflare"].problem


def test_run_once_dry_run_survives_failing_checks(tmp_path, monkeypatch):
    monkeypatch.setattr(mon, "container_states", lambda: {})

    class BrokenApi:
        def get(self, path):
            raise ProviderError("Wazuh API authentication failed", 401)

    config = {"state_file": str(tmp_path / "state.json"), "output_file": str(tmp_path / "out.jsonl"),
              "sources": {"snyk": SOURCES["sources"]["snyk"]}, "host": {"disk_paths": [str(tmp_path)]},
              "disabled_checks": ["ingestion", "edge", "sns"]}
    result = mon.run_once(config, NOW, indexer=FakeIndexer("green", "50"), api=BrokenApi(), dry_run=True)
    keys = result["open_problems"]
    assert "monitor_error:monitor:agents" in keys
    assert not (tmp_path / "out.jsonl").exists()
    real = mon.run_once(config, NOW, indexer=FakeIndexer("green", "50"), api=BrokenApi())
    lines = (tmp_path / "out.jsonl").read_text(encoding="utf-8").splitlines()
    assert real["events"] == len(lines) > 0
    assert all(json.loads(l)["qapaq"]["vendor"] == "qapaq-platform" for l in lines)
