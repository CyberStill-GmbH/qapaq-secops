#!/usr/bin/env python3
"""QAPAQ · qué partes del monitoreo de SharePoint/OneDrive puede servir la app de Entra (solo lectura).

Hace únicamente llamadas GET (más la emisión de tokens) e imprime **código HTTP y conteos**: nunca
secretos, tokens, nombres de sitios, usuarios ni cuerpos de respuesta.

    python3 check_sharepoint_access.py                       # secretos en /opt/qapaq/secrets/collectors
    python3 check_sharepoint_access.py --env-file .env        # TENANT_ID/CLIENT_ID/CLIENT_SECRET (desarrollo)
    python3 check_sharepoint_access.py --json                 # salida para máquinas

Sale 0 si al menos una vía de auditoría (módulo office365 o Purview Audit Search) está disponible, 2 si no.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
import urllib.parse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from m365_graph import (  # noqa: E402
    FEATURES,
    GRAPH_SCOPE,
    MANAGE,
    MANAGE_SCOPE,
    Credentials,
    Graph,
    ProviderError,
    TokenCache,
    feature_status,
)

LEAST_PRIVILEGE = [
    ("Office 365 Management APIs", "ActivityFeed.Read", "Audit.SharePoint (y Entra/Exchange/General) por el módulo office365"),
    ("Office 365 Management APIs", "ActivityFeed.ReadDlp", "Opcional: coincidencias DLP de SharePoint/OneDrive (DLP.All)"),
    ("Microsoft Graph", "AuditLogsQuery-SharePoint.Read.All", "Alternativa sin ActivityFeed: Purview Audit Search de SharePoint"),
    ("Microsoft Graph", "AuditLogsQuery-OneDrive.Read.All", "Alternativa sin ActivityFeed: Purview Audit Search de OneDrive"),
    ("Microsoft Graph", "SharePointTenantSettings.Read.All", "Postura: configuración de uso compartido del tenant"),
    ("Microsoft Graph", "Sites.Read.All", "Postura: inventario de sitios y enlaces anónimos/externos"),
    ("Microsoft Graph", "User.Read.All", "Enriquecimiento: cuentas deshabilitadas e invitados (ya concedido)"),
]


def probe(graph: Graph, method_url: str, scope: str = GRAPH_SCOPE, headers: dict | None = None,
          count_key: str | None = None) -> dict:
    """GET once; returns {status, count?}. Never returns payload content."""
    try:
        status, payload = graph.call("GET", method_url, scope=scope, headers=headers, ok=(200,))
    except ProviderError as error:
        return {"status": error.status or 0}
    out: dict = {"status": status}
    if isinstance(payload, dict):
        if count_key and isinstance(payload.get(count_key), int):
            out["count"] = payload[count_key]
        elif isinstance(payload.get("value"), list):
            out["count"] = len(payload["value"])
            out["more"] = bool(payload.get("@odata.nextLink"))
    elif isinstance(payload, list):
        out["count"] = len(payload)
    return out


def run(credentials: Credentials) -> dict:
    tokens = TokenCache(credentials)
    graph = Graph(tokens)
    report: dict = {"tokens": {}, "features": {}, "probes": {}}
    roles: dict[str, list[str]] = {}
    for key, scope in (("graph", GRAPH_SCOPE), ("manage", MANAGE_SCOPE)):
        status, granted = tokens.roles(scope)
        roles[key] = granted
        report["tokens"][key] = {"status": status, "roles": granted}
    for name in FEATURES:
        enabled, missing = feature_status(name, roles)
        report["features"][name] = {"label": FEATURES[name]["label"], "granted": enabled, "missing": missing}

    tenant = urllib.parse.quote(credentials.tenant, safe="")
    p = report["probes"]
    if report["tokens"]["manage"]["status"] == 200:
        subs = probe(graph, f"{MANAGE}/api/v1.0/{tenant}/activity/feed/subscriptions/list", scope=MANAGE_SCOPE)
        p["manage_subscriptions_list"] = subs
    if report["tokens"]["graph"]["status"] == 200:
        p["graph_v1_auditlog_queries"] = probe(graph, "/v1.0/security/auditLog/queries?$top=1")
        p["graph_beta_auditlog_queries"] = probe(graph, "/beta/security/auditLog/queries?$top=1")
        p["graph_admin_sharepoint_settings"] = probe(graph, "/v1.0/admin/sharepoint/settings")
        p["graph_sites_getallsites"] = probe(graph, "/v1.0/sites/getAllSites?$top=200&$select=id,createdDateTime")
        p["graph_sites_search"] = probe(graph, "/v1.0/sites?search=*&$top=200&$select=id")
        p["graph_root_site"] = probe(graph, "/v1.0/sites/root?$select=id")
        eventual = {"ConsistencyLevel": "eventual"}
        p["graph_users_disabled"] = probe(
            graph, "/v1.0/users?$filter=accountEnabled%20eq%20false&$count=true&$top=1&$select=id",
            headers=eventual, count_key="@odata.count")
        p["graph_users_guests"] = probe(
            graph, "/v1.0/users?$filter=userType%20eq%20'Guest'&$count=true&$top=1&$select=id",
            headers=eventual, count_key="@odata.count")
    native = report["features"]["audit_native"]["granted"]
    graph_audit = report["features"]["audit_graph_sharepoint"]["granted"]
    report["audit_path"] = "native" if native else ("graph" if graph_audit else "blocked")
    report["least_privilege"] = [{"api": a, "permission": r, "why": w} for a, r, w in LEAST_PRIVILEGE]
    return report


def render(report: dict) -> str:
    lines = []
    for key, info in report["tokens"].items():
        lines.append(f"token {key}: HTTP {info['status']}; roles={','.join(info['roles']) or '(ninguno)'}")
    lines.append("funciones:")
    for name, info in report["features"].items():
        state = "OK" if info["granted"] else "FALTA " + ", ".join(info["missing"])
        lines.append(f"  {name:<24} {state:<45} {info['label']}")
    lines.append("sondeos (GET, solo código y conteo):")
    for name, info in report["probes"].items():
        extra = f" count={info['count']}{'+' if info.get('more') else ''}" if "count" in info else ""
        lines.append(f"  {name:<34} HTTP {info['status']}{extra}")
    lines.append(f"vía de auditoría SharePoint/OneDrive: {report['audit_path']}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--secrets", type=pathlib.Path, default=pathlib.Path("/opt/qapaq/secrets/collectors"))
    parser.add_argument("--env-file", type=pathlib.Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        credentials = Credentials.from_env_file(args.env_file) if args.env_file else Credentials.from_dir(args.secrets)
        report = run(credentials)
    except ProviderError as error:
        print(f"check_sharepoint_access: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=1) if args.json else render(report))
    return 0 if report["audit_path"] != "blocked" else 2


if __name__ == "__main__":
    raise SystemExit(main())
