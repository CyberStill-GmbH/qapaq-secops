#!/usr/bin/env python3
"""Microsoft identity + Graph helpers shared by the QAPAQ SharePoint/OneDrive collectors. Stdlib only.

Never prints or logs secrets, tokens or provider response bodies: errors carry at most the HTTP
status (``qapaq_collector.ProviderError``).
"""

from __future__ import annotations

import base64
import json
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "common"))
from qapaq_collector import USER_AGENT, ProviderError, http_json, read_secret  # noqa: E402

LOGIN = "https://login.microsoftonline.com"
GRAPH = "https://graph.microsoft.com"
MANAGE = "https://manage.office.com"
GRAPH_SCOPE = f"{GRAPH}/.default"
MANAGE_SCOPE = f"{MANAGE}/.default"

# Application permissions per feature. ``api`` = which token carries the role (graph or the Office 365
# Management APIs). The first role is the least-privilege choice; any listed role enables the feature.
FEATURES: dict[str, dict] = {
    "audit_native": {
        "label": "Audit.SharePoint vía módulo office365 de Wazuh (Management Activity API)",
        "api": "manage", "roles": ("ActivityFeed.Read",),
    },
    "dlp_native": {
        "label": "DLP de SharePoint/OneDrive vía Management Activity API (suscripción DLP.All)",
        "api": "manage", "roles": ("ActivityFeed.ReadDlp",),
    },
    "audit_graph_sharepoint": {
        "label": "Auditoría SharePoint vía Purview Audit Search (Graph /security/auditLog/queries)",
        "api": "graph", "roles": ("AuditLogsQuery-SharePoint.Read.All", "AuditLogsQuery.Read.All"),
    },
    "audit_graph_onedrive": {
        "label": "Auditoría OneDrive vía Purview Audit Search (Graph /security/auditLog/queries)",
        "api": "graph", "roles": ("AuditLogsQuery-OneDrive.Read.All", "AuditLogsQuery.Read.All"),
    },
    "tenant_settings": {
        "label": "Configuración de uso compartido del tenant (Graph /admin/sharepoint/settings)",
        "api": "graph", "roles": ("SharePointTenantSettings.Read.All", "SharePointTenantSettings.ReadWrite.All"),
    },
    "sites": {
        "label": "Inventario de sitios y enlaces de uso compartido (Graph /sites, /drives, /permissions)",
        "api": "graph", "roles": ("Sites.Read.All", "Sites.ReadWrite.All", "Sites.FullControl.All"),
    },
    "users": {
        "label": "Cuentas deshabilitadas e invitados (enriquecimiento de la auditoría)",
        "api": "graph", "roles": ("User.Read.All", "Directory.Read.All"),
    },
}


def jwt_roles(access_token: str | None) -> list[str]:
    """Application roles granted in an access token (``roles`` claim). Never returns the token."""
    if not access_token or access_token.count(".") < 2:
        return []
    part = access_token.split(".")[1]
    try:
        claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except (ValueError, json.JSONDecodeError):
        return []
    return sorted(claims.get("roles") or [])


def feature_status(feature: str, roles: dict[str, list[str]]) -> tuple[bool, list[str]]:
    """``(enabled, missing)`` for one feature given the roles of each token."""
    spec = FEATURES[feature]
    granted = set(roles.get(spec["api"], []))
    if granted & set(spec["roles"]):
        return True, []
    return False, [spec["roles"][0]]


class Credentials:
    def __init__(self, tenant: str, client_id: str, client_secret: str) -> None:
        self.tenant, self.client_id, self.client_secret = tenant, client_id, client_secret

    @classmethod
    def from_dir(cls, directory: pathlib.Path) -> "Credentials":
        return cls(read_secret(directory / "entra-tenant-id"), read_secret(directory / "entra-client-id"),
                   read_secret(directory / "entra-client-secret"))

    @classmethod
    def from_env_file(cls, path: pathlib.Path) -> "Credentials":
        """Developer convenience: TENANT_ID / CLIENT_ID / CLIENT_SECRET from a .env file."""
        values: dict[str, str] = {}
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if "=" not in line or line.startswith("#"):
                continue
            key, value = line.split("=", 1)
            values[key.strip().removeprefix("export ").strip()] = value.strip().strip("'\"")
        try:
            return cls(values["TENANT_ID"], values["CLIENT_ID"], values["CLIENT_SECRET"])
        except KeyError as error:
            raise ProviderError("credential file lacks TENANT_ID/CLIENT_ID/CLIENT_SECRET") from error


class TokenCache:
    """Client-credentials tokens per scope, refreshed 5 minutes before expiry."""

    def __init__(self, credentials: Credentials, opener=None) -> None:
        self.credentials = credentials
        self.opener = opener or urllib.request.urlopen
        self._cache: dict[str, tuple[str, float]] = {}

    def get(self, scope: str) -> str:
        cached = self._cache.get(scope)
        if cached and cached[1] > time.time() + 300:
            return cached[0]
        token, expires_in = self._request(scope)
        self._cache[scope] = (token, time.time() + expires_in)
        return token

    def roles(self, scope: str) -> tuple[int, list[str]]:
        """``(http_status, roles)``; status 200 with no roles means the app has none for that API."""
        try:
            return 200, jwt_roles(self.get(scope))
        except ProviderError as error:
            return error.status or 0, []

    def _request(self, scope: str) -> tuple[str, float]:
        tenant = urllib.parse.quote(self.credentials.tenant, safe="")
        body = urllib.parse.urlencode({
            "grant_type": "client_credentials", "client_id": self.credentials.client_id,
            "client_secret": self.credentials.client_secret, "scope": scope,
        }).encode()
        request = urllib.request.Request(f"{LOGIN}/{tenant}/oauth2/v2.0/token", data=body, method="POST")
        request.add_header("Content-Type", "application/x-www-form-urlencoded")
        request.add_header("User-Agent", USER_AGENT)
        try:
            with self.opener(request, timeout=30) as response:
                payload = json.loads(response.read(1024 * 1024))
        except urllib.error.HTTPError as error:
            raise ProviderError("token request rejected", error.code) from None
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
            raise ProviderError("token request failed (network)") from None
        token = payload.get("access_token") if isinstance(payload, dict) else None
        if not token:
            raise ProviderError("token response without access_token")
        return token, float(payload.get("expires_in") or 3599)


def safe_path(url: str) -> str:
    """Endpoint path without host, ids or query (safe for logs)."""
    path = urllib.parse.urlsplit(url).path
    out = []
    for part in path.split("/"):
        looks_like_id = len(part) > 20 or "," in part or (len(part) > 8 and any(c.isdigit() for c in part))
        out.append("{id}" if part and looks_like_id else part)
    return "/".join(out)


class Graph:
    """Minimal Graph/Management client with paging, 429/503 back-off and status-only errors."""

    def __init__(self, tokens: TokenCache, opener=None, sleep=time.sleep) -> None:
        self.tokens, self.opener, self.sleep = tokens, opener, sleep

    def call(self, method: str, url: str, body: object | None = None, scope: str = GRAPH_SCOPE,
             headers: dict | None = None, ok=(200,)) -> tuple[int, object]:
        if not url.startswith("https://"):
            url = GRAPH + url
        for attempt in range(4):
            request_headers = {"Authorization": "Bearer " + self.tokens.get(scope), **(headers or {})}
            status, payload = http_json(method, url, request_headers, body, timeout=60, opener=self.opener)
            if status in (429, 503, 504) and attempt < 3:
                self.sleep(min(60, 5 * (attempt + 1) ** 2))
                continue
            if status not in ok:
                raise ProviderError(f"{method} {safe_path(url)} rejected", status)
            return status, payload
        raise ProviderError(f"{method} {safe_path(url)} throttled", 429)  # pragma: no cover

    def get(self, url: str, **kwargs) -> dict:
        _status, payload = self.call("GET", url, **kwargs)
        return payload if isinstance(payload, dict) else {}

    def pages(self, url: str, max_pages: int = 50, **kwargs):
        """Yield items of an OData collection following ``@odata.nextLink`` (bounded)."""
        for _ in range(max_pages):
            payload = self.get(url, **kwargs)
            for item in payload.get("value") or []:
                if isinstance(item, dict):
                    yield item
            url = payload.get("@odata.nextLink")
            if not url:
                return
