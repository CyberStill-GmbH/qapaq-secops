#!/usr/bin/env python3
"""Escribe edge.json del bundle SIEM a partir de entradas no secretas del workflow.

EDGE_HOSTNAME (obligatorio), EDGE_EXTRA_HOSTNAMES (separados por espacios) y
ANKAY_PRIVATE_IP (opcional). Con Ankay añade /ankay/ hacia <ip>:3001 y la URL del
webhook de entrada Wazuh, cuyo ID fija el generador de playbooks de Ankay.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import sys
import uuid
from pathlib import Path

HOST = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")
# Mismo espacio de nombres y semilla que ankay/playbooks/build_workflows.py.
PLAYBOOK_NAMESPACE = uuid.UUID("5d0f6a3e-7a4e-5b8e-9d1c-0a9e1c4b2f61")
WAZUH_INTAKE_HOOK = uuid.uuid5(PLAYBOOK_NAMESPACE, "wazuh.alert-intake:webhook")


def build(env: dict[str, str]) -> dict:
    hostname = env.get("EDGE_HOSTNAME", "")
    extra = env.get("EDGE_EXTRA_HOSTNAMES", "").split()
    if not HOST.fullmatch(hostname) or not all(HOST.fullmatch(item) for item in extra):
        raise ValueError("edge hostname is invalid")
    edge = {"schemaVersion": 1, "hostname": hostname, "extraHostnames": extra}
    ip = env.get("ANKAY_PRIVATE_IP", "")
    if ip:
        address = ipaddress.ip_address(ip)
        if address.version != 4 or not address.is_private or address.is_loopback:
            raise ValueError("Ankay IP must be a private IPv4 address")
        edge["ankayUpstream"] = f"{ip}:3001"
        edge["ankayWebhookUrl"] = f"http://{ip}:5001/api/v1/hooks/webhook_{WAZUH_INTAKE_HOOK}"
    return edge


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        edge = build(dict(os.environ))
    except ValueError as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1
    args.output.write_text(json.dumps(edge, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
