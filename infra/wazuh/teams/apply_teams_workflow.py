#!/usr/bin/env python3
"""Install the QAPAQ Teams Workflows integration on Wazuh Manager 4.x.

The signed endpoint is read from a root-only Key Vault materialization and is
copied to Wazuh's protected integration directory. It is never written to the
manager configuration or emitted to stdout/stderr.
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.parse
from datetime import datetime, timezone


BEGIN = "<!-- QAPAQ:teams-workflows:begin -->"
END = "<!-- QAPAQ:teams-workflows:end -->"
INTEGRATION_NAME = "custom-qapaq-teams"
SECRET_BASENAME = "qapaq-teams-workflow-url"
URL_MARKERS = ("/workflows/", "/powerautomate/automations/direct/workflows/")


def fail(message: str) -> None:
    print(f"QAPAQ Teams: {message}", file=sys.stderr)
    raise SystemExit(1)


def validate_secret_file(path: pathlib.Path) -> None:
    try:
        metadata = path.lstat()
    except OSError:
        fail("no se pudo abrir la referencia segura de Workflows")
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) & 0o077:
        fail("la referencia segura de Workflows requiere archivo root-only, modo 0600")
    try:
        value = path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError):
        fail("la referencia segura de Workflows no es texto UTF-8 válido")
    parsed = urllib.parse.urlsplit(value)
    hostname = (parsed.hostname or "").lower()
    allowed_host = hostname.endswith(".logic.azure.com") or hostname.endswith(".api.powerplatform.com")
    path_lower = parsed.path.lower()
    allowed_path = any(marker in path_lower for marker in URL_MARKERS)
    try:
        allowed_port = parsed.port in (None, 443)
    except ValueError:
        allowed_port = False
    if (
        parsed.scheme != "https"
        or not allowed_host
        or not allowed_path
        or not allowed_port
        or "/incomingwebhook/" in path_lower
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or "\n" in value
        or "\r" in value
    ):
        fail("la referencia no corresponde a un endpoint HTTPS compatible de Teams Workflows")


def merge_config(config: str, block: str) -> str:
    marked = re.compile(
        r"(?m)^([ \t]*)" + re.escape(BEGIN) + r".*?^([ \t]*)" + re.escape(END),
        re.DOTALL,
    )
    matches = list(marked.finditer(config))
    if len(matches) > 1:
        raise ValueError("ossec.conf contiene más de un bloque marcado de Teams")
    if matches:
        indent = matches[0].group(1)
        replacement = f"{indent}{BEGIN}\n{block.strip()}\n{indent}{END}"
        return marked.sub(lambda _: replacement, config, count=1)

    integrations = re.findall(r"<integration\b[^>]*>.*?</integration>", config, flags=re.DOTALL)
    for integration in integrations:
        name = re.search(r"<name>\s*([^<]+)\s*</name>", integration)
        if name and name.group(1).strip() == INTEGRATION_NAME:
            raise ValueError("ossec.conf ya contiene Teams sin los marcadores de propiedad QAPAQ")

    closing = list(re.finditer(r"</ossec_config\s*>", config))
    if not closing:
        raise ValueError("ossec.conf no contiene el cierre ossec_config")
    index = closing[-1].start()
    wrapped = f"  {BEGIN}\n{block.strip()}\n  {END}\n"
    return config[:index] + wrapped + config[index:]


def atomic_write(path: pathlib.Path, contents: str, mode: int) -> None:
    fd, raw_temp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = pathlib.Path(raw_temp)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def install(wazuh_root: pathlib.Path, secret_source: pathlib.Path, adapter: pathlib.Path, template: pathlib.Path) -> None:
    if os.geteuid() != 0:
        fail("la configuración requiere root")
    validate_secret_file(secret_source)
    for item in (adapter, template):
        if not item.is_file() or item.is_symlink():
            fail("faltan archivos versionados de la integración Teams")
    try:
        group_id = __import__("pwd").getpwnam("wazuh").pw_gid
    except KeyError:
        fail("el grupo wazuh no existe después de instalar Wazuh Manager")

    conf = wazuh_root / "etc" / "ossec.conf"
    analysisd = wazuh_root / "bin" / "wazuh-analysisd"
    integration_dir = wazuh_root / "integrations"
    hook_dir = wazuh_root / "etc" / "integrations"
    if conf.is_symlink() or not conf.is_file() or not analysisd.is_file():
        fail("Wazuh Manager no está instalado completamente")
    for directory in (integration_dir, hook_dir):
        if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
            fail("un directorio de la integración Teams no es un directorio normal")
    try:
        block = template.read_text(encoding="utf-8").strip()
        current = conf.read_text(encoding="utf-8")
        updated = merge_config(current, block)
    except (OSError, UnicodeError, ValueError):
        fail("ossec.conf no permite integrar Teams de forma segura")

    backup_dir = wazuh_root / "backup" / f"qapaq-teams-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{os.getpid()}"
    backup_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    shutil.copy2(conf, backup_dir / "ossec.conf")
    target_script = integration_dir / INTEGRATION_NAME
    target_secret = hook_dir / SECRET_BASENAME
    for target in (target_script, target_secret):
        if target.is_symlink() or (target.exists() and not target.is_file()):
            fail("un destino de la integración Teams no es un archivo normal")
    prior_script = backup_dir / "custom-qapaq-teams.previous"
    prior_secret = backup_dir / "qapaq-teams-workflow-url.previous"
    script_existed = target_script.exists()
    secret_existed = target_secret.exists()
    if script_existed:
        shutil.copy2(target_script, prior_script)
    if secret_existed:
        shutil.copy2(target_secret, prior_secret)
    try:
        integration_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
        hook_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
        os.chown(integration_dir, 0, group_id)
        os.chmod(integration_dir, 0o750)
        os.chown(hook_dir, 0, group_id)
        os.chmod(hook_dir, 0o750)
        shutil.copyfile(adapter, target_script)
        os.chown(target_script, 0, group_id)
        os.chmod(target_script, 0o750)
        shutil.copyfile(secret_source, target_secret)
        os.chown(target_secret, 0, group_id)
        os.chmod(target_secret, 0o640)
        atomic_write(conf, updated, stat.S_IMODE(conf.stat().st_mode))
        check = subprocess.run(
            [str(analysisd), "-t"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False
        )
        if check.returncode != 0:
            raise RuntimeError("Wazuh rejected the Teams configuration")
        restart = subprocess.run(
            ["systemctl", "restart", "wazuh-manager"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if restart.returncode != 0:
            raise RuntimeError("Wazuh Manager did not restart")
        active = subprocess.run(
            ["systemctl", "is-active", "--quiet", "wazuh-manager"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if active.returncode != 0:
            raise RuntimeError("Wazuh Manager is not active after restart")
    except (OSError, RuntimeError):
        shutil.copy2(backup_dir / "ossec.conf", conf)
        if script_existed:
            shutil.copy2(prior_script, target_script)
        else:
            target_script.unlink(missing_ok=True)
        if secret_existed:
            shutil.copy2(prior_secret, target_secret)
        else:
            target_secret.unlink(missing_ok=True)
        subprocess.run(
            ["systemctl", "restart", "wazuh-manager"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        fail("Teams no pasó validación; se restauró ossec.conf y se reinició Wazuh")
    print("QAPAQ Teams: adaptador Workflows instalado, configuración validada y Manager activo.")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wazuh-root", type=pathlib.Path, required=True)
    parser.add_argument("--secret-source", type=pathlib.Path, required=True)
    parser.add_argument("--adapter", type=pathlib.Path, required=True)
    parser.add_argument("--integration-template", type=pathlib.Path, required=True)
    args = parser.parse_args()
    install(args.wazuh_root, args.secret_source, args.adapter, args.integration_template)


if __name__ == "__main__":
    main()
