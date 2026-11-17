"""Synthetic canaries: inject per pipeline, verify Wazuh + QAPAQ stages, deadline and monitor watchdog."""

from __future__ import annotations

import json
from datetime import timedelta

import qapaq_canary as canary
from qapaq_platform_common import iso
from conftest import NOW


def config(tmp_path, **extra):
    out = tmp_path / "logs"
    out.mkdir(exist_ok=True)
    base = {
        "state_file": str(tmp_path / "canary.json"), "deadline_minutes": 30, "check_qapaq": True,
        "pipelines": {
            "snyk": {"vendor": "snyk", "source": "issues", "file": str(out / "snyk-issues.jsonl"), "unit": "qapaq-collector-snyk"},
            "aws": {"vendor": "aws", "source": "eventbridge", "file": str(out / "aws" / "aws-events.jsonl")},
            "agent": {"type": "journald"},
            "off": {"vendor": "x", "file": str(out / "x.jsonl"), "enabled": False},
        },
    }
    base.update(extra)
    return base


def idle(name):
    return {"ActiveState": "inactive"}


def test_inject_writes_labelled_canaries(tmp_path):
    calls = []
    cfg = config(tmp_path)
    result = canary.inject(cfg, NOW, unit_reader=idle, runner=lambda argv: (calls.append(argv), (0, ""))[1])
    assert result["snyk"].startswith("qapaq-canary-snyk-20261109T120000Z-")
    assert result["aws"].startswith("error:")          # aws/ directory is missing → recorded, verified as missing
    assert calls and calls[0][:3] == ["logger", "-t", "qapaq-canary"] and result["agent"] in calls[0][-1]
    line = json.loads((tmp_path / "logs" / "snyk-issues.jsonl").read_text(encoding="utf-8"))
    assert line["qapaq"]["vendor"] == "snyk" and line["qapaq"]["event_type"] == "canary"
    assert line["qapaq"]["canary"]["label"].startswith("sintético/canary")
    state = json.loads((tmp_path / "canary.json").read_text(encoding="utf-8"))
    assert set(state["inflight"]) == {"snyk", "aws", "agent"}


def test_inject_waits_for_busy_collector(tmp_path, monkeypatch):
    monkeypatch.setattr(canary.time, "sleep", lambda s: None)
    cfg = config(tmp_path)
    cfg["_only"] = ["snyk"]
    result = canary.inject(cfg, NOW, unit_reader=lambda n: {"ActiveState": "activating"})
    assert result["snyk"] == "error: collector busy"
    assert not (tmp_path / "logs" / "snyk-issues.jsonl").exists()


class Indexer:
    def __init__(self, found):
        self.found = found

    def search(self, index, body):
        canary_id = body["query"]["bool"]["should"][0]["term"]["data.qapaq.canary.id"]
        hit = self.found.get(canary_id)
        return {"hits": {"hits": [{"_source": hit}] if hit else []}}


def seed(tmp_path, pending):
    (tmp_path / "canary.json").write_text(json.dumps({"inflight": pending}))


def test_verify_ok_missing_and_pending(tmp_path):
    t0 = NOW - timedelta(minutes=40)
    seed(tmp_path, {
        "snyk": {"id": "c-snyk", "injected_at": iso(t0)},
        "aws": {"id": "c-aws", "injected_at": iso(t0)},
        "cloudflare": {"id": "c-cf", "injected_at": iso(NOW - timedelta(minutes=5))},
        "bitdefender": {"id": "c-bd", "injected_at": iso(t0)},
        "agent": {"id": "c-ag", "injected_at": iso(t0), "inject_error": "logger failed"},
    })
    found = {"c-snyk": {"timestamp": iso(t0 + timedelta(seconds=40)).replace("Z", "+0000"), "rule": {"id": "101831"}},
             "c-bd": {"timestamp": iso(t0 + timedelta(seconds=20)), "rule": {"id": "101830"}}}
    qapaq_newest = [[iso(t0 + timedelta(seconds=30))]]   # QAPAQ read up to t0+30 s: snyk (t0+40 s) not yet
    result = canary.verify(config(tmp_path), NOW, indexer=Indexer(found), rows_reader=lambda *a: qapaq_newest)
    v = result["verdicts"]
    assert v["bitdefender"]["result"] == "ok" and "101830" in v["bitdefender"]["detail"]
    assert v["snyk"]["result"] == "missing" and v["snyk"]["stage"] == "qapaq"
    assert v["aws"]["result"] == "missing" and v["aws"]["stage"] == "wazuh"
    assert v["agent"]["stage"] == "inject"
    assert result["pending"] == ["cloudflare"]


def test_verify_without_qapaq_stage(tmp_path):
    t0 = NOW - timedelta(minutes=2)
    seed(tmp_path, {"snyk": {"id": "c1", "injected_at": iso(t0)}})
    found = {"c1": {"timestamp": iso(t0 + timedelta(seconds=10)), "rule": {"id": "101831"}}}
    result = canary.verify(config(tmp_path, check_qapaq=False), NOW, indexer=Indexer(found), rows_reader=None)
    assert result["verdicts"]["snyk"]["result"] == "ok" and result["verdicts"]["snyk"]["stage"] == "wazuh"


def test_monitor_watchdog(tmp_path):
    out = tmp_path / "health.jsonl"
    state = tmp_path / "monitor.json"
    watch = {"monitor_watch": {"state_file": str(state), "stale_minutes": 30, "output_file": str(out)}}
    state.write_text(json.dumps({"last_run": iso(NOW - timedelta(minutes=5))}))
    assert canary.watch_monitor(watch, NOW) and not out.exists()
    state.write_text(json.dumps({"last_run": iso(NOW - timedelta(hours=2))}))
    assert not canary.watch_monitor(watch, NOW)
    event = json.loads(out.read_text(encoding="utf-8"))
    assert event["qapaq"]["health"]["check"] == "monitor_error" and event["qapaq"]["health"]["severity"] == "critical"
    assert not canary.watch_monitor(watch, NOW) and len(out.read_text(encoding="utf-8").splitlines()) == 1  # no repeat
    state.write_text(json.dumps({"last_run": iso(NOW)}))
    assert canary.watch_monitor(watch, NOW)
    recovered = json.loads(out.read_text(encoding="utf-8").splitlines()[-1])
    assert recovered["qapaq"]["health"]["status"] == "ok"


def test_linux_servers_journald_lets_only_the_canary_tag_through():
    """El grupo linux-servers filtra journald por _COMM; el canario «agent» entra por su propio bloque."""
    import re
    from pathlib import Path

    conf = Path(__file__).resolve().parents[2] / "manager" / "policy" / "shared" / "linux-servers" / "agent.conf"
    text = conf.read_text(encoding="utf-8")
    comm = re.search(r'<filter field="_COMM">([^<]+)</filter>', text)
    assert comm and re.search(comm.group(1), "sshd")
    assert not re.search(comm.group(1), "logger"), "no abrir journald a cualquier logger del host"
    tag = re.search(r'<filter field="SYSLOG_IDENTIFIER">([^<]+)</filter>', text)
    assert tag and re.fullmatch(tag.group(1).strip("^$"), "qapaq-canary")
