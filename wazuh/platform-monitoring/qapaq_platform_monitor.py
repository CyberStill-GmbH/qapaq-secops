#!/usr/bin/env python3
"""QAPAQ platform health monitor: source silence, collectors, agents, containers, indexer, certs, host.

Runs every 5 min (systemd timer ``qapaq-platform-monitor.timer``) and appends health events to the
manager logs volume (``qapaq-collectors/platform-health.jsonl``). Rules 101800-101829
(``rules/qapaq_watch_platform_rules.xml``) turn them into QAPAQ alerts. docs/20.

Event contract (``qapaq.vendor = "qapaq-platform"``, ``qapaq.event_type = "health"``)::

    qapaq.health.check     source_silent | collector_failing | agent_disconnected | container_unhealthy |
                         indexer_cluster | indexer_disk | ism_error | cert_expiry | ingestion_lag |
                         host_disk | host_memory | host_load | edge_unreachable | vuln_intel_stale |
                         canary_missing | sns_subscription | monitor_error | source_status
    qapaq.health.status    problem | ok            (ok = recovered, or the hourly source_status snapshot)
    qapaq.health.severity  info | warning | critical
    qapaq.health.source    snyk | cloudflare | bitdefender | aws | office365 | wazuh | qapaq | host | edge | ...
    qapaq.health.component collector / container / agent / certificate name (optional)
    qapaq.health.key       stable id "<check>:<source>[:<component>]" (dedupe / correlation)
    qapaq.health.summary   Spanish one-liner for the analyst
    qapaq.health.value / threshold / unit / last_seen / since / renotify   (optional)

Only state changes are emitted (problem → ok), plus a re-notification of an open problem every
``renotify_hours`` and one ``source_status`` snapshot per source every ``snapshot_minutes``.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import shutil
import sys
import time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from qapaq_platform_common import (  # noqa: E402
    Indexer,
    ProviderError,
    WazuhApi,
    cert_not_after,
    docker_json,
    emit,
    https_get,
    iso,
    load_config,
    parse_iso,
    psql_rows,
    read_state,
    save_state,
    systemd_unit,
    utc_now,
)

SEVERITY_RANK = {"info": 0, "warning": 1, "critical": 2}


class Finding:
    """One evaluated condition. ``problem=False`` means healthy (used to close open problems)."""

    def __init__(self, check: str, source: str, problem: bool, summary: str = "", severity: str = "warning",
                 component: str = "", **fields) -> None:
        self.check = check
        self.source = source
        self.problem = problem
        self.summary = summary
        self.severity = severity
        self.component = component
        self.fields = {k: v for k, v in fields.items() if v is not None}

    @property
    def key(self) -> str:
        return ":".join(part for part in (self.check, self.source, self.component) if part)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Finding({self.key}, problem={self.problem}, {self.severity})"


def minutes_since(value: datetime | None, now: datetime) -> float | None:
    return None if value is None else (now - value).total_seconds() / 60


def _parse(value) -> datetime | None:
    if not value:
        return None
    try:
        return parse_iso(str(value))
    except ValueError:
        return None


def _fmt_age(minutes: float | None) -> str:
    if minutes is None:
        return "nunca"
    if minutes < 120:
        return f"{int(minutes)} min"
    if minutes < 2880:
        return f"{minutes / 60:.1f} h"
    return f"{minutes / 1440:.1f} d"


# --------------------------------------------------------------------------- checks


def check_collectors(config: dict, now: datetime, unit_reader=systemd_unit) -> tuple[list[Finding], dict]:
    """Collector heartbeat = ``last_success`` in its state file; failure = unit result != success."""
    findings, heartbeats = [], {}
    for name, spec in (config.get("collectors") or {}).items():
        if spec.get("enabled") is False:
            continue
        state_path = pathlib.Path(spec["state_file"])
        interval = float(spec.get("interval_minutes", 15))
        fail_after = float(spec.get("fail_after_intervals", 3))
        unit = spec.get("unit")
        last_success = None
        if state_path.is_file():
            try:
                last_success = _parse(json.loads(state_path.read_text(encoding="utf-8")).get(spec.get("success_field", "last_success")))
            except (OSError, ValueError):
                last_success = None
        heartbeats[name] = last_success
        unit_info = unit_reader(f"{unit}.service") if unit else {}
        if unit and unit_info.get("LoadState") == "not-found":
            if spec.get("required", True):
                findings.append(Finding("collector_failing", name, True, f"QAPAQ: el collector {name} no está instalado ({unit}).",
                                        "warning", unit, unit=unit))
            continue
        age = minutes_since(last_success, now)
        result = unit_info.get("Result", "")
        failed_run = result not in ("", "success")
        stale = age is None or age > interval * fail_after
        timer_state = unit_reader(f"{unit}.timer").get("ActiveState", "") if unit else ""
        timer_off = bool(unit) and timer_state not in ("", "active")
        problem = stale or failed_run or timer_off
        if problem:
            why = []
            if stale:
                why.append(f"último éxito hace {_fmt_age(age)} (esperado cada {int(interval)} min)")
            if failed_run:
                why.append(f"última ejecución: {result} (código {unit_info.get('ExecMainStatus', '?')})")
            if timer_off:
                why.append(f"timer {timer_state or 'inactivo'}")
            summary = f"Colector {name} fallando: " + "; ".join(why) + "."
        else:
            summary = f"Colector {name} operativo (último éxito hace {_fmt_age(age)})."
        findings.append(Finding(
            "collector_failing", name, problem, summary,
            "critical" if (age is not None and age > interval * fail_after * 4) or age is None else "warning",
            unit or "", last_seen=iso(last_success) if last_success else None,
            value=round(age, 1) if age is not None else None, threshold=interval * fail_after, unit="min",
        ))
    return findings, heartbeats


def source_event_query(sources: dict, now: datetime) -> dict:
    longest = max((float(s.get("event_window_hours") or s.get("max_silence_minutes", 60) / 60) for s in sources.values()), default=24)
    aggs = {
        name: {"filter": spec["query"], "aggs": {"last": {"max": {"field": "timestamp"}}}}
        for name, spec in sources.items()
    }
    return {
        "size": 0,
        "track_total_hits": False,
        "query": {"range": {"timestamp": {"gte": iso(now - timedelta(hours=max(longest, 1) + 1))}}},
        "aggs": aggs,
    }


def last_events_by_source(indexer: Indexer, sources: dict, now: datetime) -> dict:
    if not sources:
        return {}
    result = indexer.search("wazuh-alerts-*", source_event_query(sources, now)) or {}
    out = {}
    for name in sources:
        agg = ((result.get("aggregations") or {}).get(name) or {})
        value = (agg.get("last") or {}).get("value_as_string") or (agg.get("last") or {}).get("value")
        if isinstance(value, (int, float)):
            out[name] = datetime.fromtimestamp(value / 1000, tz=timezone.utc)
        else:
            out[name] = _parse(value)
    return out


def check_sources(config: dict, now: datetime, last_events: dict, heartbeats: dict, containers: dict) -> list[Finding]:
    """Silence per source. ``events``: alerts must arrive within ``max_silence_minutes``.
    ``heartbeat`` (low-volume sources): the pipeline must be alive (collector success or a healthy
    receiver container); events are only expected within ``event_window_hours``."""
    findings = []
    for name, spec in (config.get("sources") or {}).items():
        if spec.get("enabled") is False:
            continue
        mode = spec.get("mode", "events")
        last_event = last_events.get(name)
        event_age = minutes_since(last_event, now)
        silence = float(spec.get("max_silence_minutes", 60))
        window = float(spec.get("event_window_hours", 0)) * 60
        details = {"last_seen": iso(last_event) if last_event else None, "unit": "min",
                   "value": round(event_age, 1) if event_age is not None else None}
        if mode == "events":
            problem = event_age is None or event_age > silence
            summary = (f"Fuente silenciosa: {name} sin eventos en Wazuh hace {_fmt_age(event_age)} (umbral {int(silence)} min)."
                       if problem else f"Fuente {name} con eventos (último hace {_fmt_age(event_age)}).")
            findings.append(Finding("source_silent", name, problem, summary,
                                    "critical" if event_age is None or event_age > silence * 4 else "warning",
                                    threshold=silence, mode=mode, **details))
            continue
        # heartbeat
        beat = spec.get("heartbeat") or {}
        alive, beat_desc = True, ""
        if beat.get("collector"):
            hb = heartbeats.get(beat["collector"])
            hb_age = minutes_since(hb, now)
            alive = hb_age is not None and hb_age <= silence
            beat_desc = f"último éxito del collector hace {_fmt_age(hb_age)}"
        elif beat.get("container"):
            info = containers.get(beat["container"]) or {}
            alive = info.get("running", False) and info.get("health") in ("healthy", "none", "")
            beat_desc = f"receptor {beat['container']} {info.get('health') or info.get('state') or 'ausente'}"
        quiet = window and (event_age is None or event_age > window)
        problem = (not alive) or bool(quiet)
        if not alive:
            summary = f"Fuente silenciosa: {name} sin latido ({beat_desc}; umbral {int(silence)} min)."
            severity = "critical"
        elif quiet:
            summary = (f"Fuente silenciosa: {name} vivo ({beat_desc}) pero sin eventos en Wazuh hace "
                       f"{_fmt_age(event_age)} (ventana {int(window / 60)} h).")
            severity = "warning"
        else:
            summary = f"Fuente {name} con latido ({beat_desc}); último evento hace {_fmt_age(event_age)}."
            severity = "warning"
        findings.append(Finding("source_silent", name, problem, summary, severity,
                                threshold=window or silence, mode=mode, heartbeat="true" if alive else "false", **details))
    return findings


def container_states(names_hint=None) -> dict:
    rows = docker_json(["ps", "-a", "--no-trunc"])
    out = {}
    for row in rows:
        name = row.get("Names", "")
        status = row.get("Status", "")
        health = ""
        match = re.search(r"\((healthy|unhealthy|health: starting)\)", status)
        if match:
            health = match.group(1).replace("health: ", "")
        out[name] = {"state": row.get("State", ""), "running": row.get("State") == "running", "health": health or "none",
                     "status": status}
    return out


def check_containers(config: dict, containers: dict) -> list[Finding]:
    findings = []
    spec = config.get("containers") or {}
    required = list(spec.get("required") or [])
    optional = list(spec.get("optional") or [])
    prefix = spec.get("watch_prefix", "qapaq-")
    names = set(required) | {n for n in optional if n in containers} | {n for n in containers if n.startswith(prefix)}
    for name in sorted(names):
        info = containers.get(name)
        if info is None:
            if name in required:
                findings.append(Finding("container_unhealthy", "qapaq", True, f"Contenedor {name} no existe.", "critical", name))
            continue
        bad = (not info["running"]) or info["health"] == "unhealthy" or "Restarting" in info["status"]
        if not info["running"] and name not in required and info["state"] in ("exited", "created") and name not in optional:
            # one-shot tools (migrator, certbot) that exited normally are not services
            continue
        findings.append(Finding(
            "container_unhealthy", "qapaq", bad,
            f"Contenedor {name} {info['state']} ({info['health']}): {info['status']}." if bad else f"Contenedor {name} sano.",
            "critical" if name in required else "warning", name, value=info["health"], state=info["state"],
        ))
    return findings


def check_agents(config: dict, api: WazuhApi, now: datetime) -> list[Finding]:
    spec = config.get("agents") or {}
    limit = float(spec.get("max_disconnected_minutes", 15))
    ignore = {str(x).lower() for x in spec.get("ignore") or []}
    data = api.get("/agents?select=id,name,status,lastKeepAlive&limit=500") or {}
    findings = []
    for agent in ((data.get("data") or {}).get("affected_items") or []):
        if str(agent.get("id")) == "000" or str(agent.get("name", "")).lower() in ignore:
            continue
        status = agent.get("status", "")
        if status == "never_connected" and not spec.get("alert_never_connected", False):
            continue
        last = _parse(agent.get("lastKeepAlive"))
        age = minutes_since(last, now)
        problem = status != "active" and (age is None or age > limit)
        name = str(agent.get("name") or agent.get("id"))
        findings.append(Finding(
            "agent_disconnected", "wazuh", problem,
            (f"Agente desconectado: {name} ({agent.get('id')}) en estado {status}, último keepalive hace {_fmt_age(age)}."
             if problem else f"Agente {name} activo."),
            "critical" if problem and (age is None or age > limit * 8) else "warning",
            f"agent-{agent.get('id')}", agent_name=name, agent_id=str(agent.get("id")), value=status,
            last_seen=iso(last) if last else None,
        ))
    return findings


def check_indexer(config: dict, indexer: Indexer) -> list[Finding]:
    findings = []
    health = indexer.get("/_cluster/health") or {}
    status = health.get("status", "unknown")
    findings.append(Finding(
        "indexer_cluster", "wazuh", status != "green",
        f"Indexer en estado {status} ({health.get('unassigned_shards', '?')} shards sin asignar)." if status != "green"
        else "Indexer en verde.",
        "critical" if status in ("red", "unknown") else "warning", "cluster", value=status,
        unassigned=health.get("unassigned_shards"),
    ))
    spec = config.get("indexer_checks") or {}
    # disk watermarks: allocation per node vs configured thresholds (defaults of OpenSearch)
    alloc = indexer.get("/_cat/allocation?format=json&bytes=b") or []
    high = float(spec.get("disk_high_pct", 90))
    low = float(spec.get("disk_low_pct", 85))
    for node in alloc:
        try:
            pct = float(node.get("disk.percent"))
        except (TypeError, ValueError):
            continue
        name = node.get("node", "node")
        findings.append(Finding(
            "indexer_disk", "wazuh", pct >= low,
            f"Disco del indexer ({name}) al {pct:.0f}% (watermark low {low:.0f}%, high {high:.0f}%)." if pct >= low
            else f"Disco del indexer ({name}) al {pct:.0f}%.",
            "critical" if pct >= high else "warning", name, value=pct, threshold=low, unit="%",
        ))
    blocked = indexer.get("/_all/_settings/index.blocks.read_only_allow_delete?flat_settings=true") or {}
    ro = sorted(name for name, body in blocked.items()
                if str(((body or {}).get("settings") or {}).get("index.blocks.read_only_allow_delete", "")).lower() == "true")
    findings.append(Finding(
        "indexer_disk", "wazuh", bool(ro),
        f"{len(ro)} índices en solo lectura por watermark (flood stage): {', '.join(ro[:5])}." if ro else "Sin índices bloqueados.",
        "critical", "read-only-blocks", value=len(ro),
    ))
    try:
        explain = indexer.get("/_plugins/_ism/explain/" + spec.get("ism_pattern", "wazuh-*")) or {}
    except ProviderError as error:
        if error.status == 404:
            explain = {}
        else:
            raise
    failed = []
    for name, body in explain.items():
        if not isinstance(body, dict):
            continue
        info = body.get("info") or {}
        if body.get("failed") or (body.get("action") or {}).get("failed") or "fail" in str(info.get("message", "")).lower():
            failed.append(name)
    findings.append(Finding(
        "ism_error", "wazuh", bool(failed),
        f"ISM con errores en {len(failed)} índices: {', '.join(sorted(failed)[:5])}." if failed else "ISM sin errores.",
        "warning", "ism", value=len(failed),
    ))
    return findings


def check_certificates(config: dict, now: datetime) -> list[Finding]:
    spec = config.get("certificates") or {}
    warn, crit = float(spec.get("warn_days", 30)), float(spec.get("critical_days", 7))
    findings = []
    for item in spec.get("files") or []:
        path = pathlib.Path(item["path"])
        name = item.get("name") or path.name
        if not path.exists():
            if item.get("required", True):
                findings.append(Finding("cert_expiry", "qapaq", True, f"Certificado {name} no encontrado ({path}).", "warning", name))
            continue
        expiry = cert_not_after(path)
        if expiry is None:
            findings.append(Finding("cert_expiry", "qapaq", True, f"No se pudo leer el certificado {name}.", "warning", name))
            continue
        days = (expiry - now).total_seconds() / 86400
        problem = days <= warn
        findings.append(Finding(
            "cert_expiry", "qapaq", problem,
            (f"Certificado {name} vence en {days:.0f} días ({iso(expiry)})." if days > 0 else f"Certificado {name} VENCIDO ({iso(expiry)}).")
            if problem else f"Certificado {name} vigente ({days:.0f} días).",
            "critical" if days <= crit else "warning", name, value=round(days, 1), threshold=warn, unit="days",
            not_after=iso(expiry),
        ))
    return findings


def check_ingestion(config: dict, now: datetime, newest_alert: datetime | None, rows_reader=psql_rows) -> list[Finding]:
    spec = config.get("qapaq_ingestion") or {}
    pg = config.get("postgres") or {}
    limit = float(spec.get("max_lag_minutes", 15))
    rows = rows_reader(
        pg.get("container", "qapaq-postgres-1"), pg.get("role", "qapaq_monitor"), pg.get("database", "qapaq_secops"),
        "SELECT source_id, dataset, max(completed_at), (array_agg(outcome ORDER BY attempted_at DESC))[1], "
        "max(newest_event_at) FILTER (WHERE outcome = 'success'), "
        "max(completed_at) FILTER (WHERE outcome = 'success') "
        "FROM source_poll_observations WHERE attempted_at > now() - interval '2 days' GROUP BY 1, 2",
    )
    findings = []
    if not rows:
        findings.append(Finding("ingestion_lag", "qapaq", True,
                                "QAPAQ no registra pasadas de ingesta en 2 días (API detenida o ingesta apagada).",
                                "critical", "wazuh-alerts"))
        return findings
    for source_id, dataset, last_completed, last_outcome, newest_event, last_success in rows:
        completed = _parse(last_completed)
        success = _parse(last_success)
        newest = _parse(newest_event)
        pass_age = minutes_since(success, now)
        lag = (newest_alert - newest).total_seconds() / 60 if (newest_alert and newest and newest_alert > newest) else 0.0
        problems = []
        if pass_age is None or pass_age > limit:
            problems.append(f"última pasada correcta hace {_fmt_age(pass_age)}")
        if last_outcome != "success":
            problems.append(f"última pasada: {last_outcome}")
        if lag > limit:
            problems.append(f"QAPAQ va {_fmt_age(lag)} detrás de Wazuh")
        findings.append(Finding(
            "ingestion_lag", "qapaq", bool(problems),
            ("Ingesta QAPAQ retrasada (" + dataset + "): " + "; ".join(problems) + ".") if problems
            else f"Ingesta QAPAQ al día ({dataset}, retraso {lag:.0f} min).",
            "critical" if (pass_age is None or pass_age > limit * 4) else "warning", dataset,
            value=round(lag, 1), threshold=limit, unit="min", last_seen=iso(completed) if completed else None,
            source_id=source_id, outcome=last_outcome,
        ))
    return findings


def check_host(config: dict, proc_root: str = "/proc") -> list[Finding]:
    spec = config.get("host") or {}
    findings = []
    warn, crit = float(spec.get("disk_warn_pct", 85)), float(spec.get("disk_crit_pct", 95))
    for path in spec.get("disk_paths") or ["/"]:
        if not os.path.exists(path):
            continue
        usage = shutil.disk_usage(path)
        pct = usage.used / usage.total * 100 if usage.total else 0
        findings.append(Finding(
            "host_disk", "host", pct > warn,
            f"Disco {path} al {pct:.0f}% (libre {usage.free / 2**30:.1f} GiB, umbral {warn:.0f}%)." if pct > warn
            else f"Disco {path} al {pct:.0f}%.",
            "critical" if pct > crit else "warning", path, value=round(pct, 1), threshold=warn, unit="%",
        ))
    try:
        meminfo = {}
        for line in pathlib.Path(proc_root, "meminfo").read_text().splitlines():
            key, _, rest = line.partition(":")
            meminfo[key] = int(rest.strip().split()[0])
        used_pct = (1 - meminfo["MemAvailable"] / meminfo["MemTotal"]) * 100
        mwarn = float(spec.get("mem_warn_pct", 90))
        findings.append(Finding(
            "host_memory", "host", used_pct > mwarn,
            f"Memoria del host al {used_pct:.0f}% (umbral {mwarn:.0f}%)." if used_pct > mwarn else f"Memoria al {used_pct:.0f}%.",
            "critical" if used_pct > 97 else "warning", "memory", value=round(used_pct, 1), threshold=mwarn, unit="%",
        ))
        load5 = float(pathlib.Path(proc_root, "loadavg").read_text().split()[1])
        cpus = os.cpu_count() or 1
        per_cpu = load5 / cpus
        lwarn = float(spec.get("load_per_cpu_warn", 2.0))
        findings.append(Finding(
            "host_load", "host", per_cpu > lwarn,
            f"Carga de CPU alta: load5 {load5:.1f} en {cpus} vCPU." if per_cpu > lwarn else f"Carga de CPU normal ({load5:.1f}).",
            "warning", "cpu", value=round(per_cpu, 2), threshold=lwarn, unit="load/cpu",
        ))
    except (OSError, KeyError, ValueError, IndexError):
        pass
    return findings


def check_edge(config: dict) -> list[Finding]:
    spec = config.get("edge_probe") or {}
    url = spec.get("url")
    if not url:
        return []
    ok = set(spec.get("ok_status") or [200, 301, 302, 401])
    try:
        status = https_get(url, timeout=float(spec.get("timeout", 10))).status
        problem = status not in ok
        summary = f"Portal {url} responde HTTP {status}." if problem else f"Portal responde ({status})."
    except ProviderError as error:
        status, problem, summary = None, True, f"Portal {url} inalcanzable ({error})."
    return [Finding("edge_unreachable", "edge", problem, summary, "critical", "public-url", value=status)]


def check_vuln_intel(config: dict, now: datetime) -> list[Finding]:
    spec = config.get("vulnprio") or {}
    cache = spec.get("cache_dir")
    if not cache:
        return []
    limit = float(spec.get("max_age_hours", 48))
    try:
        generated = _parse(json.loads(pathlib.Path(cache, "kev.json").read_text(encoding="utf-8")).get("generated_at"))
    except (OSError, ValueError):
        generated = None
    age = minutes_since(generated, now)
    problem = age is None or age > limit * 60
    return [Finding("vuln_intel_stale", "vulnprio", problem,
                    f"Feeds KEV/EPSS desactualizados (última descarga hace {_fmt_age(age)})." if problem
                    else f"Feeds KEV/EPSS al día ({_fmt_age(age)}).",
                    "warning", "kev-epss", value=round(age / 60, 1) if age is not None else None, threshold=limit, unit="h")]


def check_canaries(config: dict, now: datetime) -> list[Finding]:
    """Read the verdicts written by ``qapaq_canary.py verify`` (it also emits canary_missing itself)."""
    spec = config.get("canary") or {}
    path = spec.get("state_file")
    if not path or not pathlib.Path(path).is_file():
        return []
    state = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    findings = []
    max_age = float(spec.get("max_verdict_age_hours", 26)) * 60
    for pipeline, verdict in (state.get("verdicts") or {}).items():
        at = _parse(verdict.get("verified_at"))
        age = minutes_since(at, now)
        stale = age is None or age > max_age
        problem = stale or verdict.get("result") != "ok"
        summary = (f"Canario {pipeline}: {verdict.get('result')} ({verdict.get('detail', '')})." if not stale
                   else f"Canario {pipeline} sin verificación hace {_fmt_age(age)}.")
        findings.append(Finding("canary_missing", pipeline, problem, summary if problem else f"Canario {pipeline} OK.",
                                "warning", "canary", stage=verdict.get("stage"), last_seen=verdict.get("verified_at")))
    return findings


def check_sns(config: dict) -> list[Finding]:
    """Optional: needs AWS credentials on the host (absent in PowerUser mode → skipped)."""
    spec = config.get("sns") or {}
    if not spec.get("enabled"):
        return []
    try:
        import boto3  # type: ignore  # noqa: PLC0415
    except ImportError:
        return [Finding("monitor_error", "aws", True, "Chequeo SNS habilitado pero boto3 no está instalado.", "info", "sns")]
    findings = []
    client = boto3.client("sns", region_name=spec.get("region", "us-east-1"))
    for topic in spec.get("topics") or []:
        subs = client.list_subscriptions_by_topic(TopicArn=topic).get("Subscriptions", [])
        pending = [s for s in subs if s.get("SubscriptionArn") == "PendingConfirmation"]
        findings.append(Finding("sns_subscription", "aws", bool(pending),
                                f"{len(pending)} suscripciones SNS sin confirmar en {topic.split(':')[-1]}." if pending
                                else "Suscripciones SNS confirmadas.", "warning", topic.split(":")[-1]))
    return findings


# --------------------------------------------------------------------------- state machine


def health_event(finding: Finding, now: datetime, status: str, extra: dict | None = None) -> dict:
    health = {
        "check": finding.check,
        "status": status,
        "severity": finding.severity if status == "problem" else "info",
        "source": finding.source,
        "key": finding.key,
        "summary": finding.summary,
    }
    if finding.component:
        health["component"] = finding.component
    for name, value in finding.fields.items():
        health[name] = value if isinstance(value, (int, float, str)) else str(value)
    health.update(extra or {})
    return {
        "qapaq": {"vendor": "qapaq-platform", "source": "monitor", "event_type": "health", "collected_at": iso(now),
                "health": health},
    }


def reconcile(findings: list[Finding], state: dict, now: datetime, renotify_hours: float) -> tuple[list[dict], dict]:
    """Emit on transitions; re-notify open problems. Returns ``(events, new_state)``."""
    problems = dict(state.get("problems") or {})
    events = []
    seen_keys = set()
    for finding in findings:
        key = finding.key
        seen_keys.add(key)
        open_problem = problems.get(key)
        if finding.problem:
            if open_problem is None:
                problems[key] = {"since": iso(now), "notified": iso(now), "severity": finding.severity, "check": finding.check}
                events.append(health_event(finding, now, "problem", {"since": iso(now)}))
            else:
                escalated = SEVERITY_RANK.get(finding.severity, 0) > SEVERITY_RANK.get(open_problem.get("severity"), 0)
                notified = _parse(open_problem.get("notified")) or now
                if escalated or (now - notified) >= timedelta(hours=renotify_hours):
                    open_problem.update({"notified": iso(now), "severity": finding.severity})
                    events.append(health_event(finding, now, "problem",
                                               {"since": open_problem.get("since"), "renotify": "true"}))
        elif open_problem is not None:
            events.append(health_event(finding, now, "ok", {"since": open_problem.get("since"),
                                                              "summary": "Recuperado: " + finding.summary}))
            problems.pop(key, None)
    # A problem whose subject disappeared (container removed, agent deleted) is closed silently
    # only for checks that ran this time; checks that errored keep their open problems.
    ran_checks = {f.check for f in findings}
    for key in list(problems):
        if key not in seen_keys and problems[key].get("check") in ran_checks:
            problems.pop(key)
    new_state = dict(state)
    new_state["problems"] = problems
    return events, new_state


def source_snapshots(findings: list[Finding], config: dict, state: dict, now: datetime) -> tuple[list[dict], dict]:
    """One ``source_status`` event per source every ``snapshot_minutes`` (UI «Integraciones» model)."""
    interval = float(config.get("snapshot_minutes", 60))
    last = _parse(state.get("last_snapshot"))
    if last and (now - last) < timedelta(minutes=interval):
        return [], state
    by_source: dict[str, dict] = {}
    for f in findings:
        if f.check not in ("source_silent", "collector_failing"):
            continue
        entry = by_source.setdefault(f.source, {"status": "ok", "summary": [], "last_seen": None, "checks": []})
        entry["checks"].append(f.check)
        if f.problem:
            entry["status"] = "silent" if f.check == "source_silent" else ("failing" if entry["status"] == "ok" else entry["status"])
            entry["summary"].append(f.summary)
        if f.check == "source_silent" and f.fields.get("last_seen"):
            entry["last_seen"] = f.fields["last_seen"]
    for name, spec in (config.get("sources") or {}).items():
        if spec.get("enabled") is False:
            by_source[name] = {"status": "disabled", "summary": [spec.get("disabled_reason", "Fuente deshabilitada en la configuración.")],
                               "last_seen": None, "checks": []}
    events = []
    for name, entry in sorted(by_source.items()):
        finding = Finding("source_status", name, False,
                          " ".join(entry["summary"]) or f"Fuente {name} operativa.", "info")
        extra = {"source_state": entry["status"]}
        if entry["last_seen"]:
            extra["last_seen"] = entry["last_seen"]
        events.append(health_event(finding, now, "ok", extra))
    new_state = dict(state)
    new_state["last_snapshot"] = iso(now)
    return events, new_state


# --------------------------------------------------------------------------- driver


def collect_findings(config: dict, now: datetime, indexer=None, api=None) -> list[Finding]:
    findings: list[Finding] = []

    def guarded(name: str, func, *args):
        try:
            result = func(*args)
            findings.append(Finding("monitor_error", "monitor", False, f"Chequeo {name} operativo.", "info", name))
            return result
        except (ProviderError, OSError, ValueError, KeyError, TypeError) as error:
            status = f" HTTP {error.status}" if isinstance(error, ProviderError) and error.status else ""
            findings.append(Finding("monitor_error", "monitor", True,
                                    f"El monitor no pudo ejecutar el chequeo {name} ({type(error).__name__}{status}).",
                                    "warning", name))
            return None

    indexer = indexer or Indexer(config.get("indexer") or {})
    api = api or WazuhApi(config.get("wazuh_api") or {})
    collector_result = guarded("collectors", check_collectors, config, now)
    if collector_result:
        findings.extend(collector_result[0])
    heartbeats = collector_result[1] if collector_result else {}
    containers = guarded("containers", container_states) or {}
    if containers:
        findings.extend(check_containers(config, containers))
    sources = {k: v for k, v in (config.get("sources") or {}).items() if v.get("enabled") is not False}
    last_events = guarded("source_events", last_events_by_source, indexer, sources, now)
    if last_events is not None:
        findings.extend(check_sources(config, now, last_events, heartbeats, containers))
    newest_alert = None
    newest = guarded("newest_alert", newest_alert_time, indexer, now)
    if newest is not None:
        newest_alert = newest
    for name, func, args in (
        ("agents", check_agents, (config, api, now)),
        ("indexer", check_indexer, (config, indexer)),
        ("certificates", check_certificates, (config, now)),
        ("ingestion", check_ingestion, (config, now, newest_alert)),
        ("host", check_host, (config,)),
        ("edge", check_edge, (config,)),
        ("vuln_intel", check_vuln_intel, (config, now)),
        ("canaries", check_canaries, (config, now)),
        ("sns", check_sns, (config,)),
    ):
        if (config.get("disabled_checks") or []) and name in config["disabled_checks"]:
            continue
        result = guarded(name, func, *args)
        if result:
            findings.extend(result)
    return findings


def newest_alert_time(indexer: Indexer, now: datetime):
    body = {"size": 0, "track_total_hits": False,
            "query": {"range": {"timestamp": {"gte": iso(now - timedelta(days=2))}}},
            "aggs": {"last": {"max": {"field": "timestamp"}}}}
    value = (((indexer.search("wazuh-alerts-*", body) or {}).get("aggregations") or {}).get("last") or {}).get("value")
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc) if isinstance(value, (int, float)) else None


def run_once(config: dict, now: datetime | None = None, indexer=None, api=None, dry_run: bool = False) -> dict:
    now = now or utc_now()
    state_path = pathlib.Path(config["state_file"])
    state = read_state(state_path)
    findings = collect_findings(config, now, indexer, api)
    events, state = reconcile(findings, state, now, float(config.get("renotify_hours", 6)))
    snapshots, state = source_snapshots(findings, config, state, now)
    events.extend(snapshots)
    state["last_run"] = iso(now)
    state["last_success"] = iso(now)
    open_problems = sorted(state.get("problems", {}))
    if not dry_run:
        emit(config["output_file"], events)
        save_state(state_path, state)
    return {"events": len(events), "open_problems": open_problems, "findings": len(findings),
            "_events": events if dry_run else None}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", required=True, type=pathlib.Path)
    parser.add_argument("--dry-run", action="store_true", help="evaluate and print, do not write events/state")
    args = parser.parse_args()
    started = time.monotonic()
    try:
        config = load_config(args.config)
        result = run_once(config, dry_run=args.dry_run)
    except (ProviderError, OSError, KeyError, ValueError) as error:
        print(f"qapaq-platform-monitor: run failed ({type(error).__name__}: {error})", file=sys.stderr)
        return 1
    if args.dry_run:
        for event in result["_events"] or []:
            print(json.dumps(event, ensure_ascii=False))
    print(f"qapaq-platform-monitor: ok findings={result['findings']} events={result['events']} "
          f"open={len(result['open_problems'])} ({time.monotonic() - started:.1f}s) {','.join(result['open_problems'])}",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
