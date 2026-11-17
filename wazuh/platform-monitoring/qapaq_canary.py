#!/usr/bin/env python3
"""QAPAQ synthetic canaries: one labelled synthetic event per pipeline per day, verified end to end.

``inject`` (daily, ``qapaq-canary-inject.timer``) appends a canary line to each pipeline's own JSONL
(the file Wazuh's ``<localfile>`` already reads) or, for the agent pipeline, a journald line through
``logger``. ``verify`` (every 10 min, ``qapaq-canary-verify.timer``) checks each pending canary:

1. **Wazuh**: the alert exists in ``wazuh-alerts-*`` (rules 101830-101836, level 3: never pages, never mails);
2. **QAPAQ**: a successful QAPAQ ingestion pass read past the alert timestamp (``source_poll_observations``).

If a canary is not seen within ``deadline_minutes`` the verdict is ``missing`` with the failing stage;
``qapaq_platform_monitor.py`` turns verdicts into ``canary_missing`` health alerts (rule 101822). The
canary also watches the monitor: if the monitor has not run for ``monitor_stale_minutes`` it emits a
``monitor_error`` health event itself.

Canary event (fields the UI and analysts can filter on)::

    {"qapaq": {"vendor": "<pipeline vendor>", "source": "...", "event_type": "canary",
             "canary": {"id": "qapaq-canary-<pipeline>-<UTC>-<rand>", "pipeline": "...",
                        "label": "sintético/canary · no requiere acción", "injected_at": "..."}}}
"""

from __future__ import annotations

import argparse
import json
import pathlib
import secrets
import sys
import time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from qapaq_platform_common import (  # noqa: E402
    Indexer,
    ProviderError,
    emit,
    iso,
    load_config,
    parse_iso,
    psql_rows,
    read_state,
    run,
    save_state,
    systemd_unit,
    utc_now,
)

LABEL = "sintético/canary · no requiere acción"


def canary_event(pipeline: str, spec: dict, canary_id: str, now: datetime) -> dict:
    qapaq = {
        "vendor": spec["vendor"],
        "source": spec.get("source", "qapaq-canary"),
        "event_type": "canary",
        "collected_at": iso(now),
        "canary": {"id": canary_id, "pipeline": pipeline, "label": LABEL, "injected_at": iso(now)},
    }
    return {"qapaq": qapaq}


def wait_writer_idle(unit: str | None, unit_reader=systemd_unit, attempts: int = 12, pause: float = 5) -> bool:
    """Avoid interleaving with a collector batch: its oneshot unit is the only other writer."""
    if not unit:
        return True
    for _ in range(attempts):
        if unit_reader(f"{unit}.service").get("ActiveState") not in ("activating", "active", "deactivating"):
            return True
        time.sleep(pause)
    return False


def inject(config: dict, now: datetime, unit_reader=systemd_unit, runner=run) -> dict:
    state_path = pathlib.Path(config["state_file"])
    state = read_state(state_path)
    pending = dict(state.get("inflight") or {})
    injected = {}
    only = set(config.get("_only") or [])
    for pipeline, spec in (config.get("pipelines") or {}).items():
        if spec.get("enabled") is False or (only and pipeline not in only):
            continue
        canary_id = f"qapaq-canary-{pipeline}-{now.strftime('%Y%m%dT%H%M%SZ')}-{secrets.token_hex(3)}"
        try:
            if spec.get("type") == "journald":
                code, _ = runner(["logger", "-t", "qapaq-canary", "-p", "user.notice",
                                  f"QAPAQ canary {canary_id} pipeline={pipeline} {LABEL}"])
                if code != 0:
                    raise ProviderError("logger failed")
            else:
                path = pathlib.Path(spec["file"])
                if not path.parent.is_dir():
                    raise ProviderError("pipeline output directory is missing")
                if not wait_writer_idle(spec.get("unit"), unit_reader):
                    raise ProviderError("collector busy")
                emit(path, [canary_event(pipeline, spec, canary_id, now)])
        except (ProviderError, OSError) as error:
            injected[pipeline] = f"error: {error}"
            pending[pipeline] = {"id": canary_id, "injected_at": iso(now), "inject_error": str(error)}
            continue
        pending[pipeline] = {"id": canary_id, "injected_at": iso(now)}
        injected[pipeline] = canary_id
    state["inflight"] = pending
    save_state(state_path, state)
    return injected


def find_alert(indexer: Indexer, canary_id: str, since: datetime) -> dict | None:
    body = {
        "size": 1,
        "_source": ["timestamp", "rule.id", "rule.level", "agent.name"],
        "query": {"bool": {
            "filter": [{"range": {"timestamp": {"gte": iso(since - timedelta(minutes=5))}}}],
            "should": [{"term": {"data.qapaq.canary.id": canary_id}}, {"match_phrase": {"full_log": canary_id}}],
            "minimum_should_match": 1,
        }},
    }
    hits = (((indexer.search("wazuh-alerts-*", body) or {}).get("hits") or {}).get("hits") or [])
    return hits[0].get("_source") if hits else None


def qapaq_has_read(config: dict, alert_time: datetime, rows_reader=psql_rows) -> bool:
    pg = config.get("postgres") or {}
    rows = rows_reader(
        pg.get("container", "qapaq-postgres-1"), pg.get("role", "qapaq_monitor"), pg.get("database", "qapaq_secops"),
        "SELECT max(newest_event_at) FROM source_poll_observations WHERE outcome = 'success' "
        "AND attempted_at > now() - interval '2 days'",
    )
    value = rows[0][0] if rows and rows[0] and rows[0][0] else ""
    if not value:
        return False
    try:
        return parse_iso(value.replace(" ", "T")) >= alert_time
    except ValueError:
        return False


def verify(config: dict, now: datetime, indexer=None, rows_reader=psql_rows) -> dict:
    state_path = pathlib.Path(config["state_file"])
    state = read_state(state_path)
    pending = dict(state.get("inflight") or {})
    verdicts = dict(state.get("verdicts") or {})
    deadline = timedelta(minutes=float(config.get("deadline_minutes", 30)))
    check_qapaq = config.get("check_qapaq", True)
    indexer = indexer or Indexer(config.get("indexer") or {})
    for pipeline, item in list(pending.items()):
        injected = parse_iso(item["injected_at"])
        verdict = {"id": item["id"], "injected_at": item["injected_at"], "verified_at": iso(now)}
        if item.get("inject_error"):
            verdict.update(result="missing", stage="inject", detail=f"no se pudo inyectar: {item['inject_error']}")
            verdicts[pipeline] = verdict
            pending.pop(pipeline)
            continue
        alert = item.get("alert")
        if not alert:
            try:
                alert = find_alert(indexer, item["id"], injected)
            except ProviderError as error:
                alert = None
                verdict["detail"] = f"consulta al indexer falló ({error})"
            if alert:
                item["alert"] = alert
        stage_ok = bool(alert)
        qapaq_ok = False
        if stage_ok and check_qapaq:
            try:
                qapaq_ok = qapaq_has_read(config, parse_iso(str(alert.get("timestamp")).replace("+0000", "+00:00")), rows_reader)
            except (ProviderError, ValueError):
                qapaq_ok = False
        done = stage_ok and (qapaq_ok or not check_qapaq)
        if done:
            latency = (parse_iso(str(alert.get("timestamp")).replace("+0000", "+00:00")) - injected).total_seconds()
            verdict.update(result="ok", stage="qapaq" if check_qapaq else "wazuh",
                           detail=f"regla {(alert.get('rule') or {}).get('id')} en {latency:.0f}s"
                                  + ("; leído por QAPAQ" if check_qapaq else ""))
            verdicts[pipeline] = verdict
            pending.pop(pipeline)
        elif now - injected > deadline:
            verdict.update(result="missing", stage="qapaq" if stage_ok else "wazuh",
                           detail=("en Wazuh pero QAPAQ no lo leyó" if stage_ok else "no llegó a wazuh-alerts-*")
                                  + f" en {int(deadline.total_seconds() / 60)} min")
            verdicts[pipeline] = verdict
            pending.pop(pipeline)
    state["inflight"] = pending
    state["verdicts"] = verdicts
    state["last_success"] = iso(now)
    save_state(state_path, state)
    watch_monitor(config, now)
    return {"pending": sorted(pending), "verdicts": verdicts}


def watch_monitor(config: dict, now: datetime) -> bool:
    """Emit a health event if the platform monitor itself stopped running."""
    spec = config.get("monitor_watch") or {}
    path = spec.get("state_file")
    if not path:
        return True
    try:
        last = parse_iso(json.loads(pathlib.Path(path).read_text(encoding="utf-8")).get("last_run"))
    except (OSError, ValueError, TypeError, AttributeError):
        last = None
    limit = timedelta(minutes=float(spec.get("stale_minutes", 30)))
    flag = pathlib.Path(spec["output_file"]).with_name(".qapaq-monitor-down")
    if last is not None and now - last <= limit:
        if flag.exists():
            flag.unlink()
            emit(spec["output_file"], [{"qapaq": {"vendor": "qapaq-platform", "source": "canary", "event_type": "health",
                 "collected_at": iso(now), "health": {"check": "monitor_error", "status": "ok", "severity": "info",
                 "source": "monitor", "key": "monitor_error:monitor:heartbeat", "component": "heartbeat",
                 "summary": "Recuperado: el monitor de plataforma QAPAQ vuelve a correr.", "last_seen": iso(last)}}}])
        return True
    if flag.exists():
        return False
    event = {"qapaq": {"vendor": "qapaq-platform", "source": "canary", "event_type": "health", "collected_at": iso(now),
                     "health": {"check": "monitor_error", "status": "problem", "severity": "critical", "source": "monitor",
                                "key": "monitor_error:monitor:heartbeat", "component": "heartbeat",
                                "summary": "El monitor de plataforma QAPAQ no corre (sin ejecución reciente).",
                                "last_seen": iso(last) if last else "nunca"}}}
    emit(spec["output_file"], [event])
    flag.touch()
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["inject", "verify", "status"])
    parser.add_argument("--config", required=True, type=pathlib.Path)
    parser.add_argument("--pipeline", action="append", help="only these pipelines (inject)")
    args = parser.parse_args()
    now = utc_now()
    try:
        config = load_config(args.config)
        if args.pipeline:
            config["_only"] = args.pipeline
        if args.command == "inject":
            result = inject(config, now)
        elif args.command == "verify":
            result = verify(config, now)
        else:
            result = read_state(pathlib.Path(config["state_file"]))
    except (ProviderError, OSError, KeyError, ValueError) as error:
        print(f"qapaq-canary: {args.command} failed ({type(error).__name__}: {error})", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
