#!/usr/bin/env python3
"""Genera qapaq-aws.ndjson: dashboard OSD «QAPAQ · AWS» del monitoreo de la cuenta AWS sin IAM.

EventBridge → SNS → receptor aws-events → JSONL → reglas Wazuh 101600–101699 (wazuh/aws-events).
Mismo formato e IDs estables que build_provider_dashboards.py (dashboard `qapaq-dashboard-aws`,
objetos `qapaq-aws-*`): importar con overwrite es idempotente. Uso:

    python3 wazuh/dashboard/saved-objects/build_aws_dashboard.py
"""

from __future__ import annotations

import json
import pathlib

INDEX_PATTERN = "wazuh-alerts-*"
INDEX_REF = "kibanaSavedObjectMeta.searchSourceJSON.index"
OSD_VERSION = "2.19.6"
LEVEL_RANGES = [
    {"from": 0, "to": 4},
    {"from": 4, "to": 8},
    {"from": 8, "to": 12},
    {"from": 12, "to": 16},
]

AWS = {
    "id": "aws",
    "title": "QAPAQ · AWS",
    "query": "rule.groups:aws and data.qapaq.vendor:aws",
}
ABOUT = (
    "### ![AWS](/ui/qapaq/vendors/aws.svg) AWS (cuenta 061098277310)\n\n"
    "CloudTrail (trail de organización) → EventBridge (reglas por categoría en us-east-1 y centinelas en las "
    "otras 16 regiones habilitadas) → SNS → `https://dev.security.qapaq.pe/hooks/aws-sns` → receptor "
    "`aws-events` (firma SNS v2 verificada, TopicArn esperado, dedupe) → Wazuh. Sin IAM: el módulo AWS nativo "
    "de Wazuh no se usa.\n\n"
    "**Cubre:** inicios de sesión de consola (fallos, fuerza bruta, sin MFA, root), IAM / Identity Center / "
    "Organizations, security groups / NACL / rutas / flow logs, S3 (políticas, ACL, bloqueo público), KMS, "
    "CloudTrail / GuardDuty / Security Hub / Config deshabilitados, actividad en regiones no habituales y "
    "hallazgos GuardDuty / Security Hub (hoy ambos servicios apagados).\n\n"
    "**Reglas Wazuh:** 101600–101673 · **Filtro:** `rule.groups:aws and data.qapaq.vendor:aws`"
)
COLUMNS = ["rule.level", "rule.description", "data.aws.event_name", "data.aws.principal",
           "data.aws.source_ip", "data.aws.region", "data.aws.error_code"]


def search_source(query: str) -> str:
    return json.dumps(
        {"query": {"query": query, "language": "kuery"}, "filter": [], "indexRefName": INDEX_REF},
        ensure_ascii=False,
    )


def index_reference() -> list[dict]:
    return [{"name": INDEX_REF, "type": "index-pattern", "id": INDEX_PATTERN}]


def count_metric() -> dict:
    return {"id": "1", "enabled": True, "type": "count", "params": {}, "schema": "metric"}


def visualization(vid: str, title: str, vis_type: str, aggs: list, params: dict, query: str | None):
    attributes = {
        "title": title,
        "visState": json.dumps(
            {"title": title, "type": vis_type, "aggs": aggs, "params": params}, ensure_ascii=False
        ),
        "uiStateJSON": "{}",
        "description": "",
        "version": 1,
        "kibanaSavedObjectMeta": {
            "searchSourceJSON": search_source(query)
            if query is not None
            else json.dumps({"query": {"query": "", "language": "kuery"}, "filter": []})
        },
    }
    return {
        "id": vid,
        "type": "visualization",
        "attributes": attributes,
        "references": index_reference() if query is not None else [],
    }


def markdown(vid: str, title: str, text: str):
    return visualization(
        vid,
        title,
        "markdown",
        [],
        {"fontSize": 12, "openLinksInNewTab": False, "markdown": text},
        None,
    )


def metric(vid: str, title: str, query: str, agg: dict | None = None, label: str = "Eventos"):
    aggs = [agg or count_metric()]
    params = {
        "addTooltip": True,
        "addLegend": False,
        "type": "metric",
        "metric": {
            "percentageMode": False,
            "useRanges": False,
            "colorSchema": "Green to Red",
            "metricColorMode": "None",
            "colorsRange": [{"from": 0, "to": 10000}],
            "labels": {"show": True},
            "invertColors": False,
            "style": {"bgFill": "#000", "bgColor": False, "labelColor": False, "subText": "",
                      "fontSize": 40},
        },
    }
    if agg is None:
        aggs[0]["params"] = {"customLabel": label}
    return visualization(vid, title, "metric", aggs, params, query)


def severity_over_time(vid: str, title: str, query: str):
    aggs = [
        {**count_metric(), "params": {"customLabel": "Eventos"}},
        {
            "id": "2",
            "enabled": True,
            "type": "date_histogram",
            "params": {"field": "timestamp", "useNormalizedOpenSearchInterval": True,
                       "interval": "auto", "drop_partials": False, "min_doc_count": 1,
                       "extended_bounds": {}, "customLabel": "Tiempo"},
            "schema": "segment",
        },
        {
            "id": "3",
            "enabled": True,
            "type": "range",
            "params": {"field": "rule.level", "ranges": LEVEL_RANGES, "customLabel": "Severidad"},
            "schema": "group",
        },
    ]
    params = {
        "type": "histogram",
        "grid": {"categoryLines": False},
        "categoryAxes": [{"id": "CategoryAxis-1", "type": "category", "position": "bottom",
                          "show": True, "style": {}, "scale": {"type": "linear"},
                          "labels": {"show": True, "filter": True, "truncate": 100}, "title": {}}],
        "valueAxes": [{"id": "ValueAxis-1", "name": "LeftAxis-1", "type": "value",
                       "position": "left", "show": True, "style": {},
                       "scale": {"type": "linear", "mode": "normal"},
                       "labels": {"show": True, "rotate": 0, "filter": False, "truncate": 100},
                       "title": {"text": "Eventos"}}],
        "seriesParams": [{"show": True, "type": "histogram", "mode": "stacked",
                          "data": {"label": "Eventos", "id": "1"}, "valueAxis": "ValueAxis-1",
                          "drawLinesBetweenPoints": True, "lineWidth": 2, "showCircles": True}],
        "addTooltip": True,
        "addLegend": True,
        "legendPosition": "right",
        "times": [],
        "addTimeMarker": False,
        "labels": {"show": False},
        "thresholdLine": {"show": False, "value": 10, "width": 1, "style": "full",
                          "color": "#E7664C"},
    }
    return visualization(vid, title, "histogram", aggs, params, query)


def top_table(vid: str, title: str, query: str, field: str, label: str, size: int = 10):
    aggs = [
        {**count_metric(), "params": {"customLabel": "Eventos"}},
        {
            "id": "2",
            "enabled": True,
            "type": "terms",
            "params": {"field": field, "orderBy": "1", "order": "desc", "size": size,
                       "otherBucket": False, "otherBucketLabel": "Otros", "missingBucket": False,
                       "missingBucketLabel": "Sin dato", "customLabel": label},
            "schema": "bucket",
        },
        {
            "id": "3",
            "enabled": True,
            "type": "max",
            "params": {"field": "rule.level", "customLabel": "Nivel máx."},
            "schema": "metric",
        },
    ]
    params = {"perPage": 10, "showPartialRows": False, "showMetricsAtAllLevels": False,
              "showTotal": False, "totalFunc": "sum", "percentageCol": ""}
    return visualization(vid, title, "table", aggs, params, query)


def saved_search(sid: str, title: str, query: str, columns: list[str]):
    return {
        "id": sid,
        "type": "search",
        "attributes": {
            "title": title,
            "description": "",
            "hits": 0,
            "columns": columns,
            "sort": [["timestamp", "desc"]],
            "version": 1,
            "kibanaSavedObjectMeta": {"searchSourceJSON": search_source(query)},
        },
        "references": index_reference(),
    }


def dashboard(provider: dict, panels: list[tuple[dict, dict]]):
    panels_json, references = [], []
    for index, (obj, grid) in enumerate(panels):
        panel_index = str(index + 1)
        panels_json.append({
            "version": OSD_VERSION,
            "gridData": {**grid, "i": panel_index},
            "panelIndex": panel_index,
            "embeddableConfig": {},
            "panelRefName": f"panel_{index}",
        })
        references.append({"name": f"panel_{index}", "type": obj["type"], "id": obj["id"]})
    return {
        "id": f"qapaq-dashboard-{provider['id']}",
        "type": "dashboard",
        "attributes": {
            "title": provider["title"],
            "hits": 0,
            "description": f"Alertas de {provider['title'][6:]} en wazuh-alerts-* ({provider['query']}).",
            "panelsJSON": json.dumps(panels_json),
            "optionsJSON": json.dumps({"hidePanelTitles": False, "useMargins": True}),
            "version": 1,
            "timeRestore": True,
            "timeFrom": "now-7d",
            "timeTo": "now",
            "refreshInterval": {"pause": True, "value": 0},
            "kibanaSavedObjectMeta": {
                "searchSourceJSON": json.dumps({"query": {"query": "", "language": "kuery"},
                                                "filter": []})
            },
        },
        "references": references,
    }



def build() -> list[dict]:
    q, name, p = AWS["query"], AWS["title"], "qapaq-aws"
    note = markdown(f"{p}-about", f"{name} · integración", ABOUT)
    events = metric(f"{p}-events", f"{name} · eventos", q)
    principals = metric(
        f"{p}-unique", f"{name} · identidades distintas", q,
        {"id": "1", "enabled": True, "type": "cardinality",
         "params": {"field": "data.aws.principal", "customLabel": "Identidades"}, "schema": "metric"},
    )
    high = metric(f"{p}-high", f"{name} · altas y críticas", f"({q}) and rule.level >= 8",
                  label="Altas y críticas (nivel ≥ 8)")
    timeline = severity_over_time(f"{p}-severity", f"{name} · severidad en el tiempo", q)
    rules = top_table(f"{p}-top-rules", f"{name} · top reglas", q, "rule.description", "Regla")
    apis = top_table(f"{p}-top-events", f"{name} · top acciones (API)", q, "data.aws.event_name", "Acción")
    who = top_table(f"{p}-top-entities", f"{name} · top identidades", q, "data.aws.principal", "Identidad")
    ips = top_table(f"{p}-top-ips", f"{name} · top IP de origen", q, "data.aws.source_ip", "IP de origen")
    regions = top_table(f"{p}-top-regions", f"{name} · regiones", q, "data.aws.region", "Región")
    signin = top_table(f"{p}-signin-failures", f"{name} · inicios de consola fallidos por IP",
                       f"({q}) and rule.id:(101607 or 101608)", "data.aws.source_ip", "IP de origen")
    latest = saved_search(f"{p}-latest", f"{name} · últimos eventos", q, COLUMNS)
    panels = [
        (note, {"x": 0, "y": 0, "w": 24, "h": 12}),
        (events, {"x": 24, "y": 0, "w": 8, "h": 12}),
        (principals, {"x": 32, "y": 0, "w": 8, "h": 12}),
        (high, {"x": 40, "y": 0, "w": 8, "h": 12}),
        (timeline, {"x": 0, "y": 12, "w": 48, "h": 13}),
        (rules, {"x": 0, "y": 25, "w": 24, "h": 14}),
        (apis, {"x": 24, "y": 25, "w": 24, "h": 14}),
        (who, {"x": 0, "y": 39, "w": 16, "h": 14}),
        (ips, {"x": 16, "y": 39, "w": 16, "h": 14}),
        (regions, {"x": 32, "y": 39, "w": 16, "h": 14}),
        (signin, {"x": 0, "y": 53, "w": 48, "h": 10}),
        (latest, {"x": 0, "y": 63, "w": 48, "h": 18}),
    ]
    return [obj for obj, _ in panels] + [dashboard(AWS, panels)]


def main() -> None:
    target = pathlib.Path(__file__).with_name("qapaq-aws.ndjson")
    lines = [json.dumps(obj, ensure_ascii=False, sort_keys=True) for obj in build()]
    target.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    print(f"{target.name}: {len(lines)} objetos")


if __name__ == "__main__":
    main()
