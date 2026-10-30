#!/usr/bin/env python3
"""Instala la integración Wazuh → Ankay (custom-qapaq-shuffle) en el Manager de Azure.

Toma la URL privada del webhook de entrada (fija: la genera el importador de playbooks
con un ID determinista) y el token de cabecera materializado desde Key Vault. Escribe el
archivo protegido que lee el adaptador, agrega el bloque marcado a ossec.conf, valida con
wazuh-analysisd -t y reinicia el Manager; ante cualquier fallo restaura lo anterior. El
token nunca va a argv, ossec.conf ni logs.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

INTEGRATION_NAME = "custom-qapaq-shuffle"
SECRET_BASENAME = "qapaq-shuffle-webhook.json"
BEGIN = "<!-- QAPAQ:ankay-webhook:begin -->"
END = "<!-- QAPAQ:ankay-webhook:end -->"
TOKEN = re.compile(r"^[A-Za-z0-9._~-]{32,256}$")
URL = re.compile(r"^http://(?P<ip>[0-9.]+):5001/api/v1/hooks/webhook_[0-9a-f-]{36}$")


def fail(message: str) -> None:
    print(f"QAPAQ Ankay webhook: ERROR {message}", file=sys.stderr)
    raise SystemExit(1)


def read_token(path: pathlib.Path) -> str:
    if path.is_symlink() or not path.is_file():
        fail("el token del webhook no es un archivo normal")
    if os.name != "nt" and path.stat().st_mode & 0o077:
        fail("el token del webhook tiene permisos demasiado amplios")
    token = path.read_text(encoding="utf-8").strip()
    if not TOKEN.fullmatch(token):
        fail("el token del webhook no tiene el formato esperado")
    return token


def validate_url(url: str) -> None:
    match = URL.fullmatch(url)
    if not match:
        fail("la URL del webhook Ankay no es http://<IP privada>:5001/api/v1/hooks/webhook_<uuid>")
    try:
        address = ipaddress.ip_address(match.group("ip"))
    except ValueError:
        fail("la IP del webhook Ankay no es válida")
    if address.version != 4 or not address.is_private or address.is_loopback:
        fail("la IP del webhook Ankay debe ser privada RFC1918")


def merge_config(config: str, block: str) -> str:
    pattern = re.compile(r"(?ms)^([ \t]*)" + re.escape(BEGIN) + r".*?" + re.escape(END) + r"[ \t]*\n?")
    matches = list(pattern.finditer(config))
    if len(matches) > 1:
        raise ValueError("ossec.conf contiene más de un bloque marcado de Ankay")
    wrapped = f"  {BEGIN}\n{block.strip()}\n  {END}\n"
    if matches:
        return config[: matches[0].start()] + wrapped + config[matches[0].end():]
    for integration in re.findall(r"<integration\b[^>]*>.*?</integration>", config, flags=re.DOTALL):
        name = re.search(r"<name>(.*?)</name>", integration, flags=re.DOTALL)
        if name and name.group(1).strip() == INTEGRATION_NAME:
            raise ValueError("ossec.conf ya contiene la integración Shuffle sin marcadores QAPAQ")
    closing = list(re.finditer(r"</ossec_config\s*>", config))
    if not closing:
        raise ValueError("ossec.conf no contiene el cierre ossec_config")
    position = closing[-1].start()
    return config[:position] + wrapped + config[position:]


def atomic_write(path: pathlib.Path, contents: str, mode: int) -> None:
    fd, raw = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = pathlib.Path(raw)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def run(*args: str) -> int:
    return subprocess.run(list(args), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False).returncode


def install(wazuh_root: pathlib.Path, token_file: pathlib.Path, url: str, adapter: pathlib.Path, template: pathlib.Path) -> None:
    if os.geteuid() != 0:
        fail("la configuración requiere root")
    validate_url(url)
    token = read_token(token_file)
    for item in (adapter, template):
        if not item.is_file() or item.is_symlink():
            fail("faltan archivos versionados de la integración Ankay")
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
    try:
        updated = merge_config(conf.read_text(encoding="utf-8"), template.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        fail("ossec.conf no permite integrar Ankay de forma segura")

    backup = wazuh_root / "backup" / f"qapaq-ankay-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{os.getpid()}"
    backup.mkdir(mode=0o700, parents=True, exist_ok=False)
    shutil.copy2(conf, backup / "ossec.conf")
    target_script = integration_dir / INTEGRATION_NAME
    target_secret = hook_dir / SECRET_BASENAME
    previous = {}
    for target in (target_script, target_secret):
        if target.is_symlink() or (target.exists() and not target.is_file()):
            fail("un destino de la integración Ankay no es un archivo normal")
        if target.exists():
            previous[target] = backup / f"{target.name}.previous"
            shutil.copy2(target, previous[target])
    try:
        for directory in (integration_dir, hook_dir):
            directory.mkdir(mode=0o750, parents=True, exist_ok=True)
            os.chown(directory, 0, group_id)
            os.chmod(directory, 0o750)
        shutil.copyfile(adapter, target_script)
        os.chown(target_script, 0, group_id)
        os.chmod(target_script, 0o750)
        atomic_write(target_secret, json.dumps({"url": url, "header_token": token, "network": "azure-private"}), 0o640)
        os.chown(target_secret, 0, group_id)
        atomic_write(conf, updated, stat.S_IMODE(conf.stat().st_mode))
        if run(str(analysisd), "-t") != 0:
            raise RuntimeError("Wazuh rejected the Ankay integration")
        if run("systemctl", "restart", "wazuh-manager") != 0 or run("systemctl", "is-active", "--quiet", "wazuh-manager") != 0:
            raise RuntimeError("Wazuh Manager is not active after restart")
    except (OSError, RuntimeError):
        shutil.copy2(backup / "ossec.conf", conf)
        for target in (target_script, target_secret):
            if target in previous:
                shutil.copy2(previous[target], target)
            else:
                target.unlink(missing_ok=True)
        run("systemctl", "restart", "wazuh-manager")
        fail("la integración Ankay no pasó validación; se restauró ossec.conf y se reinició Wazuh")
    finally:
        token = ""
    print("QAPAQ Ankay webhook: adaptador instalado, configuración validada y Manager activo.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wazuh-root", type=pathlib.Path, required=True)
    parser.add_argument("--token-file", type=pathlib.Path, required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--adapter", type=pathlib.Path, required=True)
    parser.add_argument("--integration-template", type=pathlib.Path, required=True)
    args = parser.parse_args()
    install(args.wazuh_root, args.token_file, args.url, args.adapter, args.integration_template)


if __name__ == "__main__":
    main()
