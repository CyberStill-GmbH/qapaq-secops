#!/usr/bin/env python3
"""Report which QAPAQ integrations the Entra app can serve. Prints roles and HTTP codes, never secrets.

Reads ``entra-tenant-id``, ``entra-client-id`` and ``entra-client-secret`` from ``--secrets``.
Exit 0 when the Office 365 Management API (ActivityFeed.Read) is usable, 2 otherwise.
"""

from __future__ import annotations

import argparse
import base64
import json
import pathlib
import urllib.error
import urllib.parse
import urllib.request

NEEDS = {
    "office365 module (Management Activity API)": ("manage", "ActivityFeed.Read"),
    "ms-graph module security/alerts_v2": ("graph", "SecurityAlert.Read.All"),
    "ms-graph module security/incidents": ("graph", "SecurityIncident.Read.All"),
    "alert mail (Graph sendMail)": ("graph", "Mail.Send"),
}


def token(tenant: str, client: str, secret: str, scope: str) -> tuple[int, str | None]:
    body = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": client,
                                   "client_secret": secret, "scope": scope}).encode()
    request = urllib.request.Request(f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token", data=body)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.load(response).get("access_token")
    except urllib.error.HTTPError as error:
        return error.code, None


def roles(access_token: str | None) -> list[str]:
    if not access_token:
        return []
    part = access_token.split(".")[1]
    return sorted(json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))).get("roles") or [])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--secrets", type=pathlib.Path, default=pathlib.Path("/opt/qapaq/secrets/collectors"))
    args = parser.parse_args()
    read = lambda name: (args.secrets / name).read_text(encoding="utf-8").strip()  # noqa: E731
    tenant, client, secret = read("entra-tenant-id"), read("entra-client-id"), read("entra-client-secret")
    granted = {}
    for key, scope in (("graph", "https://graph.microsoft.com/.default"), ("manage", "https://manage.office.com/.default")):
        status, access = token(tenant, client, secret, scope)
        granted[key] = roles(access)
        print(f"{scope}: token HTTP {status}; roles={','.join(granted[key]) or '(ninguno)'}")
    for feature, (key, role) in NEEDS.items():
        print(f"  {feature}: {'OK' if role in granted[key] else 'FALTA ' + role}")
    return 0 if "ActivityFeed.Read" in granted["manage"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
