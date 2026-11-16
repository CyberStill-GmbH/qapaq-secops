#!/usr/bin/env python3
"""Genera qapaq-provider-dashboards.ndjson: un dashboard de OSD por proveedor integrado.

Bitdefender GravityZone, Snyk y Cloudflare no tienen módulo nativo en la app de Wazuh; sus
alertas llegan a wazuh-alerts-* por los collectors QAPAQ (wazuh/provider-ingestion) y se filtran por
grupo de regla. El de AWS vive aparte (qapaq-aws.ndjson, receptor EventBridge → SNS). Microsoft 365 sí tiene módulo (Cloud security → Office 365); su dashboard QAPAQ lo
complementa con las reglas QAPAQ 100502–100530.

Cada dashboard: nota de la integración, eventos, severidad en el tiempo, top de entidades, top de
reglas y tabla de los últimos eventos. IDs estables (`qapaq-*`): importar con overwrite es
idempotente. Uso:

    python3 wazuh/dashboard/saved-objects/build_provider_dashboards.py

y se importa con infra/aws-poweruser/scripts/bootstrap-wazuh-app.sh (global tenant).
"""

from __future__ import annotations

import json
import pathlib

INDEX_PATTERN = "wazuh-alerts-*"
INDEX_REF = "kibanaSavedObjectMeta.searchSourceJSON.index"
OSD_VERSION = "2.19.6"
# Rangos de rule.level (baja 0–3, media 4–7, alta 8–11, crítica 12–15). Sin `label`: OSD 2.19 envía
# los rangos tal cual al Indexer y `label` no es un campo de la agregación range de OpenSearch
# (x_content_parse_exception «[range] failed to parse field [ranges]» y el panel queda en error).

# Logotipo oficial del proveedor en la nota de cada panel (uso nominativo; fuentes y titulares en
# wazuh/dashboard/assets/svg/vendors/NOTICE.md). El tema del dashboard es oscuro: Snyk usa su
# variante monocroma clara para tener contraste.
LOGO_PATH = "/ui/qapaq/vendors"
LOGOS = {
    "bitdefender": "bitdefender.svg",
    "snyk": "snyk-on-dark.svg",
    "cloudflare": "cloudflare.svg",
    "microsoft-365": "microsoft-entra-id.svg",
    "sharepoint": "microsoft-entra-id.svg",
}
LOGO_ALT = {
    "bitdefender": "Bitdefender",
    "snyk": "Snyk",
    "cloudflare": "Cloudflare",
    "microsoft-365": "Microsoft Entra ID",
    "sharepoint": "Microsoft 365",
}

PROVIDERS = [
    {
        "id": "bitdefender",
        "title": "QAPAQ · Bitdefender GravityZone",
        "query": "rule.groups:bitdefender",
        "rules": "101400–101411",
        "about": "Estado de protección de los endpoints (infección, aislamiento, módulos deshabilitados, "
        "firmas y agente desactualizados) y cuarentena. Collector `qapaq-collector-bitdefender` cada 10 min. "
        "Monitor-only: QAPAQ no ejecuta acciones en GravityZone.",
        "entity": ("data.bitdefender.endpoint.name", "Endpoint"),
        "unique": ("data.bitdefender.endpoint.id", "Endpoints con hallazgos"),
        "columns": ["rule.level", "rule.description", "data.bitdefender.endpoint.name",
                    "data.bitdefender.endpoint.policy_name"],
    },
    {
        "id": "snyk",
        "title": "QAPAQ · Snyk",
        "query": "rule.groups:snyk",
        "rules": "101450–101458",
        "about": "Vulnerabilidades de dependencias y código por proyecto. Un evento por cambio de issue "
        "(collector `qapaq-collector-snyk` cada 15 min). Crítica nivel 12 (13 con exploit maduro), alta 10, "
        "media 5, baja 3; resueltos e ignorados en nivel 2.",
        "entity": ("data.snyk.project.name", "Proyecto"),
        "unique": ("data.snyk.issue.id", "Issues distintos"),
        "columns": ["rule.level", "data.snyk.issue.severity", "data.snyk.issue.title",
                    "data.snyk.issue.package.name", "data.snyk.project.name"],
    },
    {
        "id": "cloudflare",
        "title": "QAPAQ · Cloudflare",
        "query": "rule.groups:cloudflare",
        "rules": "101500–101513",
        "about": "Eventos del WAF por zona (bloqueos, desafíos, solo-log) y audit logs de la cuenta "
        "(DNS, controles de seguridad, credenciales). Collector `qapaq-collector-cloudflare` cada 5 min.",
        "entity": ("data.cloudflare.zone_name", "Zona"),
        "unique": ("data.cloudflare.firewall.client_ip", "IPs de cliente en el WAF"),
        "extra": ("data.cloudflare.firewall.client_ip", "IP de cliente (WAF)"),
        "columns": ["rule.level", "rule.description", "data.cloudflare.firewall.action",
                    "data.cloudflare.firewall.client_ip", "data.cloudflare.audit.actor_email"],
    },
    {
        "id": "microsoft-365",
        "title": "QAPAQ · Microsoft 365",
        "query": "rule.groups:office365",
        "rules": "100502–100530",
        "about": "Auditoría unificada de Entra ID, Exchange, SharePoint y General mediante el módulo "
        "office365 de Wazuh. El mapamundi muestra ubicaciones solo cuando los eventos incluyen GeoIP "
        "verificado.",
        "entity": ("data.office365.UserId", "Usuario"),
        "unique": ("data.office365.UserId", "Usuarios distintos"),
        "extra": ("data.office365.Operation", "Operación"),
        "columns": ["rule.level", "rule.description", "data.office365.UserId",
                    "data.office365.Operation", "data.office365.ClientIP"],
    },
    {
        "id": "sharepoint",
        "dashboard_id": "qapaq-dashboard-sharepoint-onedrive",
        "title": "QAPAQ · SharePoint y OneDrive",
        "query": "rule.groups:qapaq_sharepoint",
        "rules": "101900–101979",
        "about": "Auditoría de actividad de archivos y postura de uso compartido. La auditoría usa "
        "el módulo office365 o Purview Audit Search; el collector queda apagado hasta validar permisos.",
        "entity": ("data.office365.UserId", "Usuario"),
        "unique": ("data.office365.UserId", "Usuarios distintos"),
        "extra": ("data.qapaq.event_type", "Tipo de evento"),
        "columns": ["rule.level", "rule.description", "data.office365.UserId",
                    "data.office365.Operation", "data.sharepoint.site.url", "data.qapaq.event_type"],
    },
]


def search_source(query: str) -> str:
    return json.dumps(
        {"query": {"query": query, "language": "kuery"}, "filter": [], "indexRefName": INDEX_REF},
        ensure_ascii=False,
    )


def index_reference() -> list[dict]:
    return [{"name": INDEX_REF, "type": "index-pattern", "id": INDEX_PATTERN}]


def count_metric() -> dict:
    return {"id": "1", "enabled": True, "type": "count", "params": {}, "schema": "metric"}


def visualization(
    vid: str, title: str, vis_type: str, aggs: list, params: dict, query: str | None,
    description: str = "",
):
    attributes = {
        "title": title,
        "visState": json.dumps(
            {"title": title, "type": vis_type, "aggs": aggs, "params": params}, ensure_ascii=False
        ),
        "uiStateJSON": "{}",
        "description": description,
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


def markdown(vid: str, title: str, text: str, description: str = ""):
    return visualization(
        vid,
        title,
        "markdown",
        [],
        {"fontSize": 12, "openLinksInNewTab": False, "markdown": text},
        None,
        description,
    )


def metric(
    vid: str, title: str, query: str, agg: dict | None = None, label: str = "Eventos",
    description: str = "",
):
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
    return visualization(vid, title, "metric", aggs, params, query, description)


def severity_over_time(vid: str, title: str, query: str, description: str = ""):
    aggs = [
        {**count_metric(), "params": {"customLabel": "Eventos"}},
        {
            "id": "2",
            "enabled": True,
            "type": "date_histogram",
            "params": {"field": "timestamp", "useNormalizedOpenSearchInterval": True,
                       "interval": "auto", "drop_partials": False, "min_doc_count": 1,
                       "extended_bounds": {}},
            "schema": "segment",
        },
        {
            "id": "3",
            "enabled": True,
            "type": "terms",
            "params": {"field": "rule.level", "orderBy": "_key", "order": "desc", "size": 16,
                       "otherBucket": False, "otherBucketLabel": "Otros", "missingBucket": False,
                       "missingBucketLabel": "Sin dato", "customLabel": "Nivel de regla"},
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
    return visualization(vid, title, "histogram", aggs, params, query, description)


def top_table(
    vid: str, title: str, query: str, field: str, label: str, size: int = 10,
    description: str = "",
):
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
    return visualization(vid, title, "table", aggs, params, query, description)


def saved_search(sid: str, title: str, query: str, columns: list[str], description: str = ""):
    return {
        "id": sid,
        "type": "search",
        "attributes": {
            "title": title,
            "description": description,
            "hits": 0,
            "columns": columns,
            "sort": [["timestamp", "desc"]],
            "version": 1,
            "kibanaSavedObjectMeta": {"searchSourceJSON": search_source(query)},
        },
        "references": index_reference(),
    }


def verified_locations_map(mid: str, title: str, query: str):
    """Map saved object using only verified GeoIP geopoints; empty until enrichment exists."""
    layer = mid + "-layer"
    index_ref = mid + "-index"
    map_state = {
        "zoom": 2,
        "center": {"lon": 0, "lat": 20},
        "timeFilters": {"from": "now-7d", "to": "now"},
        "refreshConfig": {"isPaused": True, "interval": 0},
        "query": {"query": "", "language": "kuery"},
        "filters": [],
        "settings": {"autoFitToDataBounds": True, "backgroundColor": "#ffffff",
                     "disableInteractive": False, "hideLayerControl": False,
                     "initialLocation": "AUTO_FIT_TO_BOUNDS", "maxZoom": 24, "minZoom": 0,
                     "showScaleControl": False, "showSpatialFilters": True},
    }
    layers = [
        {"sourceDescriptor": {"type": "EMS_TMS", "isAutoSelect": True},
         "id": mid + "-basemap", "label": "Mapamundi", "minZoom": 0,
         "maxZoom": 24, "alpha": 1, "visible": True,
         "style": {"type": "TILE"}, "type": "VECTOR_TILE"},
        {"sourceDescriptor": {"geoField": "data.office365.geoip.location", "scalingType": "CLUSTERS",
                               "topHitsSplitField": "", "topHitsSize": 1,
                               "id": mid + "-geopoints", "type": "ES_SEARCH",
                               "applyGlobalQuery": True, "applyGlobalTime": True,
                               "tooltipProperties": ["data.office365.Operation"],
                               "sortField": "", "sortOrder": "desc",
                               "indexPatternRefName": index_ref},
         "id": layer, "label": "Ubicaciones GeoIP verificadas",
         # GeoIP is not mapped in the current alerts index; keep the data layer disabled so
         # the saved map remains importable without inventing coordinates or querying an
         # unmapped field. Enable only after geoip.location is verified as geo_point.
         "minZoom": 0, "maxZoom": 24, "alpha": 0.75, "visible": False,
         "style": {"type": "VECTOR", "properties": {}}, "type": "VECTOR",
         "joins": [], "query": {"query": f"({query}) and data.office365.geoip.location:*", "language": "kuery"}},
    ]
    return {
        "id": mid, "type": "map",
        "attributes": {"title": title,
                       "description": "Mapamundi base. La capa de eventos queda desactivada hasta verificar "
                                      "data.office365.geoip.location como geo_point en wazuh-alerts-*; no se derivan "
                                      "ubicaciones de IP.",
                       "layerListJSON": json.dumps(layers),
                       "mapStateJSON": json.dumps(map_state),
                       "uiStateJSON": json.dumps({"isLayerTOCOpen": True,
                                                  "openTOCDetails": [layer]})},
        "references": [{"id": INDEX_PATTERN, "name": index_ref,
                         "type": "index-pattern"}],
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
        "id": provider.get("dashboard_id", f"qapaq-dashboard-{provider['id']}"),
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
    objects: list[dict] = []
    for provider in PROVIDERS:
        pid, query, name = provider["id"], provider["query"], provider["title"]
        prefix = f"qapaq-{pid}"
        entity_field, entity_label = provider["entity"]
        unique_field, unique_label = provider["unique"]
        note = markdown(
            f"{prefix}-about",
            f"{name} · integración",
            f"### ![{LOGO_ALT[pid]}]({LOGO_PATH}/{LOGOS[pid]}) {name[6:]}\n\n{provider['about']}\n\n"
            f"**Reglas Wazuh:** {provider['rules']} · **Filtro:** `{query}` · "
            f"Estado y permisos en **QAPAQ SecOps → Integraciones**.",
            description="Contexto de la fuente, cobertura de eventos y referencia de reglas.",
        )
        events = metric(
            f"{prefix}-events", f"{name} · eventos", query,
            description="Total de alertas de esta fuente en el intervalo de tiempo seleccionado.",
        )
        unique = metric(
            f"{prefix}-unique",
            f"{name} · {unique_label.lower()}",
            query,
            {"id": "1", "enabled": True, "type": "cardinality",
             "params": {"field": unique_field, "customLabel": unique_label}, "schema": "metric"},
            description=f"Número de {unique_label.lower()} en el intervalo de tiempo seleccionado.",
        )
        high = metric(
            f"{prefix}-high",
            f"{name} · altas y críticas",
            f"({query}) and rule.level >= 8",
            label="Altas y críticas (nivel ≥ 8)",
            description="Alertas con nivel Wazuh 8 o superior; prioriza hallazgos altos y críticos.",
        )
        timeline = severity_over_time(
            f"{prefix}-severity", f"{name} · severidad en el tiempo", query,
            description="Evolución de los eventos a lo largo del tiempo, separada por nivel de regla Wazuh.",
        )
        entities = top_table(f"{prefix}-top-entities", f"{name} · top {entity_label.lower()}",
                             query, entity_field, entity_label,
                             description=f"Agrupa los eventos por {entity_label.lower()} y ordena por volumen; muestra el nivel máximo para priorizar.")
        rules = top_table(f"{prefix}-top-rules", f"{name} · top reglas", query,
                          "rule.description", "Regla",
                          description="Reglas que más eventos generaron; muestra también el nivel Wazuh máximo.")
        latest = saved_search(f"{prefix}-latest", f"{name} · últimos eventos", query,
                              provider["columns"],
                              description="Eventos más recientes primero, con los campos principales para iniciar el triage.")
        panels = [
            (note, {"x": 0, "y": 0, "w": 24, "h": 9}),
            (events, {"x": 24, "y": 0, "w": 8, "h": 9}),
            (unique, {"x": 32, "y": 0, "w": 8, "h": 9}),
            (high, {"x": 40, "y": 0, "w": 8, "h": 9}),
            (timeline, {"x": 0, "y": 9, "w": 48, "h": 13}),
            (entities, {"x": 0, "y": 22, "w": 24, "h": 14}),
            (rules, {"x": 24, "y": 22, "w": 24, "h": 14}),
        ]
        extra = provider.get("extra")
        y = 36
        built = [note, events, unique, high, timeline, entities, rules]
        if extra:
            extra_table = top_table(f"{prefix}-top-extra", f"{name} · top {extra[1].lower()}",
                                    query, extra[0], extra[1],
                                    description=f"Valores de {extra[1].lower()} más frecuentes en los eventos del periodo.")
            panels.append((extra_table, {"x": 0, "y": y, "w": 48, "h": 12}))
            built.append(extra_table)
            y += 12
        # No geolocation is inferred from a raw IP. Keep the map area visible until the
        # alerts index has a verified GeoIP geo_point and the Maps plugin is confirmed.
        if pid in {"microsoft-365", "sharepoint"}:
            geo = verified_locations_map(
                f"{prefix}-verified-map",
                f"{name} · mapamundi de ubicaciones verificadas",
                query,
            )
            # El objeto `map` de OSD 2.19 usa layerList/mapState/uiState (no *JSON) y su import
            # falla: un panel que apunta a un mapa inexistente rompe el dashboard con
            # «"undefined" is not valid JSON». Hasta tener GeoIP verificado solo va el estado vacío.
            del geo
            empty_state = markdown(
                f"{prefix}-verified-map-empty",
                f"{name} · estado del mapamundi",
                "### Estado del mapamundi\n\n"
                "**Sin ubicaciones verificables por ahora.** `wazuh-alerts-*` no expone actualmente "
                "`data.office365.geoip.location` como `geo_point` para estos eventos. El mapa solo muestra registros "
                "con GeoIP confiable; nunca deriva coordenadas a partir de una IP.\n\n"
                "Para habilitar datos: incorporar enriquecimiento GeoIP confiable y mapear el campo "
                "`data.office365.geoip.location` como `geo_point`. Confirmar que Maps está disponible en la imagen "
                "Wazuh Dashboard 4.14.8.",
                description="Explica cuándo el mapamundi podrá mostrar eventos con ubicaciones GeoIP verificadas.",
            )
            panels.append((empty_state, {"x": 0, "y": y + 16, "w": 48, "h": 8}))
            built.append(empty_state)
            y += 24
        panels.append((latest, {"x": 0, "y": y, "w": 48, "h": 18}))
        built.append(latest)
        objects.extend(built)
        objects.append(dashboard(provider, panels))
    return objects


def main() -> None:
    target = pathlib.Path(__file__).with_name("qapaq-provider-dashboards.ndjson")
    lines = [json.dumps(obj, ensure_ascii=False, sort_keys=True) for obj in build()]
    target.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    print(f"{target.name}: {len(lines)} objetos")


if __name__ == "__main__":
    main()
