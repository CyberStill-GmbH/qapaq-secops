#!/usr/bin/env python3
"""Install optional Sophos/Cato collectors and Wazuh JSONL sources on a clean SIEM."""

from __future__ import annotations

import configparser
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

try:
    import grp
except ImportError:  # Windows unit-test runner; deployment is Ubuntu 24.04.
    grp = None


BEGIN = "<!-- QAPAQ:provider-ingestion:begin -->"
END = "<!-- QAPAQ:provider-ingestion:end -->"
DEFAULTS = {
    "sophos_enabled": "false",
    "sophos_tenant_id": "",
    "sophos_data_region": "",
    "cato_enabled": "false",
    "cato_account_id": "",
}


def enabled(value: str) -> bool:
    if value not in ("true", "false"):
        raise ValueError("provider enabled value must be true or false")
    return value == "true"


def install_sophos(config: dict[str, str], root: pathlib.Path, secrets: pathlib.Path) -> bool:
    if not enabled(config["sophos_enabled"]):
        return False
    tenant = config["sophos_tenant_id"]
    region = config["sophos_data_region"]
    if not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", tenant):
        raise ValueError("Sophos tenant GUID is invalid")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", region):
        raise ValueError("Sophos tenant and data region are required")
    client_id = secrets / "sophos-client-id"
    client_secret = secrets / "sophos-client-secret"
    if any(not path.is_file() or path.is_symlink() for path in (client_id, client_secret)):
        raise ValueError("Sophos Key Vault references are missing")
    home = root / "etc/qapaq-providers/sophos"
    log_dir = root / "logs/qapaq-providers"
    state_dir = root / "var/run/qapaq-providers/sophos"
    home.mkdir(mode=0o750, parents=True, exist_ok=True)
    (home / "log").mkdir(mode=0o750, exist_ok=True)
    log_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
    for directory in (home, home / "log", log_dir):
        os.chmod(directory, 0o750)
    if grp is not None and hasattr(os, "chown"):
        os.chown(log_dir, 0, grp.getgrnam("wazuh").gr_gid)
    os.chmod(log_dir, 0o750)
    state_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
    os.chmod(state_dir, 0o750)
    upstream = pathlib.Path(__file__).with_name("sophos") / "upstream"
    destination = root / "integrations/qapaq-sophos"
    destination.mkdir(mode=0o750, parents=True, exist_ok=True)
    for filename in ("siem.py", "state.py", "name_mapping.py", "config.py", "api_client.py", "vercheck.py"):
        shutil.copyfile(upstream / filename, destination / filename)
    parser = configparser.ConfigParser()
    client_id_value = client_id.read_text(encoding="utf-8").strip()
    client_secret_value = client_secret.read_text(encoding="utf-8").strip()
    if not client_id_value or not client_secret_value or any(c in client_id_value + client_secret_value for c in "\r\n\x00"):
        raise ValueError("Sophos Key Vault references are malformed")
    parser["login"] = {
        "client_id": client_id_value,
        # ConfigParser uses percent interpolation in the upstream client; double percent
        # on disk so the value read by the vendor client remains byte-for-byte unchanged.
        "client_secret": client_secret_value.replace("%", "%%"),
        "tenant_id": tenant,
        "auth_url": "https://id.sophos.com/api/v2/oauth2/token",
        "api_host": "api.central.sophos.com",
        "format": "json",
        "filename": "qapaq-sophos.jsonl",
        "endpoint": "all",
        "address": "/dev/log",
        "facility": "daemon",
        "socktype": "udp",
        "state_file_path": str(state_dir / "siem_sophos.json"),
    }
    parser["login"]["filename"] = str(log_dir / "sophos.jsonl")
    config_path = secrets / "sophos-client.ini"
    with config_path.open("w", encoding="utf-8") as stream:
        parser.write(stream)
    os.chmod(config_path, 0o600)
    (root / "etc/qapaq-providers").mkdir(mode=0o750, parents=True, exist_ok=True)
    return True


def install_cato(config: dict[str, str], root: pathlib.Path, secrets: pathlib.Path) -> bool:
    if not enabled(config["cato_enabled"]):
        return False
    account = config["cato_account_id"]
    api_key = secrets / "cato-api-key"
    if not account.isdigit() or not api_key.is_file() or api_key.is_symlink():
        raise ValueError("Cato account or Key Vault reference is missing")
    home = root / "etc/qapaq-providers/cato"
    log_dir = root / "logs/qapaq-providers"
    state_dir = root / "var/run/qapaq-providers/cato"
    for directory in (home, log_dir, state_dir):
        directory.mkdir(mode=0o750, parents=True, exist_ok=True)
        os.chmod(directory, 0o750)
    if grp is not None and hasattr(os, "chown"):
        os.chown(log_dir, 0, grp.getgrnam("wazuh").gr_gid)
    os.chmod(log_dir, 0o750)
    script = pathlib.Path(__file__).with_name("cato") / "events_feed.py"
    destination = root / "integrations/qapaq-cato/events_feed.py"
    destination.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    shutil.copyfile(script, destination)
    cato_config = {
        "account_id": account,
        "api_key_file": str(api_key),
        "state_file": str(state_dir / "marker.json"),
        "output_file": str(log_dir / "cato.jsonl"),
    }
    (home / "config.json").write_text(json.dumps(cato_config, separators=(",", ":")) + "\n", encoding="utf-8")
    os.chmod(home / "config.json", 0o640)
    return True


def provider_xml(sophos: bool, cato: bool) -> str:
    blocks = []
    for vendor, active in (("sophos", sophos), ("cato", cato)):
        if active:
            blocks.append(
                "  <localfile>\n"
                f"    <location>/var/ossec/logs/qapaq-providers/{vendor}.jsonl</location>\n"
                "    <log_format>json</log_format>\n"
                f"    <label key=\"integration.vendor\">{vendor}</label>\n"
                "    <label key=\"integration.channel\">provider-api</label>\n"
                "  </localfile>"
            )
    if not blocks:
        return ""
    return f"{BEGIN}\n" + "\n".join(blocks) + f"\n{END}"


def update_ossec_conf(path: pathlib.Path, managed_xml: str) -> None:
    text = path.read_text(encoding="utf-8")
    if text.count(BEGIN) != text.count(END) or text.count(BEGIN) > 1:
        raise ValueError("existing provider block is malformed")
    if BEGIN in text:
        start = text.index(BEGIN)
        finish = text.index(END, start) + len(END)
        text = text[:start] + text[finish:]
    if managed_xml:
        closing = text.rfind("</ossec_config>")
        if closing < 0:
            raise ValueError("ossec.conf has no closing ossec_config tag")
        text = text[:closing] + managed_xml + "\n" + text[closing:]
    ET.fromstring(text)
    temporary = path.with_suffix(".qapaq.tmp")
    temporary.write_text(text, encoding="utf-8")
    os.chmod(temporary, path.stat().st_mode & 0o777)
    os.replace(temporary, path)


def run(
    config_path: pathlib.Path,
    root: pathlib.Path,
    secrets: pathlib.Path,
    ossec_conf: pathlib.Path,
    unit_dir: pathlib.Path,
) -> int:
    original_conf: bytes | None = None
    original_mode = 0o600
    try:
        original_conf = ossec_conf.read_bytes()
        original_mode = ossec_conf.stat().st_mode & 0o777
        raw = json.loads(config_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or set(raw) - set(DEFAULTS):
            raise ValueError("unknown provider configuration key")
        config = DEFAULTS | {key: str(value) for key, value in raw.items()}
        sophos = install_sophos(config, root, secrets)
        cato = install_cato(config, root, secrets)
        update_ossec_conf(ossec_conf, provider_xml(sophos, cato))
        unit_source = pathlib.Path(__file__).with_name("systemd")
        unit_target = unit_dir
        for unit_name, active in (("qapaq-sophos-ingest.timer", sophos), ("qapaq-cato-ingest.timer", cato)):
            service_name = unit_name.removesuffix(".timer") + ".service"
            for name in (unit_name, service_name):
                source = unit_source / name
                if active:
                    shutil.copyfile(source, unit_target / name)
                    os.chmod(unit_target / name, 0o644)
            if not active:
                subprocess.run(["systemctl", "disable", "--now", unit_name], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["systemctl", "daemon-reload"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for unit_name, active in (("qapaq-sophos-ingest.timer", sophos), ("qapaq-cato-ingest.timer", cato)):
            if active:
                subprocess.run(["systemctl", "enable", "--now", unit_name], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["systemctl", "restart", "wazuh-manager"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return 0
    except (OSError, ValueError, json.JSONDecodeError, KeyError, ET.ParseError, subprocess.SubprocessError):
        try:
            if original_conf is not None and ossec_conf.read_bytes() != original_conf:
                temporary = ossec_conf.with_suffix(".qapaq-rollback.tmp")
                temporary.write_bytes(original_conf)
                os.chmod(temporary, original_mode)
                os.replace(temporary, ossec_conf)
            for unit_name in ("qapaq-sophos-ingest.timer", "qapaq-cato-ingest.timer"):
                subprocess.run(["systemctl", "disable", "--now", unit_name], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(["systemctl", "daemon-reload"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(["systemctl", "restart", "wazuh-manager"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            pass
        print("qapaq-provider-ingestion: invalid configuration; Wazuh config unchanged", file=sys.stderr)
        return 1


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=pathlib.Path, required=True)
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path("/var/ossec"))
    parser.add_argument("--secrets", type=pathlib.Path, default=pathlib.Path("/etc/qapaq-secrets"))
    parser.add_argument("--ossec-conf", type=pathlib.Path, default=pathlib.Path("/var/ossec/etc/ossec.conf"))
    parser.add_argument("--unit-dir", type=pathlib.Path, default=pathlib.Path("/etc/systemd/system"))
    args = parser.parse_args()
    return run(args.config, args.root, args.secrets, args.ossec_conf, args.unit_dir)


if __name__ == "__main__":
    raise SystemExit(main())
