#!/usr/bin/env python3
"""QAPAQ · SharePoint y OneDrive → JSONL para Wazuh (solo lectura). docs/23-sharepoint-onedrive.md.

Dos modos, cada uno con su timer, estado y JSONL (el driver común hace checkpoint write-ahead y fsync):

``audit``   Actividad de SharePoint/OneDrive. Vía elegida según los permisos del token (``mode: auto``):
            - ``native``: la app tiene ``ActivityFeed.Read`` → el módulo ``office365`` de Wazuh ya lee
              ``Audit.SharePoint``; este collector no duplica y solo informa la capacidad.
            - ``graph``: la app tiene ``AuditLogsQuery-SharePoint.Read.All`` / ``AuditLogsQuery.Read.All``
              → Purview Audit Search (``/security/auditLog/queries``): crea una consulta por ventana
              ``[cursor - solape, ahora - demora]``, la sondea en cada ejecución y pagina los registros.
              Deduplica por id de registro, resume la paginación tras un corte y emite cada registro con la
              MISMA forma que el módulo office365 (``integration: office365`` + ``office365.*`` = auditData),
              así las reglas oficiales 0755, las QAPAQ 100515 y las de SharePoint 1019xx aplican igual.
            - ``blocked``: sin permisos → evento de capacidad (regla 101969/101970) y nada más.
            Enriquecimiento QAPAQ (``qapaq.*``): fuera de horario QAPAQ, red nueva para el usuario (línea base),
            cuenta deshabilitada (Graph ``User.Read.All``) e invitado.
``posture`` Postura periódica: configuración de uso compartido del tenant (``/admin/sharepoint/settings``,
            diff contra la foto anterior con dirección weakened/strengthened), inventario de sitios
            (``/sites/getAllSites``: sitios nuevos) y enlaces anónimos/externos en las bibliotecas
            (recorrido acotado y rotativo; solo pide ``/permissions`` de los ítems con faceta ``shared``).

Contrato de errores: mensajes genéricos y como mucho el código HTTP; nunca secretos ni cuerpos.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import pathlib
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "common"))
from qapaq_collector import ProviderError, bounded_ids, iso, parse_iso, run_collector, utc_now  # noqa: E402
from m365_graph import (  # noqa: E402
    GRAPH_SCOPE,
    MANAGE_SCOPE,
    Credentials,
    Graph,
    TokenCache,
    feature_status,
)

# auditLogRecordType (Graph v1.0 $metadata, namespace microsoft.graph.security) → RecordType numérico
# del esquema de la Management Activity API, que usan las reglas oficiales 0755 de Wazuh.
RECORD_TYPES = {
    "SharePoint": 4, "SharePointFileOperation": 6, "OneDrive": 7, "ComplianceDLPSharePoint": 11,
    "SharePointSharingOperation": 14, "ComplianceDLPSharePointClassification": 33,
    "SharePointListOperation": 36, "SensitivityLabelAction": 83, "SensitivityLabeledFileAction": 84,
    "SharePointAppPermissionOperation": 205,
}
SHAREPOINT_TYPES = ["SharePoint", "SharePointFileOperation", "SharePointSharingOperation"]
ONEDRIVE_TYPES = ["OneDrive"]
# Solo con AuditLogsQuery.Read.All (los permisos acotados por servicio no cubren DLP ni etiquetas).
WIDE_TYPES = ["ComplianceDLPSharePoint", "SensitivityLabelAction", "SensitivityLabeledFileAction",
              "SharePointAppPermissionOperation"]
TERMINAL_FAILED = {"failed", "cancelled"}
SEEN_LIMIT = 20000
FINDINGS_LIMIT = 20000
CAPABILITY_REPEAT = timedelta(hours=24)
INTERNAL_NETS = [ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10",
                                                    "fc00::/7")]

# Configuración del tenant: orden de permisividad (mayor índice = más permisivo = más débil).
SHARING_ORDER = ["disabled", "existingExternalUserSharingOnly", "externalUserSharingOnly", "externalUserAndGuestSharing"]
DOMAIN_MODE_ORDER = ["allowList", "blockList", "none"]
WEAK_WHEN_TRUE = {"isResharingByExternalUsersEnabled", "isLegacyAuthProtocolsEnabled", "isSiteCreationEnabled",
                  "isSiteCreationUIEnabled", "isLoopEnabled"}
WEAK_WHEN_FALSE = {"isRequireAcceptingUserToMatchInvitedUserEnabled", "isUnmanagedSyncAppForTenantRestricted"}
TENANT_KEYS = sorted({"sharingCapability", "sharingDomainRestrictionMode", "sharingAllowedDomainList",
                      "sharingBlockedDomainList", "allowedDomainGuidsForSyncApp", "excludedFileExtensionsForSyncApp",
                      "idleSessionSignOut", "deletedUserPersonalSiteRetentionPeriodInDays", "isMacSyncAppEnabled",
                      "isSyncButtonHiddenOnPersonalSite"} | WEAK_WHEN_TRUE | WEAK_WHEN_FALSE)


def text(value) -> str:
    return "" if value is None else str(value)


def flag(value: bool) -> str:
    """Wazuh compara cadenas: los booleanos QAPAQ se emiten como "true"/"false"."""
    return "true" if value else "false"


def digest(*parts: str, size: int = 24) -> str:
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()[:size]


# =========================================================================== capacidad / permisos


def token_roles(tokens: TokenCache) -> dict[str, list[str]]:
    roles = {}
    for key, scope in (("graph", GRAPH_SCOPE), ("manage", MANAGE_SCOPE)):
        status, granted = tokens.roles(scope)
        if status not in (200,) and key == "graph":
            raise ProviderError("token for Microsoft Graph rejected", status)
        roles[key] = granted
    return roles


def capability_events(source: str, features: dict[str, tuple[bool, list[str]]], state: dict, now: datetime) -> list[dict]:
    """Un evento por función cuando cambia su estado y como recordatorio cada 24 h."""
    previous = state.get("capabilities") or {}
    last = state.get("capabilities_emitted_at")
    repeat = not last or now - parse_iso(last) >= CAPABILITY_REPEAT
    events = []
    for feature, (enabled, missing) in sorted(features.items()):
        status = "enabled" if enabled else "blocked"
        before = previous.get(feature)
        if before == status and not repeat:
            continue
        events.append({
            "qapaq": {"vendor": "m365", "source": source, "event_type": "capability", "collected_at": iso(now),
                    "capability": {"feature": feature, "status": status, "previous": before or "unknown",
                                   "missing": ",".join(missing), "changed": flag(before is not None and before != status)}},
        })
    return events


def remember_capabilities(state: dict, features: dict, events: list[dict], now: datetime) -> None:
    state["capabilities"] = {name: "enabled" if ok else "blocked" for name, (ok, _missing) in features.items()}
    if events:
        state["capabilities_emitted_at"] = iso(now)


# =========================================================================== auditoría


class Enricher:
    """Contexto QAPAQ sobre cada registro: horario, red nueva, cuenta deshabilitada, invitado."""

    def __init__(self, config: dict, state: dict, disabled: set[str]) -> None:
        hours = config.get("business_hours") or {}
        self.offset = timedelta(hours=float(hours.get("utc_offset_hours", -5)))  # Lima, sin horario de verano
        self.start, self.end = int(hours.get("start", 8)), int(hours.get("end", 20))
        self.weekend_off = bool(hours.get("weekend_is_after_hours", True))
        self.baseline_days = int(config.get("baseline_days", 30))
        self.warmup_days = int(config.get("baseline_warmup_days", 7))
        self.max_prefixes = int(config.get("baseline_max_prefixes_per_user", 40))
        self.max_users = int(config.get("baseline_max_users", 5000))
        self.baseline: dict = state.get("ip_baseline") or {}
        self.disabled = disabled

    def after_hours(self, created: datetime) -> bool:
        local = created + self.offset
        if self.weekend_off and local.weekday() >= 5:
            return True
        return not self.start <= local.hour < self.end

    @staticmethod
    def prefix(ip: str) -> str | None:
        raw = ip.strip().strip("[]")
        if raw.count(":") == 1 and "." in raw:  # IPv4 con puerto
            raw = raw.split(":")[0]
        try:
            address = ipaddress.ip_address(raw)
        except ValueError:
            return None
        # Redes internas (RFC 1918, ULA, loopback, link-local) no aportan señal de origen.
        if address.is_loopback or address.is_link_local or any(address in net for net in INTERNAL_NETS):
            return None
        bits = 24 if address.version == 4 else 48
        return str(ipaddress.ip_network(f"{address}/{bits}", strict=False))

    def first_seen(self, user: str, ip: str, created: datetime) -> bool:
        net = self.prefix(ip)
        if not user or not net:
            return False
        key = digest(user.lower(), size=16)
        entry = self.baseline.get(key)
        stamp = iso(created)
        if entry is None:
            if len(self.baseline) >= self.max_users:
                return False
            self.baseline[key] = {"since": stamp, "nets": {net: stamp}}
            return False
        nets = entry.setdefault("nets", {})
        known = net in nets
        if not known or nets[net] < stamp:
            nets[net] = stamp
        if len(nets) > self.max_prefixes:
            for old in sorted(nets, key=nets.get)[: len(nets) - self.max_prefixes]:
                del nets[old]
        warmed = created - parse_iso(entry["since"]) >= timedelta(days=self.warmup_days)
        return warmed and not known

    def prune(self, now: datetime) -> dict:
        horizon = iso(now - timedelta(days=self.baseline_days))
        out = {}
        for key, entry in self.baseline.items():
            nets = {net: seen for net, seen in (entry.get("nets") or {}).items() if seen >= horizon}
            if nets:
                out[key] = {"since": entry["since"], "nets": nets}
        return out

    def context(self, record: dict, created: datetime) -> dict:
        user = text(record.get("UserId"))
        lowered = user.lower()
        guest = "#ext#" in lowered or lowered.startswith("urn:spo:guest")
        return {
            "after_hours": flag(self.after_hours(created)),
            "ip_first_seen": flag(self.first_seen(user, text(record.get("ClientIP")), created)),
            "user_disabled": flag(bool(lowered) and lowered in self.disabled),
            "user_guest": flag(guest),
            "local_hour": str((created + self.offset).hour),
        }


def disabled_users(graph: Graph, state: dict, config: dict, now: datetime, users_ok: bool) -> set[str]:
    """UPN en minúsculas de cuentas deshabilitadas (refresco cada ``disabled_refresh_hours``)."""
    cache = state.get("disabled_users") or {}
    refreshed = cache.get("refreshed_at")
    hours = float(config.get("disabled_refresh_hours", 6))
    if users_ok and (not refreshed or now - parse_iso(refreshed) >= timedelta(hours=hours)):
        names = sorted({
            text(user.get("userPrincipalName")).lower()
            for user in graph.pages("/v1.0/users?$filter=accountEnabled%20eq%20false&$select=userPrincipalName&$top=999",
                                    max_pages=20)
            if user.get("userPrincipalName")
        })
        cache = {"refreshed_at": iso(now), "upns": names}
        state["disabled_users"] = cache
    return set(cache.get("upns") or [])


def record_types(roles: list[str], config: dict) -> list[str]:
    if config.get("record_types"):
        return list(config["record_types"])
    granted = set(roles)
    wide = "AuditLogsQuery.Read.All" in granted
    types = []
    if wide or "AuditLogsQuery-SharePoint.Read.All" in granted:
        types += SHAREPOINT_TYPES
    if wide or "AuditLogsQuery-OneDrive.Read.All" in granted:
        types += ONEDRIVE_TYPES
    if wide:
        types += WIDE_TYPES
    return types


def audit_event(record: dict, now: datetime, enricher: Enricher, query_id: str) -> dict | None:
    """auditLogRecord de Graph → evento con la forma del módulo office365 de Wazuh."""
    data = record.get("auditData") if isinstance(record.get("auditData"), dict) else {}
    office = {key: value for key, value in data.items() if not key.startswith("@odata")}
    rtype = text(record.get("auditLogRecordType"))
    if "RecordType" not in office and rtype in RECORD_TYPES:
        office["RecordType"] = RECORD_TYPES[rtype]
    defaults = {
        "Id": record.get("id"), "Operation": record.get("operation"), "CreationTime": record.get("createdDateTime"),
        "UserId": record.get("userPrincipalName") or record.get("userId"), "ClientIP": record.get("clientIp"),
        "ObjectId": record.get("objectId"), "OrganizationId": record.get("organizationId"),
        "Workload": record.get("service"),
    }
    for key, value in defaults.items():
        if office.get(key) in (None, "") and value not in (None, ""):
            office[key] = value
    if not office.get("Id") or not office.get("Operation"):
        return None
    try:
        created = parse_iso(text(office.get("CreationTime")) or text(record.get("createdDateTime")))
    except ValueError:
        created = now
    office["Subscription"] = "Audit.SharePoint"
    return {
        "integration": "office365",
        "office365": office,
        "qapaq": {"vendor": "m365", "source": "sharepoint_audit", "api": "graph-audit-search", "event_type": "audit",
                "collected_at": iso(now), "query": query_id[:64], "record_type": rtype,
                **enricher.context(office, created)},
    }


def create_query(graph: Graph, start: datetime, end: datetime, types: list[str], version: str) -> str:
    body = {
        "@odata.type": "#microsoft.graph.security.auditLogQuery",
        "displayName": f"qapaq-sharepoint-{iso(start)}",
        "filterStartDateTime": iso(start),
        "filterEndDateTime": iso(end),
        "recordTypeFilters": types,
    }
    try:
        _status, payload = graph.call("POST", f"/{version}/security/auditLog/queries", body=body, ok=(200, 201))
    except ProviderError as error:
        core = [t for t in types if t in SHAREPOINT_TYPES + ONEDRIVE_TYPES]
        if error.status != 400 or core == types or not core:
            raise
        # Un tipo de registro no aceptado por el tenant: reintentar solo con los de servicio.
        body["recordTypeFilters"] = core
        _status, payload = graph.call("POST", f"/{version}/security/auditLog/queries", body=body, ok=(200, 201))
    query_id = payload.get("id") if isinstance(payload, dict) else None
    if not query_id:
        raise ProviderError("audit query created without id")
    return str(query_id)


def collect_audit(config: dict, state: dict, graph: Graph | None = None, now: datetime | None = None) -> tuple[list[dict], dict]:
    now = now or utc_now()
    graph = graph or Graph(TokenCache(Credentials.from_dir(pathlib.Path(config["credentials_dir"]))))
    roles = token_roles(graph.tokens)
    features = {name: feature_status(name, roles) for name in
                ("audit_native", "audit_graph_sharepoint", "audit_graph_onedrive", "dlp_native", "users")}
    next_state = {key: value for key, value in state.items() if key != "pending"}
    events = capability_events("sharepoint_audit", features, state, now)
    remember_capabilities(next_state, features, events, now)

    mode = config.get("mode", "auto")
    if mode == "off":
        path = "off"
    elif mode == "graph" or (mode == "auto" and not features["audit_native"][0]):
        path = "graph" if features["audit_graph_sharepoint"][0] or features["audit_graph_onedrive"][0] else "blocked"
    else:
        path = "native"
    next_state["audit_path"] = path
    if path != "graph":
        next_state.pop("query", None)
        return events, next_state

    version = config.get("graph_version", "v1.0")
    query = next_state.get("query")
    if not query:
        lag = timedelta(minutes=int(config.get("lag_minutes", 30)))
        overlap = timedelta(minutes=int(config.get("overlap_minutes", 120)))
        max_window = timedelta(hours=float(config.get("max_window_hours", 24)))
        cursor = next_state.get("cursor")
        start = parse_iso(cursor) - overlap if cursor else now - timedelta(hours=float(config.get("initial_lookback_hours", 24)))
        start = max(start, now - timedelta(days=int(config.get("max_lookback_days", 7))))
        end = min(now - lag, start + max_window)
        if end - start < timedelta(minutes=int(config.get("min_window_minutes", 10))):
            return events, next_state
        types = record_types(roles["graph"], config)
        query_id = create_query(graph, start, end, types, version)
        next_state["query"] = {"id": query_id, "start": iso(start), "end": iso(end), "created": iso(now), "types": types}
        return events, next_state

    status_payload = graph.get(f"/{version}/security/auditLog/queries/{urllib.parse.quote(query['id'], safe='')}")
    status = text(status_payload.get("status"))
    if status in TERMINAL_FAILED:
        next_state.pop("query", None)
        next_state["failed_queries"] = int(next_state.get("failed_queries", 0)) + 1
        return events, next_state
    if status != "succeeded":
        if now - parse_iso(query["created"]) > timedelta(minutes=int(config.get("max_query_wait_minutes", 180))):
            next_state.pop("query", None)
            next_state["abandoned_queries"] = int(next_state.get("abandoned_queries", 0)) + 1
        return events, next_state

    disabled = disabled_users(graph, next_state, config, now, features["users"][0])
    enricher = Enricher(config, next_state, disabled)
    seen_list = list(next_state.get("seen") or [])
    seen = set(seen_list)
    url = query.get("next") or (f"/{version}/security/auditLog/queries/{urllib.parse.quote(query['id'], safe='')}"
                                f"/records?$top={int(config.get('page_size', 1000))}")
    budget = int(config.get("max_records_per_run", 15000))
    processed = 0
    while url and processed < budget:
        payload = graph.get(url)
        for record in payload.get("value") or []:
            if not isinstance(record, dict):
                continue
            processed += 1
            key = text(record.get("id")) or digest(text(record.get("createdDateTime")), text(record.get("operation")),
                                                    text(record.get("objectId")), text(record.get("userId")))
            if key in seen:
                continue
            event = audit_event(record, now, enricher, query["id"])
            if event is None:
                continue
            seen.add(key)
            seen_list.append(key)
            events.append(event)
        url = payload.get("@odata.nextLink")
    next_state["seen"] = bounded_ids(seen_list, int(config.get("seen_limit", SEEN_LIMIT)))
    next_state["ip_baseline"] = enricher.prune(now)
    if url:  # presupuesto agotado: se retoma la paginación en la próxima ejecución
        next_state["query"] = {**query, "next": url}
    else:
        next_state.pop("query", None)
        next_state["cursor"] = query["end"]
        next_state["last_query_records"] = processed
    return events, next_state


# =========================================================================== postura


def compare(key: str, old, new) -> str:
    """weakened | strengthened | changed para un ajuste del tenant."""
    if key == "sharingCapability" and old in SHARING_ORDER and new in SHARING_ORDER:
        return "weakened" if SHARING_ORDER.index(new) > SHARING_ORDER.index(old) else "strengthened"
    if key == "sharingDomainRestrictionMode" and old in DOMAIN_MODE_ORDER and new in DOMAIN_MODE_ORDER:
        return "weakened" if DOMAIN_MODE_ORDER.index(new) > DOMAIN_MODE_ORDER.index(old) else "strengthened"
    if key in WEAK_WHEN_TRUE and isinstance(new, bool):
        return "weakened" if new else "strengthened"
    if key in WEAK_WHEN_FALSE and isinstance(new, bool):
        return "strengthened" if new else "weakened"
    if key in ("sharingAllowedDomainList", "allowedDomainGuidsForSyncApp"):
        return "weakened" if set(new or []) - set(old or []) else "strengthened"
    if key == "sharingBlockedDomainList":
        return "weakened" if set(old or []) - set(new or []) else "strengthened"
    if key == "idleSessionSignOut" and isinstance(old, dict) and isinstance(new, dict):
        if old.get("isEnabled") and not new.get("isEnabled"):
            return "weakened"
    return "changed"


def short_value(value) -> str:
    if isinstance(value, list):
        return ",".join(sorted(text(v) for v in value))[:500]
    if isinstance(value, dict):
        return ",".join(f"{k}={text(v)}" for k, v in sorted(value.items()) if not k.startswith("@odata"))[:500]
    if isinstance(value, bool):
        return flag(value)
    return text(value)[:500]


def tenant_events(settings: dict, previous: dict | None, now: datetime, snapshot_due: bool) -> list[dict]:
    current = {key: settings.get(key) for key in TENANT_KEYS if key in settings}
    events = []
    base = {"vendor": "m365", "source": "sharepoint_posture", "collected_at": iso(now)}
    if previous is not None:
        for key in sorted(set(current) | set(previous)):
            old, new = previous.get(key), current.get(key)
            if old == new:
                continue
            events.append({"qapaq": {**base, "event_type": "tenant_setting_changed"},
                           "sharepoint": {"change": {"setting": key, "old": short_value(old), "new": short_value(new),
                                                     "direction": compare(key, old, new)}}})
    if snapshot_due or previous is None:
        capability = text(current.get("sharingCapability"))
        events.append({"qapaq": {**base, "event_type": "tenant_settings_snapshot"},
                       "sharepoint": {"tenant": {
                           "sharing_capability": capability,
                           "anyone_links_enabled": flag(capability == "externalUserAndGuestSharing"),
                           "domain_restriction": text(current.get("sharingDomainRestrictionMode")),
                           "resharing_by_external": short_value(current.get("isResharingByExternalUsersEnabled")),
                           "legacy_auth": short_value(current.get("isLegacyAuthProtocolsEnabled")),
                           "unmanaged_sync_restricted": short_value(current.get("isUnmanagedSyncAppForTenantRestricted")),
                       }}})
    return events


def tenant_domains(graph: Graph, state: dict, now: datetime) -> list[str]:
    cache = state.get("tenant_domains") or {}
    refreshed = cache.get("refreshed_at")
    if not refreshed or now - parse_iso(refreshed) >= timedelta(hours=24):
        try:
            orgs = graph.get("/v1.0/organization?$select=verifiedDomains").get("value") or []
            names = sorted({text(d.get("name")).lower() for org in orgs for d in (org.get("verifiedDomains") or [])})
            cache = {"refreshed_at": iso(now), "names": names}
            state["tenant_domains"] = cache
        except ProviderError:
            pass
    return list(cache.get("names") or [])


def grantee(permission: dict) -> tuple[str, str]:
    """(email o login, nombre) del destinatario de un permiso, si existe."""
    for key in ("grantedToV2", "grantedTo"):
        identity = permission.get(key) or {}
        for kind in ("siteUser", "user"):
            who = identity.get(kind) or {}
            email = who.get("email") or who.get("loginName") or ""
            if email or who.get("displayName"):
                return text(email), text(who.get("displayName"))
    for identity in permission.get("grantedToIdentitiesV2") or permission.get("grantedToIdentities") or []:
        for kind in ("siteUser", "user"):
            who = (identity or {}).get(kind) or {}
            if who.get("email") or who.get("loginName"):
                return text(who.get("email") or who.get("loginName")), text(who.get("displayName"))
    return "", ""


def is_external(email: str, domains: list[str]) -> bool:
    lowered = email.lower()
    if "#ext#" in lowered or lowered.startswith("urn:spo:guest"):
        return True
    if "@" not in lowered or not domains:
        return False
    domain = lowered.rsplit("@", 1)[1].rstrip(">").split("|")[0]
    return not any(domain == d or domain.endswith("." + d) for d in domains)


def crawl_site(graph: Graph, site: dict, config: dict, domains: list[str]) -> list[dict]:
    """Hallazgos de enlaces anónimos/externos en las bibliotecas de un sitio (recorrido acotado)."""
    findings = []
    max_drives = int(config.get("max_drives_per_site", 3))
    max_items = int(config.get("max_items_per_drive", 300))
    max_depth = int(config.get("max_depth", 3))
    site_id = urllib.parse.quote(text(site.get("id")), safe=",")
    drives = list(graph.pages(f"/v1.0/sites/{site_id}/drives?$select=id,name,webUrl", max_pages=1))[:max_drives]
    for drive in drives:
        drive_id = urllib.parse.quote(text(drive.get("id")), safe="")
        queue = [("root", 0)]
        visited = 0
        while queue and visited < max_items:
            item_id, depth = queue.pop(0)
            listing = (f"/v1.0/drives/{drive_id}/root/children" if item_id == "root" else
                       f"/v1.0/drives/{drive_id}/items/{urllib.parse.quote(item_id, safe='')}/children")
            for item in graph.pages(listing + "?$top=200&$select=id,name,webUrl,shared,folder,file", max_pages=2):
                visited += 1
                if item.get("folder") and depth + 1 < max_depth:
                    queue.append((text(item.get("id")), depth + 1))
                if not item.get("shared"):
                    continue
                perms = graph.pages(f"/v1.0/drives/{drive_id}/items/{urllib.parse.quote(text(item.get('id')), safe='')}"
                                    "/permissions", max_pages=2)
                for perm in perms:
                    link = perm.get("link") or {}
                    scope = text(link.get("scope"))
                    email, name = grantee(perm)
                    roles = ",".join(sorted(text(r) for r in perm.get("roles") or []))
                    if scope == "anonymous":
                        kind = "anonymous_link"
                    elif email and is_external(email, domains):
                        kind = "external_permission"
                    else:
                        continue
                    findings.append({
                        "kind": kind, "key": digest(text(site.get("id")), text(drive.get("id")), text(item.get("id")),
                                                    text(perm.get("id"))),
                        "site": site, "item": item, "link_scope": scope or "direct", "link_type": text(link.get("type")),
                        "roles": roles, "grantee": email, "grantee_name": name,
                        "expires": text(perm.get("expirationDateTime")), "has_password": flag(bool(perm.get("hasPassword"))),
                    })
                if visited >= max_items:
                    break
    return findings


def site_view(site: dict, recent: bool) -> dict:
    return {"id": text(site.get("id"))[:200], "url": text(site.get("webUrl"))[:500], "name": text(site.get("displayName"))[:200],
            "created": text(site.get("createdDateTime")), "personal": flag(bool(site.get("isPersonalSite"))),
            "recent": flag(recent)}


def collect_posture(config: dict, state: dict, graph: Graph | None = None, now: datetime | None = None) -> tuple[list[dict], dict]:
    now = now or utc_now()
    graph = graph or Graph(TokenCache(Credentials.from_dir(pathlib.Path(config["credentials_dir"]))))
    roles = token_roles(graph.tokens)
    features = {name: feature_status(name, roles) for name in ("tenant_settings", "sites")}
    next_state = {key: value for key, value in state.items() if key != "pending"}
    events = capability_events("sharepoint_posture", features, state, now)
    remember_capabilities(next_state, features, events, now)
    base = {"vendor": "m365", "source": "sharepoint_posture", "collected_at": iso(now)}

    last_snapshot = next_state.get("snapshot_at")
    snapshot_due = not last_snapshot or now - parse_iso(last_snapshot) >= timedelta(hours=float(config.get("snapshot_hours", 24)))

    if features["tenant_settings"][0] and config.get("tenant_settings", True):
        settings = graph.get("/v1.0/admin/sharepoint/settings")
        previous = next_state.get("tenant")
        events += tenant_events(settings, previous, now, snapshot_due)
        next_state["tenant"] = {key: settings.get(key) for key in TENANT_KEYS if key in settings}

    if features["sites"][0] and config.get("sites", True):
        recent_days = int(config.get("recent_site_days", 7))
        horizon = now - timedelta(days=recent_days)
        sites = list(graph.pages("/v1.0/sites/getAllSites?$top=999&$select=id,webUrl,displayName,createdDateTime,"
                                 "isPersonalSite,siteCollection", max_pages=int(config.get("max_site_pages", 20))))
        known = set(next_state.get("known_sites") or [])
        first_inventory = "known_sites" not in next_state
        recent_ids = set()
        for site in sites:
            sid = digest(text(site.get("id")))
            try:
                created = parse_iso(text(site.get("createdDateTime")))
            except ValueError:
                created = None
            recent = bool(created and created >= horizon)
            if recent:
                recent_ids.add(text(site.get("id")))
            if sid not in known and (not first_inventory or recent):
                events.append({"qapaq": {**base, "event_type": "site_created"}, "sharepoint": {"site": site_view(site, recent)}})
            known.add(sid)
        next_state["known_sites"] = sorted(known)
        # Recorrido rotativo de enlaces: primero los sitios recientes, luego por turno.
        domains = tenant_domains(graph, next_state, now)
        crawlable = [s for s in sites if config.get("crawl_personal_sites") or not s.get("isPersonalSite")]
        crawlable.sort(key=lambda s: text(s.get("id")))
        per_run = int(config.get("sites_per_run", 20))
        offset = int(next_state.get("crawl_offset", 0)) % max(len(crawlable), 1)
        batch = [s for s in crawlable if text(s.get("id")) in recent_ids]
        rotation = crawlable[offset:] + crawlable[:offset]
        for site in rotation:
            if len(batch) >= per_run + len(recent_ids):
                break
            if site not in batch:
                batch.append(site)
        next_state["crawl_offset"] = (offset + per_run) % max(len(crawlable), 1)
        seen_findings = list(next_state.get("findings") or [])
        seen_set = set(seen_findings)
        external_sites = set()
        crawl_errors = 0
        for site in batch:
            try:
                found = crawl_site(graph, site, config, domains)
            except ProviderError as error:
                if error.status in (401,) or crawl_errors >= int(config.get("max_crawl_errors", 10)):
                    raise
                crawl_errors += 1  # un sitio o biblioteca inaccesible no detiene el inventario
                continue
            for finding in found:
                external_sites.add(text(site.get("id")))
                if finding["key"] in seen_set:
                    continue
                seen_set.add(finding["key"])
                seen_findings.append(finding["key"])
                item = finding["item"]
                recent = text(site.get("id")) in recent_ids
                events.append({"qapaq": {**base, "event_type": "sharing_finding"}, "sharepoint": {
                    "finding": {"kind": finding["kind"], "key": finding["key"]},
                    "site": site_view(site, recent),
                    "item": {"name": text(item.get("name"))[:300], "url": text(item.get("webUrl"))[:500],
                             "is_folder": flag(bool(item.get("folder")))},
                    "link": {"scope": finding["link_scope"], "type": finding["link_type"], "roles": finding["roles"],
                             "expires": finding["expires"], "has_password": finding["has_password"]},
                    "grantee": {"email": finding["grantee"][:320], "name": finding["grantee_name"][:200]},
                }})
        for site in batch:
            if text(site.get("id")) in recent_ids and text(site.get("id")) in external_sites:
                marker = "recent:" + digest(text(site.get("id")))
                if marker not in seen_set:
                    seen_set.add(marker)
                    seen_findings.append(marker)
                    events.append({"qapaq": {**base, "event_type": "recent_site_external_sharing"},
                                   "sharepoint": {"site": site_view(site, True)}})
        next_state["findings"] = bounded_ids(seen_findings, int(config.get("findings_limit", FINDINGS_LIMIT)))
        if snapshot_due:
            events.append({"qapaq": {**base, "event_type": "inventory_snapshot"}, "sharepoint": {"inventory": {
                "sites": str(len(sites)), "personal_sites": str(sum(1 for s in sites if s.get("isPersonalSite"))),
                "recent_sites": str(len(recent_ids)), "crawled_this_run": str(len(batch)),
                "known_findings": str(len(seen_findings)), "crawl_errors": str(crawl_errors)}}})
    if snapshot_due:
        next_state["snapshot_at"] = iso(now)
    return events, next_state


def main() -> int:
    parser = argparse.ArgumentParser(description="QAPAQ SharePoint/OneDrive collector (read-only)")
    parser.add_argument("mode", choices=("audit", "posture"))
    parser.add_argument("--config", type=pathlib.Path, required=True)
    args = parser.parse_args()
    collect = collect_audit if args.mode == "audit" else collect_posture
    return run_collector(f"qapaq-sharepoint-{args.mode}", args.config, collect)


if __name__ == "__main__":
    raise SystemExit(main())
