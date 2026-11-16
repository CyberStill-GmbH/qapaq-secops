#!/usr/bin/env python3
"""Genera qapaq-detection-dashboards.ndjson: vistas de análisis del programa de detección QAPAQ (docs/17).

Seis dashboards de OSD 2.19 (global tenant), con IDs estables `qapaq-det-*` (importar con overwrite es
idempotente) y la paleta de la identidad QAPAQ (docs/brand/qapaq-visual-identity.md):

  QAPAQ · Cobertura MITRE ATT&CK      técnicas y tácticas observadas + matriz del repositorio y brechas
  QAPAQ · Gestión de vulnerabilidades Wazuh Vulnerability Detection (wazuh-states-vulnerabilities-*) + Snyk
  QAPAQ · Identidad y acceso          inicios de sesión M365/Entra, AWS y SSH; privilegio y cadenas
  QAPAQ · Integridad y cumplimiento   FIM (persistencia QAPAQ 101755–101760) y SCA CIS
  QAPAQ · Threat hunting              búsquedas guardadas con hipótesis (H01–H10)
  QAPAQ · Calidad de detección        volumen por regla, reglas ruidosas, niveles y proporción QAPAQ

La matriz estática sale de detections/reports/mitre-coverage.json (qapaq_detections.py coverage): volver a
generar este NDJSON después de cambiar reglas. Uso:

    python3 detections/tools/qapaq_detections.py coverage
    python3 wazuh/dashboard/saved-objects/detection/build_detection_dashboards.py

Importación: infra/aws-poweruser/scripts/bootstrap-detection-content.sh (proxy auth desde el dashboard).
"""

from __future__ import annotations

import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[3]
OUT = HERE / "qapaq-detection-dashboards.ndjson"
ALERTS = "wazuh-alerts-*"
VULNS = "wazuh-states-vulnerabilities-*"
INDEX_REF = "kibanaSavedObjectMeta.searchSourceJSON.index"
OSD_VERSION = "2.19.6"

# Paleta QAPAQ (docs/brand/qapaq-visual-identity.md).
CORAL, FUCSIA, AMARILLO, LIMA, TURQUESA, AZUL, LAVANDA = (
    "#FF5841", "#FF5899", "#FFC136", "#D0E870", "#00DFC2", "#119CFF", "#CDCCED")
LEVEL_BANDS = [
    {"from": 0, "to": 4, "label": "Baja (0–3)"},
    {"from": 4, "to": 8, "label": "Media (4–7)"},
    {"from": 8, "to": 12, "label": "Alta (8–11)"},
    {"from": 12, "to": 16, "label": "Crítica (12–15)"},
]
LEVEL_COLORS = {"Baja (0–3)": TURQUESA, "Media (4–7)": AMARILLO, "Alta (8–11)": FUCSIA, "Crítica (12–15)": CORAL}
VD_COLORS = {"Critical": CORAL, "High": FUCSIA, "Medium": AMARILLO, "Low": TURQUESA, "-": LAVANDA}
SNYK_COLORS = {"critical": CORAL, "high": FUCSIA, "medium": AMARILLO, "low": TURQUESA}
FOOTER = "\n\n---\n*QAPAQ SOC · Ingeniería de detección · docs/17-ingenieria-de-deteccion.md*"


# ----------------------------------------------------------------------------- primitivas
def search_source(query: str, index: str | None) -> str:
    src = {"query": {"query": query, "language": "kuery"}, "filter": []}
    if index:
        src["indexRefName"] = INDEX_REF
    return json.dumps(src, ensure_ascii=False)


def vis(vid, title, vtype, aggs, params, query="", index=ALERTS, colors=None, description=""):
    ui = {"vis": {"colors": colors}} if colors else {}
    return {
        "id": vid,
        "type": "visualization",
        "attributes": {
            "title": title,
            "description": description,
            "visState": json.dumps({"title": title, "type": vtype, "aggs": aggs, "params": params}, ensure_ascii=False),
            "uiStateJSON": json.dumps(ui, ensure_ascii=False),
            "version": 1,
            "kibanaSavedObjectMeta": {"searchSourceJSON": search_source(query, index)},
        },
        "references": [{"name": INDEX_REF, "type": "index-pattern", "id": index}] if index else [],
    }


def count(label="Alertas", aid="1"):
    return {"id": aid, "enabled": True, "type": "count", "params": {"customLabel": label}, "schema": "metric"}


def agg(aid, atype, schema, **params):
    return {"id": aid, "enabled": True, "type": atype, "params": params, "schema": schema}


def terms(aid, field, label, size=10, schema="bucket", order_by="1", order="desc"):
    return agg(aid, "terms", schema, field=field, orderBy=order_by, order=order, size=size, otherBucket=False,
               otherBucketLabel="Otros", missingBucket=False, missingBucketLabel="Sin dato", customLabel=label)


def markdown(vid, title, text):
    return vis(vid, title, "markdown", [], {"fontSize": 12, "openLinksInNewTab": True, "markdown": text + FOOTER},
               index=None)


def metric(vid, title, query, label, index=ALERTS, metric_agg=None, color=AZUL):
    aggs = [metric_agg or count(label)]
    params = {"addTooltip": True, "addLegend": False, "type": "metric",
              "metric": {"percentageMode": False, "useRanges": False, "colorSchema": "Green to Red",
                         "metricColorMode": "None", "colorsRange": [{"from": 0, "to": 10000}],
                         "labels": {"show": True}, "invertColors": False,
                         "style": {"bgFill": color, "bgColor": False, "labelColor": False, "subText": "",
                                   "fontSize": 36}}}
    return vis(vid, title, "metric", aggs, params, query, index)


def axes(category_position="bottom", value_title="Alertas", rotate=0):
    horizontal = category_position == "left"
    return {
        "grid": {"categoryLines": False},
        "categoryAxes": [{"id": "CategoryAxis-1", "type": "category", "position": category_position, "show": True,
                          "style": {}, "scale": {"type": "linear"},
                          "labels": {"show": True, "rotate": rotate, "filter": not horizontal, "truncate": 120},
                          "title": {}}],
        "valueAxes": [{"id": "ValueAxis-1", "name": "LeftAxis-1", "type": "value",
                       "position": "bottom" if horizontal else "left", "show": True, "style": {},
                       "scale": {"type": "linear", "mode": "normal"},
                       "labels": {"show": True, "rotate": 0, "filter": False, "truncate": 100},
                       "title": {"text": value_title}}],
        "addTooltip": True, "legendPosition": "right", "times": [], "addTimeMarker": False,
        "labels": {"show": horizontal}, "thresholdLine": {"show": False, "value": 10, "width": 1,
                                                          "style": "full", "color": CORAL},
    }


def bars(vid, title, query, field, label, size=10, horizontal=True, index=ALERTS, metric_agg=None, color=AZUL):
    aggs = [metric_agg or count(), terms("2", field, label, size, "segment")]
    params = {"type": "histogram", **axes("left" if horizontal else "bottom"), "addLegend": False,
              "seriesParams": [{"show": True, "type": "histogram", "mode": "normal",
                                "data": {"label": aggs[0]["params"].get("customLabel", "Alertas"), "id": "1"},
                                "valueAxis": "ValueAxis-1", "drawLinesBetweenPoints": True, "lineWidth": 2,
                                "showCircles": True}]}
    label0 = aggs[0]["params"].get("customLabel", "Alertas")
    return vis(vid, title, "horizontal_bar" if horizontal else "histogram", aggs, params, query, index,
               colors={label0: color})


def over_time(vid, title, query, split, colors=None, mode="stacked", vtype="histogram"):
    aggs = [count(), agg("2", "date_histogram", "segment", field="timestamp", useNormalizedOpenSearchInterval=True,
                         interval="auto", drop_partials=False, min_doc_count=1, extended_bounds={}), split]
    params = {"type": vtype, **axes("bottom"), "addLegend": True,
              "seriesParams": [{"show": True, "type": vtype, "mode": mode, "data": {"label": "Alertas", "id": "1"},
                                "valueAxis": "ValueAxis-1", "drawLinesBetweenPoints": True, "lineWidth": 2,
                                "interpolate": "linear", "showCircles": True}]}
    return vis(vid, title, vtype, aggs, params, query, colors=colors)


def level_split(aid="3"):
    return agg(aid, "range", "group", field="rule.level", ranges=LEVEL_BANDS)


def filters_split(items, aid="3"):
    return agg(aid, "filters", "group",
               filters=[{"input": {"query": q, "language": "kuery"}, "label": label} for label, q in items])


def pie(vid, title, query, bucket, index=ALERTS, colors=None, metric_agg=None):
    params = {"type": "pie", "addTooltip": True, "addLegend": True, "legendPosition": "right", "isDonut": True,
              "labels": {"show": False, "values": True, "last_level": True, "truncate": 100}}
    return vis(vid, title, "pie", [metric_agg or count(), bucket], params, query, index, colors=colors)


def table(vid, title, query, buckets, metrics, index=ALERTS, per_page=10):
    params = {"perPage": per_page, "showPartialRows": False, "showMetricsAtAllLevels": False, "showTotal": False,
              "totalFunc": "sum", "percentageCol": "", "sort": {"columnIndex": None, "direction": None}}
    return vis(vid, title, "table", metrics + buckets, params, query, index)


def search(sid, title, query, columns, description=""):
    return {
        "id": sid,
        "type": "search",
        "attributes": {
            "title": title, "description": description, "hits": 0, "columns": columns,
            "sort": [["timestamp", "desc"]], "version": 1,
            "kibanaSavedObjectMeta": {"searchSourceJSON": search_source(query, ALERTS)},
        },
        "references": [{"name": INDEX_REF, "type": "index-pattern", "id": ALERTS}],
    }


def dashboard(did, title, description, layout, time_from="now-7d"):
    panels, refs = [], []
    for i, (obj, (x, y, w, h)) in enumerate(layout):
        panels.append({"version": OSD_VERSION, "gridData": {"x": x, "y": y, "w": w, "h": h, "i": str(i + 1)},
                       "panelIndex": str(i + 1), "embeddableConfig": {}, "panelRefName": f"panel_{i}"})
        refs.append({"name": f"panel_{i}", "type": obj["type"], "id": obj["id"]})
    return {
        "id": did,
        "type": "dashboard",
        "attributes": {
            "title": title, "hits": 0, "description": description,
            "panelsJSON": json.dumps(panels), "optionsJSON": json.dumps({"hidePanelTitles": False, "useMargins": True}),
            "version": 1, "timeRestore": True, "timeFrom": time_from, "timeTo": "now",
            "refreshInterval": {"pause": True, "value": 0},
            "kibanaSavedObjectMeta": {"searchSourceJSON": json.dumps({"query": {"query": "", "language": "kuery"},
                                                                      "filter": []})},
        },
        "references": refs,
    }


# ----------------------------------------------------------------------------- 1. Cobertura MITRE
def mitre_dashboard():
    cov = json.loads((ROOT / "detections/reports/mitre-coverage.json").read_text(encoding="utf-8"))
    b, a = cov["before_program"], cov["after_program"]
    pr = {1: "Alta", 2: "Media", 3: "Baja"}
    gaps = [g for g in cov["priorities"] if g["state"] != "cubierta"]
    att = json.loads((ROOT / "detections/mitre/attack-qapaq.json").read_text(encoding="utf-8"))
    tactic_rows = "\n".join(
        f"| {t['es']} | {len(cov['per_tactic'][t['key']])} | "
        + (", ".join(f"`{x}`" for x in cov["per_tactic"][t["key"]][:9]) + (" …" if len(cov["per_tactic"][t["key"]]) > 9 else "")
           if cov["per_tactic"][t["key"]] else "**sin cobertura**") + " |"
        for t in att["tactics"])
    about = (
        "## Cobertura MITRE ATT&CK de QAPAQ SOC\n\n"
        "Arriba: lo que **dispara** en el periodo elegido (campo `rule.mitre.*` de las alertas). "
        "Abajo: lo que **cubren las reglas** del repositorio, generado desde su XML por "
        "`detections/tools/qapaq_detections.py coverage`.\n\n"
        "| | Antes del programa | Con el programa |\n| --- | ---: | ---: |\n"
        f"| Reglas QAPAQ | {b['rules']} | {a['rules']} |\n"
        f"| Técnicas y subtécnicas | {len(b['techniques'])} | {len(a['techniques'])} |\n"
        f"| Tácticas cubiertas | {len(b['tactics_covered'])}/14 | {len(a['tactics_covered'])}/14 |\n\n"
        f"Nuevas: {', '.join('`' + t + '`' for t in cov['new_techniques'])}."
    )
    matrix = "## Matriz por táctica (reglas QAPAQ del repositorio)\n\n| Táctica | Técnicas | Ejemplos |\n| --- | ---: | --- |\n" + tactic_rows
    gap_md = ("## Brechas priorizadas\n\n| Prio. | Técnica | Estado | Bloqueo |\n| --- | --- | --- | --- |\n"
              + "\n".join(f"| {pr[g['priority']]} | `{g['technique']}` {g['name']} | {g['state']} | {g['blocker']} |"
                          for g in gaps[:16])
              + "\n\nDetalle y plan: `detections/reports/mitre-coverage.md` y backlog en docs/17.")
    q = "rule.mitre.id:*"
    objs = {
        "about": markdown("qapaq-det-mitre-about", "QAPAQ · Cobertura MITRE · resumen", about),
        "techniques": metric("qapaq-det-mitre-techniques", "QAPAQ · Cobertura MITRE · técnicas observadas", q,
                             "Técnicas observadas", metric_agg=agg("1", "cardinality", "metric", field="rule.mitre.id",
                                                                    customLabel="Técnicas observadas")),
        "tactics": metric("qapaq-det-mitre-tactics", "QAPAQ · Cobertura MITRE · tácticas observadas", q, "Tácticas",
                          metric_agg=agg("1", "cardinality", "metric", field="rule.mitre.tactic",
                                         customLabel="Tácticas observadas"), color=TURQUESA),
        "chains": metric("qapaq-det-mitre-chains", "QAPAQ · Cobertura MITRE · cadenas de ataque",
                         "rule.groups:qapaq_attack_chain", "Cadenas QAPAQ", color=CORAL),
        "by_tactic": bars("qapaq-det-mitre-by-tactic", "QAPAQ · Cobertura MITRE · alertas por táctica", q,
                          "rule.mitre.tactic", "Táctica", 14, color=FUCSIA),
        "top_tech": table("qapaq-det-mitre-top-techniques", "QAPAQ · Cobertura MITRE · técnicas observadas", q,
                          [terms("2", "rule.mitre.id", "Técnica", 40), terms("3", "rule.mitre.technique", "Nombre", 1)],
                          [count(), agg("4", "max", "metric", field="rule.level", customLabel="Nivel máx."),
                           agg("5", "cardinality", "metric", field="rule.id", customLabel="Reglas")], per_page=12),
        "timeline": over_time("qapaq-det-mitre-timeline", "QAPAQ · Cobertura MITRE · tácticas en el tiempo", q,
                              terms("3", "rule.mitre.tactic", "Táctica", 8, "group")),
        "matrix": markdown("qapaq-det-mitre-matrix", "QAPAQ · Cobertura MITRE · matriz del repositorio", matrix),
        "gaps": markdown("qapaq-det-mitre-gaps", "QAPAQ · Cobertura MITRE · brechas priorizadas", gap_md),
    }
    layout = [(objs["about"], (0, 0, 24, 14)), (objs["techniques"], (24, 0, 8, 7)), (objs["tactics"], (32, 0, 8, 7)),
              (objs["chains"], (40, 0, 8, 7)), (objs["by_tactic"], (24, 7, 24, 14)),
              (objs["timeline"], (0, 21, 48, 12)), (objs["top_tech"], (0, 33, 24, 18)),
              (objs["matrix"], (24, 33, 24, 18)), (objs["gaps"], (0, 51, 48, 16))]
    return list(objs.values()), dashboard("qapaq-det-dashboard-mitre", "QAPAQ · Cobertura MITRE ATT&CK",
                                          "Técnicas y tácticas observadas en wazuh-alerts-* y cobertura de las reglas QAPAQ del repositorio, con brechas priorizadas.",
                                          layout, "now-30d")


# ----------------------------------------------------------------------------- 2. Vulnerabilidades
def vuln_dashboard():
    snyk_open = "rule.groups:snyk and data.snyk.issue.status:open and data.snyk.issue.ignored:false"
    about = ("## Gestión de vulnerabilidades\n\n"
             "**Infraestructura:** Wazuh Vulnerability Detection sobre el inventario de paquetes de los agentes "
             "(índice de estado `wazuh-states-vulnerabilities-*`, sin filtro de tiempo: es el estado actual).\n\n"
             "**Código:** issues de Snyk (`rule.groups:snyk`, reglas 101450–101458) y **exposición**: crítica/alta "
             "con exploit maduro en un proyecto publicado por Cloudflare (101730–101731, lista "
             "`qapaq-internet-facing-projects`).\n\n"
             "Prioridad QAPAQ: exposición + exploit maduro primero (P1), luego crítica/alta. Runbook: "
             "`docs/detection-engineering/runbooks/vulnerabilidad-expuesta.md`.")
    objs = {
        "about": markdown("qapaq-det-vuln-about", "QAPAQ · Vulnerabilidades · resumen", about),
        "vd_total": metric("qapaq-det-vuln-vd-total", "QAPAQ · Vulnerabilidades · CVE abiertas (agentes)", "", "CVE abiertas",
                           index=VULNS),
        "vd_crit": metric("qapaq-det-vuln-vd-critical", "QAPAQ · Vulnerabilidades · críticas y altas (agentes)",
                          "vulnerability.severity:(Critical or High)", "Críticas y altas", index=VULNS, color=CORAL),
        "snyk_open": metric("qapaq-det-vuln-snyk-open", "QAPAQ · Vulnerabilidades · issues Snyk críticos/altos",
                            f"{snyk_open} and data.snyk.issue.severity:(critical or high)", "Issues",
                            metric_agg=agg("1", "cardinality", "metric", field="data.snyk.issue.id",
                                           customLabel="Issues críticos/altos"), color=FUCSIA),
        "exposed": metric("qapaq-det-vuln-exposed", "QAPAQ · Vulnerabilidades · expuestas con exploit",
                          "rule.groups:qapaq_exposure", "Expuestas con exploit", color=CORAL),
        "vd_sev": pie("qapaq-det-vuln-vd-severity", "QAPAQ · Vulnerabilidades · severidad (agentes)", "",
                      terms("2", "vulnerability.severity", "Severidad", 6, "segment"), index=VULNS, colors=VD_COLORS),
        "vd_cves": table("qapaq-det-vuln-vd-cves", "QAPAQ · Vulnerabilidades · CVE con mayor puntaje",
                         "vulnerability.severity:(Critical or High)",
                         [terms("2", "vulnerability.id", "CVE", 50, order_by="3"),
                          terms("5", "package.name", "Paquete", 1)],
                         [count("Hallazgos"), agg("3", "max", "metric", field="vulnerability.score.base",
                                                  customLabel="CVSS base"),
                          agg("4", "cardinality", "metric", field="agent.name", customLabel="Agentes")],
                         index=VULNS, per_page=12),
        "vd_pkgs": table("qapaq-det-vuln-vd-packages", "QAPAQ · Vulnerabilidades · paquetes a parchar primero", "",
                         [terms("2", "package.name", "Paquete", 25, order_by="3")],
                         [count("Hallazgos"), agg("3", "cardinality", "metric", field="vulnerability.id",
                                                  customLabel="CVE distintas"),
                          agg("4", "max", "metric", field="vulnerability.score.base", customLabel="CVSS máx.")],
                         index=VULNS, per_page=12),
        "vd_agents": bars("qapaq-det-vuln-vd-agents", "QAPAQ · Vulnerabilidades · agentes más expuestos",
                          "vulnerability.severity:(Critical or High)", "agent.name", "Agente", 10, index=VULNS,
                          metric_agg=count("CVE críticas/altas"), color=CORAL),
        "snyk_sev": pie("qapaq-det-vuln-snyk-severity", "QAPAQ · Vulnerabilidades · Snyk por severidad", snyk_open,
                        terms("2", "data.snyk.issue.severity", "Severidad", 4, "segment"), colors=SNYK_COLORS,
                        metric_agg=agg("1", "cardinality", "metric", field="data.snyk.issue.id", customLabel="Issues")),
        "snyk_proj": table("qapaq-det-vuln-snyk-projects", "QAPAQ · Vulnerabilidades · proyectos Snyk", snyk_open,
                           [terms("2", "data.snyk.project.name", "Proyecto", 20, order_by="3")],
                           [count("Eventos"), agg("3", "cardinality", "metric", field="data.snyk.issue.id",
                                                  customLabel="Issues abiertos"),
                            agg("4", "max", "metric", field="rule.level", customLabel="Nivel máx.")]),
        "snyk_mature": search("qapaq-det-vuln-snyk-mature", "QAPAQ · Vulnerabilidades · Snyk con exploit maduro",
                              "rule.groups:snyk and data.snyk.issue.exploit_maturity:Mature",
                              ["rule.level", "rule.description", "data.snyk.issue.severity", "data.snyk.project.name",
                               "data.snyk.issue.package.name"]),
    }
    layout = [(objs["about"], (0, 0, 24, 12)), (objs["vd_total"], (24, 0, 12, 6)), (objs["vd_crit"], (36, 0, 12, 6)),
              (objs["snyk_open"], (24, 6, 12, 6)), (objs["exposed"], (36, 6, 12, 6)),
              (objs["vd_sev"], (0, 12, 16, 13)), (objs["vd_agents"], (16, 12, 32, 13)),
              (objs["vd_cves"], (0, 25, 24, 18)), (objs["vd_pkgs"], (24, 25, 24, 18)),
              (objs["snyk_sev"], (0, 43, 16, 13)), (objs["snyk_proj"], (16, 43, 32, 13)),
              (objs["snyk_mature"], (0, 56, 48, 14))]
    return list(objs.values()), dashboard("qapaq-det-dashboard-vulnerabilities", "QAPAQ · Gestión de vulnerabilidades",
                                          "Wazuh Vulnerability Detection (estado actual por agente) y Snyk (código y dependencias), con exposición a Internet.",
                                          layout, "now-30d")


# ----------------------------------------------------------------------------- 3. Identidad y acceso
def identity_dashboard():
    fail = "rule.groups:(authentication_failed or authentication_failures)"
    ok = "rule.groups:authentication_success"
    priv = "rule.groups:(qapaq_privilege_escalation or qapaq_aws_iam)"
    about = ("## Identidad y acceso\n\n"
             "Inicios de sesión y cambios de privilegio de **Microsoft 365/Entra** (módulo office365, reglas "
             "100502–100530 y 101700–101704), **AWS** (consola e IAM, 101601–101636 y 101710–101713) y **SSH** de los "
             "servidores Linux (sshd, 101750).\n\n"
             "⚠️ M365/Entra está **bloqueado** hasta conceder `ActivityFeed.Read` (backlog BL-I01): sin ese permiso los "
             "paneles de M365 quedan vacíos aunque las reglas estén cargadas.\n\n"
             "Runbooks: `credenciales.md` y `escalada-de-privilegios.md`.")
    objs = {
        "about": markdown("qapaq-det-id-about", "QAPAQ · Identidad · resumen", about),
        "fails": metric("qapaq-det-id-fails", "QAPAQ · Identidad · inicios fallidos", fail, "Inicios fallidos",
                        color=AMARILLO),
        "oks": metric("qapaq-det-id-success", "QAPAQ · Identidad · inicios exitosos", ok, "Inicios exitosos",
                      color=TURQUESA),
        "chains": metric("qapaq-det-id-chains", "QAPAQ · Identidad · accesos tras ataque",
                         "rule.groups:qapaq_attack_chain and rule.groups:qapaq_initial_access", "Accesos tras ataque",
                         color=CORAL),
        "privs": metric("qapaq-det-id-privilege", "QAPAQ · Identidad · cambios de privilegio", priv, "Cambios de privilegio",
                        color=FUCSIA),
        "timeline": over_time("qapaq-det-id-timeline", "QAPAQ · Identidad · accesos en el tiempo", "",
                              filters_split([("Exitosos", ok), ("Fallidos", fail), ("Privilegio", priv),
                                             ("Cadena de ataque", "rule.groups:qapaq_attack_chain")]),
                              colors={"Exitosos": TURQUESA, "Fallidos": AMARILLO, "Privilegio": FUCSIA,
                                      "Cadena de ataque": CORAL}, mode="normal", vtype="line"),
        "by_source": pie("qapaq-det-id-sources", "QAPAQ · Identidad · accesos por fuente", f"{ok} or {fail}",
                         filters_split([("Microsoft 365 / Entra", "rule.groups:office365"),
                                        ("AWS", "rule.groups:aws"), ("SSH Linux", "rule.groups:sshd"),
                                        ("Otros", "not rule.groups:(office365 or aws or sshd)")], "2"),
                         colors={"Microsoft 365 / Entra": AZUL, "AWS": AMARILLO, "SSH Linux": TURQUESA,
                                 "Otros": LAVANDA}),
        "m365_users": table("qapaq-det-id-m365-users", "QAPAQ · Identidad · M365: cuentas con fallos", "rule.id:100502",
                            [terms("2", "data.office365.UserId", "Cuenta", 15)],
                            [count("Fallos"), agg("3", "cardinality", "metric", field="data.office365.ClientIP",
                                                  customLabel="IPs distintas")]),
        "aws_users": table("qapaq-det-id-aws-users", "QAPAQ · Identidad · AWS: principales con fallos",
                           "rule.groups:aws and data.aws.console_login:Failure",
                           [terms("2", "data.aws.principal", "Principal", 15)],
                           [count("Fallos"), agg("3", "cardinality", "metric", field="data.aws.source_ip",
                                                 customLabel="IPs distintas")]),
        "ssh_ips": table("qapaq-det-id-ssh-ips", "QAPAQ · Identidad · SSH: IPs con fallos",
                         f"rule.groups:sshd and {fail}",
                         [terms("2", "data.srcip", "IP de origen", 15)],
                         [count("Fallos"), agg("3", "cardinality", "metric", field="data.dstuser",
                                               customLabel="Usuarios probados"),
                          agg("4", "max", "metric", field="rule.level", customLabel="Nivel máx.")]),
        "priv_rules": table("qapaq-det-id-privilege-rules", "QAPAQ · Identidad · cambios de privilegio por regla", priv,
                            [terms("2", "rule.description", "Regla", 15)],
                            [count(), agg("3", "max", "metric", field="rule.level", customLabel="Nivel máx.")]),
        "latest": search("qapaq-det-id-latest", "QAPAQ · Identidad · últimos eventos de acceso y privilegio",
                         f"({ok} or {fail} or {priv}) and rule.level >= 5",
                         ["rule.level", "rule.description", "data.office365.UserId", "data.aws.principal",
                          "data.dstuser", "data.srcip"]),
    }
    layout = [(objs["about"], (0, 0, 24, 12)), (objs["fails"], (24, 0, 12, 6)), (objs["oks"], (36, 0, 12, 6)),
              (objs["chains"], (24, 6, 12, 6)), (objs["privs"], (36, 6, 12, 6)),
              (objs["timeline"], (0, 12, 32, 14)), (objs["by_source"], (32, 12, 16, 14)),
              (objs["m365_users"], (0, 26, 16, 15)), (objs["aws_users"], (16, 26, 16, 15)),
              (objs["ssh_ips"], (32, 26, 16, 15)), (objs["priv_rules"], (0, 41, 48, 13)),
              (objs["latest"], (0, 54, 48, 16))]
    return list(objs.values()), dashboard("qapaq-det-dashboard-identity", "QAPAQ · Identidad y acceso",
                                          "Inicios de sesión M365/Entra, AWS y SSH, cambios de privilegio y cadenas de compromiso.",
                                          layout)


# ----------------------------------------------------------------------------- 4. Integridad y cumplimiento
def integrity_dashboard():
    fim = "rule.groups:syscheck"
    persist = "rule.id:(101755 or 101756 or 101757 or 101758 or 101759 or 101760)"
    sca = "rule.groups:sca"
    about = ("## Integridad y cumplimiento\n\n"
             "**FIM** (grupo de agentes `linux-servers`): tiempo real sobre `/root/.ssh`, `/etc/ssh`, `sudoers.d`, "
             "`pam.d`, `cron` y `systemd/system`; programado cada 12 h sobre `/etc` y binarios. Las reglas QAPAQ "
             "101755–101760 marcan la persistencia (llaves SSH, unidades, cron, sudo, PAM, sshd).\n\n"
             "**SCA**: benchmark CIS que trae Wazuh para cada sistema (Ubuntu 24.04 en el nodo). Los controles "
             "fallidos alimentan el plan de hardening (docs/16).\n\n"
             "Runbook: `escalada-de-privilegios.md#linux`.")
    objs = {
        "about": markdown("qapaq-det-int-about", "QAPAQ · Integridad · resumen", about),
        "fim": metric("qapaq-det-int-fim", "QAPAQ · Integridad · cambios FIM", fim, "Cambios FIM", color=AZUL),
        "persist": metric("qapaq-det-int-persistence", "QAPAQ · Integridad · persistencia QAPAQ", persist,
                          "Persistencia (101755–101760)", color=CORAL),
        "sca_failed": metric("qapaq-det-int-sca-failed", "QAPAQ · Integridad · controles CIS fallidos",
                             f"{sca} and data.sca.check.result:failed", "Controles fallidos",
                             metric_agg=agg("1", "cardinality", "metric", field="data.sca.check.id",
                                            customLabel="Controles CIS fallidos"), color=FUCSIA),
        "sca_passed": metric("qapaq-det-int-sca-passed", "QAPAQ · Integridad · controles CIS aprobados",
                             f"{sca} and data.sca.check.result:passed", "Controles aprobados",
                             metric_agg=agg("1", "cardinality", "metric", field="data.sca.check.id",
                                            customLabel="Controles CIS aprobados"), color=TURQUESA),
        "fim_time": over_time("qapaq-det-int-fim-timeline", "QAPAQ · Integridad · FIM en el tiempo", fim,
                              terms("3", "syscheck.event", "Evento", 5, "group"),
                              colors={"added": TURQUESA, "modified": AMARILLO, "deleted": CORAL}),
        "fim_paths": table("qapaq-det-int-fim-paths", "QAPAQ · Integridad · rutas más cambiadas", fim,
                           [terms("2", "syscheck.path", "Ruta", 20), terms("3", "agent.name", "Agente", 1)],
                           [count("Cambios"), agg("4", "max", "metric", field="rule.level", customLabel="Nivel máx.")],
                           per_page=12),
        "sca_result": pie("qapaq-det-int-sca-result", "QAPAQ · Integridad · resultado SCA", sca,
                          terms("2", "data.sca.check.result", "Resultado", 4, "segment"),
                          colors={"passed": TURQUESA, "failed": CORAL, "not applicable": LAVANDA},
                          metric_agg=agg("1", "cardinality", "metric", field="data.sca.check.id",
                                         customLabel="Controles")),
        "sca_failed_t": table("qapaq-det-int-sca-failed-checks", "QAPAQ · Integridad · controles CIS fallidos",
                              f"{sca} and data.sca.check.result:failed",
                              [terms("2", "data.sca.check.title", "Control", 25), terms("3", "data.sca.policy", "Política", 1)],
                              [count("Evaluaciones")], per_page=12),
        "pci": bars("qapaq-det-int-pci", "QAPAQ · Integridad · requisitos PCI DSS con alertas", "rule.pci_dss:*",
                    "rule.pci_dss", "Requisito PCI DSS", 12, color=AZUL),
        "nist": bars("qapaq-det-int-nist", "QAPAQ · Integridad · controles NIST 800-53 con alertas",
                     "rule.nist_800_53:*", "rule.nist_800_53", "Control NIST 800-53", 12, color=LIMA),
        "latest": search("qapaq-det-int-latest", "QAPAQ · Integridad · últimos cambios de archivos", fim,
                         ["rule.level", "rule.description", "agent.name", "syscheck.path", "syscheck.event"]),
    }
    layout = [(objs["about"], (0, 0, 24, 12)), (objs["fim"], (24, 0, 12, 6)), (objs["persist"], (36, 0, 12, 6)),
              (objs["sca_failed"], (24, 6, 12, 6)), (objs["sca_passed"], (36, 6, 12, 6)),
              (objs["fim_time"], (0, 12, 32, 13)), (objs["sca_result"], (32, 12, 16, 13)),
              (objs["fim_paths"], (0, 25, 24, 17)), (objs["sca_failed_t"], (24, 25, 24, 17)),
              (objs["pci"], (0, 42, 24, 13)), (objs["nist"], (24, 42, 24, 13)), (objs["latest"], (0, 55, 48, 15))]
    return list(objs.values()), dashboard("qapaq-det-dashboard-integrity", "QAPAQ · Integridad y cumplimiento",
                                          "FIM en tiempo real con persistencia QAPAQ, benchmark CIS (SCA) y requisitos PCI DSS / NIST con alertas.",
                                          layout)


# ----------------------------------------------------------------------------- 5. Threat hunting
HUNTS = [
    ("h01", "H01 · Acceso tras ataque (cadenas QAPAQ)", "rule.groups:qapaq_attack_chain",
     "Un éxito o una acción privilegiada justo después de fuerza bruta, spray o evasión. Pivote: la cuenta/IP en el resto de fuentes 24 h atrás.",
     ["rule.level", "rule.description", "data.office365.UserId", "data.aws.principal", "data.srcip"]),
    ("h02", "H02 · SSH: fallos y éxitos de la misma IP", "rule.groups:sshd and rule.id:(5710 or 5712 or 5716 or 5760 or 5715 or 40112 or 101750)",
     "IPs de Internet que prueban usuarios y luego entran. Ordenar por data.srcip y buscar éxitos (5715/101750).",
     ["rule.id", "rule.description", "data.srcip", "data.dstuser"]),
    ("h03", "H03 · sudo y cambios de grupo privilegiado", "rule.groups:sudo or rule.id:(2960 or 2961 or 101752) or rule.id:(5901 or 5902)",
     "Escalada en Linux: sudo a root de cuentas no administrativas y altas en sudo/docker/lxd.",
     ["rule.description", "agent.name", "data.srcuser", "data.dstuser", "data.command"]),
    ("h04", "H04 · Persistencia Linux por archivos", "rule.id:(101755 or 101756 or 101757 or 101758 or 101759 or 101760) or (rule.groups:syscheck and syscheck.path:(*cron* or *systemd* or *authorized_keys* or *sudoers* or *pam.d*))",
     "Llaves, unidades, cron, sudoers y PAM fuera de un cambio aprobado.",
     ["rule.description", "agent.name", "syscheck.path", "syscheck.event", "syscheck.uname_after"]),
    ("h05", "H05 · Privilegio en la nube (Entra e IAM)", "rule.groups:(qapaq_privilege_escalation or qapaq_aws_iam or azure_ad)",
     "Roles nuevos, políticas administrativas y credenciales en apps/usuarios. Validar contra cambios aprobados.",
     ["rule.level", "rule.description", "data.office365.UserId", "data.office365.ObjectId", "data.aws.principal", "data.aws.event_name"]),
    ("h06", "H06 · Evasión de defensas", "rule.groups:qapaq_defense_evasion",
     "Auditoría, CloudTrail, GuardDuty, WAF o antimalware apagados. Todo hallazgo exige quién, desde dónde y por qué.",
     ["rule.level", "rule.description", "data.aws.principal", "data.cloudflare.audit.actor_email", "data.bitdefender.endpoint.name"]),
    ("h07", "H07 · Exposición explotable", "rule.groups:qapaq_exposure or (rule.groups:snyk and data.snyk.issue.exploit_maturity:Mature) or rule.id:(101513 or 101740)",
     "Vulnerabilidad con exploit maduro + ataques al WAF sobre el mismo servicio = ventana de explotación abierta.",
     ["rule.level", "rule.description", "data.snyk.project.name", "data.cloudflare.firewall.host", "data.cloudflare.firewall.client_ip"]),
    ("h08", "H08 · WAF: IPs y rutas más atacadas", "rule.groups:qapaq_waf",
     "Concentración por IP, ASN y ruta; IPs que pasan en modo log (101511) pueden ser falsos negativos del WAF.",
     ["data.cloudflare.firewall.action", "data.cloudflare.firewall.client_ip", "data.cloudflare.firewall.host", "data.cloudflare.firewall.path", "data.cloudflare.firewall.country"]),
    ("h09", "H09 · Cuentas de emergencia y root", "rule.id:(100530 or 101605 or 101606 or 101711)",
     "Break-glass de Entra y root de AWS: todo uso se revisa (P1 no suprimible).",
     ["rule.level", "rule.description", "data.office365.UserId", "data.aws.source_ip"]),
    ("h10", "H10 · Rootcheck y anomalías del host", "rule.groups:rootcheck or rule.id:(510 or 521)",
     "Archivos ocultos, puertos o binarios troyanizados reportados por rootcheck. 521 es ruidoso: ver Calidad de detección.",
     ["rule.id", "rule.description", "agent.name", "full_log"]),
]


def hunting_dashboard():
    intro = ("## Threat hunting QAPAQ\n\nBúsquedas guardadas con hipótesis. Cada una se abre en **Discover** "
             "(menú del panel → *Ver en Discover*) para pivotar por cuenta, IP o host. Una caza que encuentra algo "
             "termina en **un caso QAPAQ** o en **una regla nueva** (ciclo de docs/detection-engineering/01).\n\n"
             "| Caza | Hipótesis |\n| --- | --- |\n"
             + "\n".join(f"| {t} | {h} |" for _, t, _, h, _ in HUNTS))
    objs = [markdown("qapaq-det-hunt-about", "QAPAQ · Threat hunting · índice", intro)]
    layout = [(objs[0], (0, 0, 48, 18))]
    for i, (hid, title, query, hypothesis, cols) in enumerate(HUNTS):
        s = search(f"qapaq-det-hunt-{hid}", f"QAPAQ · Hunting · {title}", query, cols, description=hypothesis)
        objs.append(s)
        layout.append((s, ((i % 2) * 24, 18 + (i // 2) * 14, 24, 14)))
    return objs, dashboard("qapaq-det-dashboard-hunting", "QAPAQ · Threat hunting",
                           "Diez búsquedas guardadas con hipótesis de caza (H01–H10) sobre wazuh-alerts-*.", layout,
                           "now-30d")


# ----------------------------------------------------------------------------- 6. Calidad de detección
def quality_dashboard():
    about = ("## Calidad de detección\n\n"
             "Mide el contenido, no a las personas. **Ruido** = reglas que más alertas generan sin llegar a incidente; "
             "**fidelidad** = alertas promovidas a incidente / alertas (se calcula en Ayni Qapaq). Objetivos y "
             "revisión semanal en `docs/detection-engineering/03-modelo-operativo.md`.\n\n"
             "Toda regla en el top 10 de volumen con nivel ≥ 7 entra a la revisión de afinamiento (tuning) de la "
             "semana. Las reglas QAPAQ se identifican por `rule.groups:qapaq*`.")
    qapaq = "rule.groups:qapaq*"
    objs = {
        "about": markdown("qapaq-det-q-about", "QAPAQ · Calidad · resumen", about),
        "total": metric("qapaq-det-q-total", "QAPAQ · Calidad · alertas", "", "Alertas"),
        "high": metric("qapaq-det-q-high", "QAPAQ · Calidad · altas y críticas", "rule.level >= 8", "Nivel ≥ 8 (correo QAPAQ)",
                       color=CORAL),
        "rules": metric("qapaq-det-q-rules", "QAPAQ · Calidad · reglas que dispararon", "", "Reglas distintas",
                        metric_agg=agg("1", "cardinality", "metric", field="rule.id", customLabel="Reglas distintas"),
                        color=TURQUESA),
        "qapaqshare": metric("qapaq-det-q-qapaq", "QAPAQ · Calidad · alertas de reglas QAPAQ", qapaq, "Alertas de reglas QAPAQ",
                           color=FUCSIA),
        "noisy": bars("qapaq-det-q-noisy", "QAPAQ · Calidad · reglas más ruidosas", "", "rule.description",
                      "Regla", 15, color=AMARILLO),
        "volume": table("qapaq-det-q-volume", "QAPAQ · Calidad · volumen por regla", "",
                        [terms("2", "rule.id", "ID", 40), terms("3", "rule.description", "Descripción", 1)],
                        [count(), agg("4", "max", "metric", field="rule.level", customLabel="Nivel"),
                         agg("5", "cardinality", "metric", field="agent.name", customLabel="Agentes")], per_page=15),
        "levels": over_time("qapaq-det-q-levels", "QAPAQ · Calidad · volumen por banda de severidad", "", level_split(),
                            colors=LEVEL_COLORS),
        "level_dist": bars("qapaq-det-q-level-dist", "QAPAQ · Calidad · distribución por nivel", "", "rule.level",
                           "Nivel", 16, horizontal=False, color=AZUL),
        "origin": pie("qapaq-det-q-origin", "QAPAQ · Calidad · origen de las alertas", "",
                      filters_split([("Reglas QAPAQ", qapaq), ("Ruleset oficial de Wazuh", f"not {qapaq}")], "2"),
                      colors={"Reglas QAPAQ": FUCSIA, "Ruleset oficial de Wazuh": AZUL}),
        "mitre_share": pie("qapaq-det-q-mitre", "QAPAQ · Calidad · alertas con técnica MITRE", "",
                           filters_split([("Con MITRE", "rule.mitre.id:*"), ("Sin MITRE", "not rule.mitre.id:*")], "2"),
                           colors={"Con MITRE": TURQUESA, "Sin MITRE": LAVANDA}),
    }
    layout = [(objs["about"], (0, 0, 24, 12)), (objs["total"], (24, 0, 12, 6)), (objs["high"], (36, 0, 12, 6)),
              (objs["rules"], (24, 6, 12, 6)), (objs["qapaqshare"], (36, 6, 12, 6)),
              (objs["levels"], (0, 12, 48, 13)), (objs["noisy"], (0, 25, 24, 18)), (objs["volume"], (24, 25, 24, 18)),
              (objs["level_dist"], (0, 43, 24, 13)), (objs["origin"], (24, 43, 12, 13)),
              (objs["mitre_share"], (36, 43, 12, 13))]
    return list(objs.values()), dashboard("qapaq-det-dashboard-quality", "QAPAQ · Calidad de detección",
                                          "Volumen por regla, reglas ruidosas, niveles y proporción de reglas QAPAQ y MITRE.",
                                          layout)


def build() -> list[dict]:
    out = []
    for builder in (mitre_dashboard, vuln_dashboard, identity_dashboard, integrity_dashboard, hunting_dashboard,
                    quality_dashboard):
        objs, dash = builder()
        out += objs + [dash]
    ids = [o["id"] for o in out]
    assert len(ids) == len(set(ids)), "IDs duplicados"
    return out


def main() -> None:
    objects = build()
    with OUT.open("w", encoding="utf-8", newline="\n") as f:
        for obj in objects:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
    dashboards = [o["attributes"]["title"] for o in objects if o["type"] == "dashboard"]
    print(f"{len(objects)} objetos ({len(dashboards)} dashboards) → {OUT.relative_to(ROOT).as_posix()}")
    for d in dashboards:
        print(f"  {d}")


if __name__ == "__main__":
    main()
