#!/usr/bin/env python3
"""Verifica desde el API del manager que un agente QAPAQ quedó sano tras instalarse.

Solo lectura. Comprueba heartbeat, versión, grupo, inventario (syscollector) y SCA, y lista
agentes desconectados para la operación diaria. Las credenciales del API se leen de un archivo
(`usuario:contraseña`, permisos 0600) que el host materializa desde Key Vault; nunca de argv.

Uso:
  verify_agent.py agent --name srv-core01.qapaq.example --group qapaq-srv-core
  verify_agent.py disconnected --older-than-minutes 30

Variables de entorno:
  WAZUH_API_URL          por defecto https://127.0.0.1:55000
  WAZUH_API_CREDENTIALS  archivo con usuario:contraseña (obligatorio)
  WAZUH_API_CA           CA para verificar TLS (por defecto, almacén del sistema)

Códigos de salida: 0 sano · 1 error de uso o de API · 2 agente con hallazgos.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import ssl
import stat
import sys
import urllib.parse
import urllib.request

EXPECTED_VERSION = "Wazuh v4.14.8"
KEEPALIVE_MAX_SECONDS = 120


def _context() -> ssl.SSLContext:
    ca = os.environ.get("WAZUH_API_CA")
    return ssl.create_default_context(cafile=ca) if ca else ssl.create_default_context()


def _credentials() -> str:
    path = os.environ.get("WAZUH_API_CREDENTIALS")
    if not path:
        sys.exit("WAZUH_API_CREDENTIALS es obligatorio.")
    mode = os.stat(path).st_mode
    if os.name == "posix" and mode & (stat.S_IRWXG | stat.S_IRWXO):
        sys.exit("el archivo de credenciales no debe ser legible por grupo u otros.")
    with open(path, encoding="utf-8") as stream:
        return stream.read().strip()


class WazuhApi:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.context = _context()
        basic = base64.b64encode(_credentials().encode()).decode()
        request = urllib.request.Request(
            f"{self.base_url}/security/user/authenticate",
            method="POST",
            headers={"Authorization": f"Basic {basic}"},
        )
        with urllib.request.urlopen(request, context=self.context, timeout=15) as response:
            self.token = json.load(response)["data"]["token"]

    def get(self, path: str, **params: str) -> dict:
        query = f"?{urllib.parse.urlencode(params)}" if params else ""
        request = urllib.request.Request(
            f"{self.base_url}{path}{query}", headers={"Authorization": f"Bearer {self.token}"}
        )
        with urllib.request.urlopen(request, context=self.context, timeout=15) as response:
            return json.load(response)["data"]


def _age_seconds(timestamp: str | None) -> float | None:
    if not timestamp:
        return None
    moment = dt.datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    return (dt.datetime.now(dt.timezone.utc) - moment).total_seconds()


def verify_agent(api: WazuhApi, name: str, group: str) -> int:
    items = api.get(
        "/agents", name=name, select="id,name,status,version,group,lastKeepAlive,os.name"
    )["affected_items"]
    if not items:
        print(json.dumps({"agent": name, "findings": ["no registrado en el manager"]}, indent=2))
        return 2
    agent = items[0]
    findings: list[str] = []
    age = _age_seconds(agent.get("lastKeepAlive"))
    if agent.get("status") != "active":
        findings.append(f"estado {agent.get('status')}")
    if age is None or age > KEEPALIVE_MAX_SECONDS:
        findings.append(f"último keepalive hace {age if age is not None else '∞'} s")
    if agent.get("version") != EXPECTED_VERSION:
        findings.append(f"versión {agent.get('version')} (se espera {EXPECTED_VERSION})")
    if group not in (agent.get("group") or []):
        findings.append(f"grupos {agent.get('group')} sin {group}")
    os_info = api.get(f"/syscollector/{agent['id']}/os")["affected_items"]
    packages = api.get(f"/syscollector/{agent['id']}/packages", limit="1")["total_affected_items"]
    if not os_info or packages == 0:
        findings.append("inventario syscollector vacío (esperar el primer escaneo o revisar el módulo)")
    sca = api.get(f"/sca/{agent['id']}")["affected_items"]
    if not sca:
        findings.append("sin resultados SCA aún")
    report = {
        "agent": agent["name"],
        "id": agent["id"],
        "status": agent.get("status"),
        "version": agent.get("version"),
        "groups": agent.get("group"),
        "keepaliveAgeSeconds": age,
        "os": (os_info[0].get("os") or {}).get("name") if os_info else None,
        "packages": packages,
        "scaPolicies": [policy.get("policy_id") for policy in sca],
        "findings": findings,
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 2 if findings else 0


def list_disconnected(api: WazuhApi, older_than_minutes: int) -> int:
    items = api.get(
        "/agents",
        status="disconnected,never_connected",
        older_than=f"{older_than_minutes}m",
        select="id,name,status,group,lastKeepAlive,version",
        limit="500",
    )["affected_items"]
    print(json.dumps({"olderThanMinutes": older_than_minutes, "agents": items}, indent=2, ensure_ascii=False))
    return 2 if items else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    agent = sub.add_parser("agent")
    agent.add_argument("--name", required=True)
    agent.add_argument("--group", required=True)
    disconnected = sub.add_parser("disconnected")
    disconnected.add_argument("--older-than-minutes", type=int, default=30)
    args = parser.parse_args()

    api = WazuhApi(os.environ.get("WAZUH_API_URL", "https://127.0.0.1:55000"))
    if args.command == "agent":
        return verify_agent(api, args.name.lower(), args.group)
    return list_disconnected(api, args.older_than_minutes)


if __name__ == "__main__":
    sys.exit(main())
