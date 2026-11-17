#!/usr/bin/env python3
"""Shared runtime for the QAPAQ platform monitor, vulnerability prioritizer and canaries (docs/20).

Stdlib only (CPython >= 3.10). Contract shared with ``wazuh/provider-ingestion``:

- Secrets come from restricted local files (``read_secret``: 0600, no symlinks) and are never printed.
- Events are JSONL appended with ``fsync`` into the manager logs volume; Wazuh reads them with
  ``<localfile log_format="json">``.
- Read-only identities only: indexer user ``qapaq_monitor`` (cluster/indices monitor + read of
  ``wazuh-alerts-*`` and ``wazuh-states-vulnerabilities-*``), Wazuh API user ``qapaq-monitor`` (RBAC
  ``readonly``) and Postgres role ``qapaq_monitor`` (SELECT on the ingestion-health tables). No admin
  credential is read by this code: the installer creates those identities.
"""

from __future__ import annotations

import base64
import json
import os
import pathlib
import socket
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

HERE = pathlib.Path(__file__).resolve().parent
for candidate in (HERE, HERE.parent / "provider-ingestion" / "common"):
    if (candidate / "qapaq_collector.py").is_file() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from qapaq_collector import (  # noqa: E402
    ProviderError,
    append_bytes,
    iso,
    load_config,
    parse_iso,
    read_secret,
    read_state,
    save_state,
    serialize_events,
    utc_now,
)

__all__ = [
    "ProviderError", "append_bytes", "iso", "load_config", "parse_iso", "read_secret", "read_state",
    "save_state", "serialize_events", "utc_now", "emit", "Indexer", "WazuhApi", "run", "docker_json",
    "psql_rows", "systemd_unit", "cert_not_after", "HttpResult", "https_get",
]

USER_AGENT = "qapaq-platform-monitor/1.0"
MAX_BODY = 32 * 1024 * 1024


def emit(path: pathlib.Path | str, events: list[dict]) -> int:
    """Append events as JSONL (fsync). Returns the number of events written."""
    if not events:
        return 0
    append_bytes(pathlib.Path(path), serialize_events(events))
    return len(events)


# --------------------------------------------------------------------------- HTTPS


class HttpResult:
    def __init__(self, status: int, body: bytes, headers: dict | None = None) -> None:
        self.status = status
        self.body = body
        self.headers = headers or {}

    def json(self):
        return json.loads(self.body) if self.body else None


def _context(cafile: str | None, verify_hostname: bool = True) -> ssl.SSLContext:
    context = ssl.create_default_context(cafile=cafile) if cafile else ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.check_hostname = verify_hostname
    return context


class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    """Connect to ``host`` but validate the certificate for ``server_hostname`` (e.g. 127.0.0.1 → wazuh.indexer)."""

    def __init__(self, context: ssl.SSLContext, server_hostname: str | None) -> None:
        super().__init__(context=context)
        self._ctx = context
        self._sni = server_hostname

    def https_open(self, req):
        sni, ctx = self._sni, self._ctx

        import http.client

        class Conn(http.client.HTTPSConnection):
            def connect(inner):  # noqa: N805
                sock = socket.create_connection((inner.host, inner.port), inner.timeout)
                inner.sock = ctx.wrap_socket(sock, server_hostname=sni or inner.host)

        return self.do_open(lambda host, **kw: Conn(host, timeout=kw.get("timeout", 30)), req)


def https_request(
    method: str,
    url: str,
    *,
    headers: dict | None = None,
    body: object | None = None,
    cafile: str | None = None,
    server_hostname: str | None = None,
    verify_hostname: bool = True,
    timeout: float = 20,
    opener=None,
) -> HttpResult:
    if not url.startswith("https://"):
        raise ProviderError("endpoint must be https")
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("User-Agent", USER_AGENT)
    if data is not None and not (headers or {}).get("Content-Type"):
        request.add_header("Content-Type", "application/json")
    for name, value in (headers or {}).items():
        request.add_header(name, value)
    if opener is None:
        context = _context(cafile, verify_hostname)
        opener = urllib.request.build_opener(_PinnedHTTPSHandler(context, server_hostname))
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read(MAX_BODY + 1)
            status = getattr(response, "status", 200)
            hdrs = dict(response.headers.items()) if getattr(response, "headers", None) else {}
    except urllib.error.HTTPError as error:
        try:
            raw = error.read(MAX_BODY + 1)
        except OSError:
            raw = b""
        return HttpResult(error.code, b"" if len(raw) > MAX_BODY else raw)
    except (urllib.error.URLError, TimeoutError, OSError, ssl.SSLError) as error:
        raise ProviderError(f"request failed ({type(error).__name__})") from error
    if len(raw) > MAX_BODY:
        raise ProviderError("response too large", status)
    return HttpResult(status, raw, hdrs)


def https_get(url: str, **kwargs) -> HttpResult:
    return https_request("GET", url, **kwargs)


class Indexer:
    """Read-only indexer client (user ``qapaq_monitor``)."""

    def __init__(self, config: dict, opener=None) -> None:
        self.url = str(config.get("url") or "https://127.0.0.1:9200").rstrip("/")
        self.cafile = config.get("ca_file")
        self.server_hostname = config.get("server_hostname") or None
        self.user = config.get("user") or "qapaq_monitor"
        self.password_file = config.get("password_file")
        self.opener = opener
        self._auth = None

    def _authorization(self) -> str:
        if self._auth is None:
            if not self.password_file:
                raise ProviderError("indexer monitor credential is not configured")
            secret = read_secret(pathlib.Path(self.password_file))
            self._auth = "Basic " + base64.b64encode(f"{self.user}:{secret}".encode()).decode()
        return self._auth

    def request(self, method: str, path: str, body: object | None = None, timeout: float = 20):
        result = https_request(
            method,
            self.url + path,
            headers={"Authorization": self._authorization()},
            body=body,
            cafile=self.cafile,
            server_hostname=self.server_hostname,
            timeout=timeout,
            opener=self.opener,
        )
        if result.status >= 400:
            raise ProviderError("indexer request rejected", result.status)
        return result.json()

    def get(self, path: str):
        return self.request("GET", path)

    def search(self, index: str, body: dict):
        return self.request("POST", f"/{urllib.parse.quote(index, safe='*,-')}/_search", body)


class WazuhApi:
    """Wazuh manager API with a read-only RBAC user (``qapaq-monitor``)."""

    def __init__(self, config: dict, opener=None) -> None:
        self.url = str(config.get("url") or "https://127.0.0.1:55000").rstrip("/")
        self.cafile = config.get("ca_file")
        self.verify_hostname = bool(config.get("verify_hostname", False))
        self.user = config.get("user") or "qapaq-monitor"
        self.password_file = config.get("password_file")
        self.opener = opener
        self._token = None

    def _call(self, method: str, path: str, headers: dict) -> HttpResult:
        return https_request(
            method, self.url + path, headers=headers, cafile=self.cafile,
            verify_hostname=self.verify_hostname, opener=self.opener,
        )

    def token(self) -> str:
        if self._token is None:
            if not self.password_file:
                raise ProviderError("Wazuh API monitor credential is not configured")
            secret = read_secret(pathlib.Path(self.password_file))
            basic = base64.b64encode(f"{self.user}:{secret}".encode()).decode()
            result = self._call("POST", "/security/user/authenticate", {"Authorization": "Basic " + basic})
            if result.status != 200:
                raise ProviderError("Wazuh API authentication failed", result.status)
            self._token = ((result.json() or {}).get("data") or {}).get("token")
            if not self._token:
                raise ProviderError("Wazuh API returned no token")
        return self._token

    def get(self, path: str):
        result = self._call("GET", path, {"Authorization": "Bearer " + self.token()})
        if result.status >= 400:
            raise ProviderError("Wazuh API request rejected", result.status)
        return result.json()


# --------------------------------------------------------------------------- host helpers


def run(argv: list[str], timeout: float = 30, input_text: str | None = None) -> tuple[int, str]:
    """Run a command without a shell. Returns ``(returncode, stdout)``; stderr is discarded."""
    try:
        completed = subprocess.run(
            argv, input=input_text, capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return 127, f"{type(error).__name__}"
    return completed.returncode, completed.stdout


def docker_json(args: list[str], timeout: float = 30) -> list:
    """``docker <args> --format '{{json .}}'`` as a list of objects."""
    code, out = run(["docker", *args, "--format", "{{json .}}"], timeout=timeout)
    if code != 0:
        raise ProviderError("docker command failed")
    rows = []
    for line in out.splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def psql_rows(container: str, role: str, database: str, sql: str, timeout: float = 20) -> list[list[str]]:
    """Read-only query through the Postgres container's local socket as ``role`` (no password)."""
    code, out = run(
        [
            "docker", "exec", "-e", "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000",
            container, "psql", "-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1",
            "-U", role, "-d", database, "-c", sql,
        ],
        timeout=timeout,
    )
    if code != 0:
        raise ProviderError("database query failed")
    return [line.split("\t") for line in out.splitlines() if line.strip()]


def systemd_unit(name: str) -> dict:
    """Selected ``systemctl show`` properties of a unit (empty dict if systemctl is unavailable)."""
    props = "Result,ExecMainStatus,ActiveState,SubState,LoadState,ExecMainExitTimestamp,ActiveEnterTimestamp,UnitFileState"
    code, out = run(["systemctl", "show", name, "-p", props], timeout=10)
    if code != 0:
        return {}
    data = {}
    for line in out.splitlines():
        key, _, value = line.partition("=")
        data[key] = value
    return data


def cert_not_after(path: pathlib.Path | str) -> datetime | None:
    """Expiry of the first certificate in a PEM file (stdlib decoder, no key access)."""
    try:
        decoded = ssl._ssl._test_decode_cert(str(path))  # noqa: SLF001 - stdlib helper, PEM only
    except (OSError, ssl.SSLError, ValueError):
        return None
    value = decoded.get("notAfter")
    if not value:
        return None
    return datetime.fromtimestamp(ssl.cert_time_to_seconds(value), tz=timezone.utc)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes")
