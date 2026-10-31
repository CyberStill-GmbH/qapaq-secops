#!/usr/bin/env python3
"""Renderiza el Compose de Ankay y el JSON de ankay_host para AZURE_EUS2_ANKAY_HOST_JSON.

Entrada:
  --published  published-images.json del workflow ankay-azure-eus2-publish.yml (digests).
  --profile    JSON con los valores del host: private_ip_address, admin_ssh_public_key,
               ubuntu_image_version y, opcionalmente, vm_size, data_disk_size_gb,
               public_url y opensearch_heap (si faltan se usan ankay-host.defaults.json).
Salida: --compose-out con el Compose exacto y --json-out con el objeto ankay_host
completo (solo nombres de secretos de Key Vault, nunca valores).
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / "compose.template.yaml"
DEFAULTS = HERE / "ankay-host.defaults.json"
ACR = "qapaqsecopsdemoeus3a2405f3.azurecr.io"
ANKAY_SUBNET = ipaddress.ip_network("10.80.0.32/27")
SERVICE_KEYS = ("docker-guard", "frontend", "backend", "orborus", "opensearch", "worker")
APP_TAG = "ankay/apps:qapaq-ankay_1.0.0"
DIGEST = re.compile(rf"^{re.escape(ACR)}/ankay-qapaq-[a-z0-9-]+@sha256:[0-9a-f]{{64}}$")
PLACEHOLDER = re.compile(r"@@[A-Z_]+@@")


class RenderError(ValueError):
    pass


def render(published: dict, profile: dict) -> tuple[str, dict]:
    defaults = json.loads(DEFAULTS.read_text(encoding="utf-8"))
    images = published.get("container_images") or {}
    if sorted(images) != sorted(SERVICE_KEYS):
        raise RenderError("published container_images must contain exactly " + ", ".join(SERVICE_KEYS))
    for key, ref in images.items():
        if not isinstance(ref, str) or not DIGEST.fullmatch(ref):
            raise RenderError(f"{key} is not an EUS2 ACR digest reference")
    app_images = published.get("app_images") or {}
    if list(app_images) != [APP_TAG] or not DIGEST.fullmatch(app_images[APP_TAG] or ""):
        raise RenderError(f"app_images must map exactly {APP_TAG} to an ACR digest")

    host_ip = profile.get("private_ip_address", "")
    try:
        address = ipaddress.ip_address(host_ip)
    except ValueError:
        raise RenderError("private_ip_address must be an IPv4 address") from None
    usable = list(ANKAY_SUBNET.hosts())[3:]  # Azure reserva .1-.3 además de red/broadcast.
    if address not in usable:
        raise RenderError(f"private_ip_address must be a usable host of {ANKAY_SUBNET}")
    public_url = profile.get("public_url", defaults["public_url"])
    if not re.fullmatch(r"https://[a-z0-9.-]+/ankay/", public_url):
        raise RenderError("public_url must be https://<host>/ankay/")
    heap = profile.get("opensearch_heap", defaults["opensearch_heap"])
    if not re.fullmatch(r"[1-8]g", heap):
        raise RenderError("opensearch_heap must be between 1g and 8g")

    values = {
        "IMAGE_DOCKER_GUARD": images["docker-guard"],
        "IMAGE_FRONTEND": images["frontend"],
        "IMAGE_BACKEND": images["backend"],
        "IMAGE_ORBORUS": images["orborus"],
        "IMAGE_OPENSEARCH": images["opensearch"],
        "IMAGE_WORKER": images["worker"],
        "GUARD_ALLOWED_IMAGES": f"{images['worker']},{APP_TAG}",
        "PUBLIC_URL": public_url,
        "OPENSEARCH_HEAP": heap,
    }
    # El SHA no debe depender del checkout (CRLF en Windows).
    compose = TEMPLATE.read_text(encoding="utf-8").replace("\r\n", "\n")
    for key, value in values.items():
        compose = compose.replace(f"@@{key}@@", value)
    if PLACEHOLDER.search(compose):
        raise RenderError("template placeholder left unrendered")

    ankay_host = {
        "private_ip_address": host_ip,
        "admin_ssh_public_key": profile.get("admin_ssh_public_key", ""),
        "vm_size": profile.get("vm_size", defaults["vm_size"]),
        "ubuntu_image_version": profile.get("ubuntu_image_version", ""),
        "data_disk_size_gb": profile.get("data_disk_size_gb", defaults["data_disk_size_gb"]),
        "container_images": {key: images[key] for key in SERVICE_KEYS},
        "app_images": dict(app_images),
        "compose_yaml": compose,
        "compose_sha256": hashlib.sha256(compose.encode("utf-8")).hexdigest(),
        "secret_names": defaults["secret_names"],
        "docker_package_versions": defaults["docker_package_versions"],
    }
    if not re.match(r"^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) ", ankay_host["admin_ssh_public_key"]):
        raise RenderError("admin_ssh_public_key must be a public SSH key")
    if not re.fullmatch(r"24\.04\.[0-9]{9}|[0-9]{8}(\.[0-9]+)?", ankay_host["ubuntu_image_version"]):
        raise RenderError("ubuntu_image_version must be an exact Ubuntu 24.04 image version")
    return compose, ankay_host


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--published", type=Path, required=True)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--compose-out", type=Path, required=True)
    parser.add_argument("--json-out", type=Path, required=True)
    args = parser.parse_args()
    try:
        compose, ankay_host = render(
            json.loads(args.published.read_text(encoding="utf-8")),
            json.loads(args.profile.read_text(encoding="utf-8")),
        )
    except (RenderError, OSError, json.JSONDecodeError) as error:
        print(f"render_ankay_host: {error}", file=sys.stderr)
        return 1
    args.compose_out.write_text(compose, encoding="utf-8", newline="\n")
    args.json_out.write_text(json.dumps(ankay_host, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"render_ankay_host: compose_sha256={ankay_host['compose_sha256']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
