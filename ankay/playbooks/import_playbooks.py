#!/usr/bin/env python3
"""Importa de forma idempotente los workflows QAPAQ en Ankay (API de Shuffle 2.3).

Lo ejecuta el host Ankay después de que Compose queda saludable, dentro de la imagen
de la app «QAPAQ Ankay» y en la red interna de Compose. Credenciales por entorno
(cargadas desde Key Vault en runtime.env); nunca se imprimen:

  SHUFFLE_API_KEY               API key del administrador inicial (SHUFFLE_DEFAULT_APIKEY)
  ANKAY_WAZUH_WEBHOOK_TOKEN     cabecera X-Qapaq-Integration del webhook Wazuh → Ankay
  ANKAY_DISPATCH_WEBHOOK_TOKEN  cabecera X-Qapaq-Integration de los despachos QAPAQ Core
  ANKAY_DISPATCH_HMAC_KEY       clave HMAC con QAPAQ Core (autenticación de la app)

Idempotencia: cada workflow lleva las etiquetas ankay-playbook:<id>@<versión> y
ankay-sha256:<hash>. Si el hash no cambió no se toca; si cambió se actualiza el mismo
workflow (mismo ID); si no existe se crea. Los webhooks usan IDs deterministas.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

APP_NAME = "QAPAQ Ankay"
APP_VERSION = "1.0.0"
AUTH_LABEL = "QAPAQ dispatch HMAC"
WAZUH_INTAKE = "wazuh.alert-intake"
HEADER = "X-Qapaq-Integration"
TOKEN = re.compile(r"^[A-Za-z0-9._~-]{32,256}$")


class ImportError_(RuntimeError):
    """Fallo seguro de informar: no incluye credenciales ni cuerpos de respuesta."""


class ShuffleApi:
    def __init__(self, base_url: str, api_key: str, timeout: float = 20.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def call(self, method: str, path: str, body: Any = None, *, expect_json: bool = True) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            method=method,
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            raise ImportError_(f"{method} {path} devolvió HTTP {error.code}") from None
        except (urllib.error.URLError, OSError):
            raise ImportError_(f"{method} {path} no respondió") from None
        if not expect_json:
            return raw
        try:
            return json.loads(raw or b"null")
        except json.JSONDecodeError:
            raise ImportError_(f"{method} {path} devolvió JSON inválido") from None

    def wait_healthy(self, deadline_seconds: float) -> None:
        end = time.monotonic() + deadline_seconds
        while True:
            try:
                self.call("GET", "/api/v1/_ah/health", expect_json=False)
                return
            except ImportError_:
                if time.monotonic() > end:
                    raise ImportError_("el backend de Ankay no quedó disponible") from None
                time.sleep(5)


def _items(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, dict):
        value = value.get("data", value.get("workflows", value.get("apps", [])))
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def find_app(api: ShuffleApi, attempts: int = 12) -> str:
    for attempt in range(attempts):
        for app in _items(api.call("GET", "/api/v1/apps")):
            if app.get("name") == APP_NAME and app.get("app_version") == APP_VERSION and app.get("id"):
                return str(app["id"])
        if attempt == 0:
            # Fuerza la carga de /shuffle-apps (la app viene en la imagen del backend).
            api.call("GET", "/api/v1/apps/run_hotload", expect_json=False)
        time.sleep(5)
    raise ImportError_(f"la app {APP_NAME} {APP_VERSION} no está registrada en Ankay")


def ensure_auth(api: ShuffleApi, app_id: str, hmac_key: str) -> str:
    for auth in _items(api.call("GET", "/api/v1/apps/authentication")):
        app = auth.get("app") or {}
        if auth.get("label") == AUTH_LABEL and app.get("name") == APP_NAME and auth.get("id"):
            return str(auth["id"])
    created = api.call("PUT", "/api/v1/apps/authentication", {
        "label": AUTH_LABEL,
        "active": True,
        "app": {"name": APP_NAME, "id": app_id, "app_version": APP_VERSION},
        "fields": [{"key": "dispatch_hmac_key", "value": hmac_key}],
    })
    auth_id = created.get("id") if isinstance(created, dict) else None
    if not auth_id:
        # Algunas versiones no devuelven el ID; se relee la lista.
        for auth in _items(api.call("GET", "/api/v1/apps/authentication")):
            if auth.get("label") == AUTH_LABEL and auth.get("id"):
                return str(auth["id"])
        raise ImportError_("Ankay no confirmó la autenticación HMAC de la app")
    return str(auth_id)


def _tag(workflow: dict[str, Any], prefix: str) -> str | None:
    return next((t for t in workflow.get("tags", []) if isinstance(t, str) and t.startswith(prefix)), None)


def render(template: dict[str, Any], app_id: str, auth_id: str, auth_header: str) -> dict[str, Any]:
    text = json.dumps(template)
    text = text.replace("__QAPAQ_ANKAY_APP_ID__", app_id).replace("__QAPAQ_ANKAY_DISPATCH_AUTH_ID__", auth_id)
    text = text.replace("__QAPAQ_ANKAY_WEBHOOK_AUTH__", auth_header.replace("\\", "\\\\").replace('"', '\\"'))
    return json.loads(text)


def import_all(api: ShuffleApi, workflows_dir: Path, secrets: dict[str, str]) -> dict[str, int]:
    app_id = find_app(api)
    auth_id = ensure_auth(api, app_id, secrets["ANKAY_DISPATCH_HMAC_KEY"])
    existing: dict[str, dict[str, Any]] = {}
    for workflow in _items(api.call("GET", "/api/v1/workflows")):
        tag = _tag(workflow, "ankay-playbook:")
        if tag:
            existing[tag.split(":", 1)[1].split("@", 1)[0]] = workflow

    counts = {"created": 0, "updated": 0, "unchanged": 0}
    for path in sorted(workflows_dir.glob("*.json")):
        template = json.loads(path.read_text(encoding="utf-8"))
        tag = _tag(template, "ankay-playbook:")
        if not tag:
            raise ImportError_(f"{path.name} no tiene etiqueta ankay-playbook")
        playbook_id = tag.split(":", 1)[1].split("@", 1)[0]
        token = secrets["ANKAY_WAZUH_WEBHOOK_TOKEN"] if playbook_id == WAZUH_INTAKE else secrets["ANKAY_DISPATCH_WEBHOOK_TOKEN"]
        auth_header = f"{HEADER}: {token}"
        desired = render(template, app_id, auth_id, auth_header)
        current = existing.get(playbook_id)

        if current and _tag(current, "ankay-sha256:") == _tag(desired, "ankay-sha256:") and _tag(current, "ankay-playbook:") == tag:
            counts["unchanged"] += 1
        else:
            if current:
                workflow_id = str(current["id"])
                counts["updated"] += 1
            else:
                created = api.call("POST", "/api/v1/workflows", {"name": desired["name"], "description": desired["description"], "tags": desired["tags"]})
                workflow_id = str((created or {}).get("id", ""))
                if not workflow_id:
                    raise ImportError_(f"Ankay no devolvió el ID del workflow {playbook_id}")
                counts["created"] += 1
            desired["id"] = workflow_id
            if current and current.get("org_id"):
                desired["org_id"] = current["org_id"]
            api.call("PUT", f"/api/v1/workflows/{workflow_id}", desired)
            current = desired

        for trigger in desired.get("triggers", []):
            if trigger.get("trigger_type") != "WEBHOOK":
                continue
            api.call("POST", "/api/v1/hooks/new", {
                "name": f"QAPAQ {playbook_id}",
                "type": "webhook",
                "id": trigger["id"],
                "workflow": str(current["id"]),
                "start": desired["start"],
                "environment": "onprem",
                "auth": auth_header,
                "custom_response": "",
                "version": "",
                "version_timeout": 0,
            })
    return counts


def load_secrets(env: dict[str, str]) -> dict[str, str]:
    secrets = {}
    for name in ("ANKAY_WAZUH_WEBHOOK_TOKEN", "ANKAY_DISPATCH_WEBHOOK_TOKEN"):
        value = env.get(name, "")
        if not TOKEN.fullmatch(value):
            raise ImportError_(f"{name} falta o no es un token de 32-256 caracteres seguros")
        secrets[name] = value
    key = env.get("ANKAY_DISPATCH_HMAC_KEY", "")
    if len(key.encode("utf-8")) < 32 or any(c in key for c in "\r\n\x00"):
        raise ImportError_("ANKAY_DISPATCH_HMAC_KEY falta o tiene menos de 32 bytes")
    secrets["ANKAY_DISPATCH_HMAC_KEY"] = key
    if len(env.get("SHUFFLE_API_KEY", "")) < 32:
        raise ImportError_("SHUFFLE_API_KEY falta o es demasiado corta")
    return secrets


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-url", default=os.getenv("SHUFFLE_API_URL", "http://backend:5001"))
    parser.add_argument("--workflows", default="/opt/ankay/playbooks/workflows", type=Path)
    parser.add_argument("--wait-seconds", type=float, default=600)
    args = parser.parse_args()
    try:
        secrets = load_secrets(dict(os.environ))
        api = ShuffleApi(args.api_url, os.environ["SHUFFLE_API_KEY"])
        api.wait_healthy(args.wait_seconds)
        counts = import_all(api, args.workflows, secrets)
    except (ImportError_, OSError, json.JSONDecodeError, KeyError) as error:
        print(f"ankay-import: ERROR: {error}", file=sys.stderr)
        return 1
    print("ankay-import: creados={created} actualizados={updated} sin_cambios={unchanged}".format(**counts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
