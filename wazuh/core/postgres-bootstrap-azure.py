#!/usr/bin/python3
"""Roles y migración de PostgreSQL Flexible Server desde el host SIEM de Azure EUS2.

Lo ejecuta un Run Command administrado que lanza `.github/workflows/bootstrap-eus2-postgres.yml`.
Las credenciales llegan solo como parámetros protegidos (variables de entorno del Run Command):

  QAPAQ_MASTER_USERNAME   administrador de Terraform del Flexible Server
  QAPAQ_MASTER_PASSWORD   su contraseña (GitHub Environment secret)
  QAPAQ_RUNTIME_PASSWORD  contraseña nueva de `qapaq_soc_runtime`, ya escrita en Key Vault
                          como `qapaq-postgres-app-password`

Host, puerto, base y TLS salen del `core.env` que materializó el bootstrap. Invoca el migrator
empaquetado en el release activo (`migrator/`) en modo `azure-bootstrap` como `qapaq-core`, con
un entorno mínimo, y solo reenvía las líneas JSON del migrator: nunca imprime credenciales ni la
salida cruda de Prisma/pg. Si el API ya corre con `QAPAQ_SOC_PERSISTENCE=postgres`, lo reinicia
para que resuelva la contraseña rotada desde Key Vault y espera `/health/ready`.
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

CORE_ENV_PATH = pathlib.Path("/etc/qapaq-core/core.env")
RELEASE_PATH = pathlib.Path("/opt/qapaq-core/current")
RUNTIME_ROLE = "qapaq_soc_runtime"
POSTGRES_KEYS = (
    "QAPAQ_POSTGRES_HOST",
    "QAPAQ_POSTGRES_PORT",
    "QAPAQ_POSTGRES_DATABASE",
    "QAPAQ_POSTGRES_TLS",
)
LINE_PATTERN = re.compile(r'([A-Z][A-Z0-9_]{0,127})="((?:[^"\\]|\\["\\])*)"')
PASSWORD_PATTERN = re.compile(r"[A-Za-z0-9_-]{32,256}")
USERNAME_PATTERN = re.compile(r"[a-z][a-z0-9_]{0,62}")
HOST_PATTERN = re.compile(r"[a-z0-9][a-z0-9.-]{0,252}")
DATABASE_PATTERN = re.compile(r"[a-z][a-z0-9_]{0,62}")


class BootstrapError(Exception):
    """Error con un código seguro para imprimir."""


def log(event: str, **extra: str) -> None:
    print(json.dumps({"service": "qapaq-postgres-bootstrap-azure", "event": event, **extra}), flush=True)


def parse_core_env(text: str) -> dict[str, str]:
    """Lee el formato `KEY="valor"` que escribe el bootstrap del SIEM (comillas estilo systemd)."""
    values: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        match = LINE_PATTERN.fullmatch(line)
        if not match:
            raise BootstrapError("CORE_ENV_INVALID")
        values[match.group(1)] = re.sub(r"\\([\"\\])", r"\1", match.group(2))
    return values


def postgres_settings(core_env: dict[str, str]) -> dict[str, str]:
    settings = {key: core_env.get(key, "") for key in POSTGRES_KEYS}
    settings["QAPAQ_POSTGRES_PORT"] = settings["QAPAQ_POSTGRES_PORT"] or "5432"
    if (
        not HOST_PATTERN.fullmatch(settings["QAPAQ_POSTGRES_HOST"])
        or not settings["QAPAQ_POSTGRES_HOST"].endswith(".postgres.database.azure.com")
        or not re.fullmatch(r"[0-9]{1,5}", settings["QAPAQ_POSTGRES_PORT"])
        or not DATABASE_PATTERN.fullmatch(settings["QAPAQ_POSTGRES_DATABASE"])
        or settings["QAPAQ_POSTGRES_TLS"] != "true"
    ):
        raise BootstrapError("POSTGRES_SETTINGS_INVALID")
    username = core_env.get("QAPAQ_POSTGRES_USERNAME")
    if username is not None and username != RUNTIME_ROLE:
        raise BootstrapError("RUNTIME_USERNAME_MISMATCH")
    return settings


def credentials(environment: dict[str, str]) -> dict[str, str]:
    master_username = environment.get("QAPAQ_MASTER_USERNAME", "")
    master_password = environment.get("QAPAQ_MASTER_PASSWORD", "")
    runtime_password = environment.get("QAPAQ_RUNTIME_PASSWORD", "")
    if not USERNAME_PATTERN.fullmatch(master_username) or master_username in (RUNTIME_ROLE, "qapaq_migrator"):
        raise BootstrapError("MASTER_USERNAME_INVALID")
    if not master_password or any(character in master_password for character in "\r\n\x00"):
        raise BootstrapError("MASTER_PASSWORD_INVALID")
    if not PASSWORD_PATTERN.fullmatch(runtime_password) or runtime_password == master_password:
        raise BootstrapError("RUNTIME_PASSWORD_INVALID")
    return {
        "QAPAQ_MASTER_USERNAME": master_username,
        "QAPAQ_MASTER_PASSWORD": master_password,
        "QAPAQ_RUNTIME_PASSWORD": runtime_password,
    }


def migrator_environment(release: pathlib.Path, settings: dict[str, str], secrets: dict[str, str]) -> dict[str, str]:
    """Entorno mínimo: sin heredar variables del Run Command más allá de las credenciales."""
    return {
        "PATH": f"{release / 'node/bin'}:/usr/bin:/bin",
        "HOME": "/nonexistent",
        "NODE_ENV": "production",
        "NODE_EXTRA_CA_CERTS": str(release / "certs/rds-global-bundle.pem"),
        **settings,
        **secrets,
    }


def forward_migrator_output(stdout: str) -> None:
    """Reenvía solo eventos JSON del migrator; cualquier otra línea se descarta."""
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict) and event.get("service") == "qapaq-secops-migrator":
            print(json.dumps(event), flush=True)


def wait_ready(attempts: int = 60) -> None:
    for _ in range(attempts):
        try:
            with urllib.request.urlopen("http://127.0.0.1:3000/health/ready", timeout=3) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(2)
    raise BootstrapError("API_NOT_READY")


def main() -> int:
    try:
        if os.geteuid() != 0:
            raise BootstrapError("ROOT_REQUIRED")
        release = RELEASE_PATH.resolve(strict=True)
        entrypoint = release / "migrator/migrator/entrypoint.mjs"
        node = release / "node/bin/node"
        if not entrypoint.is_file() or not node.is_file():
            raise BootstrapError("MIGRATOR_NOT_IN_RELEASE")
        core_env = parse_core_env(CORE_ENV_PATH.read_text(encoding="utf-8"))
        settings = postgres_settings(core_env)
        secrets = credentials(dict(os.environ))
        log("started", release=release.name)
        result = subprocess.run(
            [str(node), str(entrypoint), "azure-bootstrap"],
            cwd=release / "migrator",
            env=migrator_environment(release, settings, secrets),
            user="qapaq-core",
            group="qapaq-core",
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=900,
            check=False,
        )
        del secrets
        forward_migrator_output(result.stdout)
        if result.returncode != 0:
            raise BootstrapError("MIGRATOR_FAILED")
        if core_env.get("QAPAQ_SOC_PERSISTENCE") == "postgres":
            subprocess.run(["systemctl", "restart", "qapaq-core-api"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            wait_ready()
            log("api_restarted")
        else:
            log("api_unchanged", persistence=core_env.get("QAPAQ_SOC_PERSISTENCE", "memory"))
        log("completed")
        return 0
    except BootstrapError as error:
        log("failed", errorCode=str(error))
    except (OSError, subprocess.SubprocessError):
        log("failed", errorCode="HOST_COMMAND_FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
