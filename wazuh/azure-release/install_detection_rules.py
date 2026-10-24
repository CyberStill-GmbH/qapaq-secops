#!/usr/bin/env python3
"""Atomically install the QAPAQ endpoint/provider rules into Wazuh's local ruleset."""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import shutil
import stat
import subprocess
import tempfile
import xml.etree.ElementTree as ET

try:
    import grp
except ImportError:  # Windows test runner; deployment runs on Ubuntu.
    grp = None


RULE_FILES = (
    pathlib.Path("launch-detections/rules/qapaq_launch_provider_rules.xml"),
    pathlib.Path("endpoint/rules/qapaq_endpoint_rules.xml"),
)
RULESET = re.compile(r"<ruleset(?:\s[^>]*)?>(.*?)</ruleset>", re.DOTALL)
LOCAL_RULE_DIR = re.compile(r"<rule_dir(?:\s[^>]*)?>\s*etc/rules\s*</rule_dir>")


class InstallError(RuntimeError):
    pass


def _atomic_write(
    path: pathlib.Path,
    content: bytes,
    mode: int,
    owner: tuple[int, int] | None = None,
) -> None:
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
        os.chmod(temp_name, mode)
        if owner is not None and hasattr(os, "chown"):
            os.chown(temp_name, *owner)
        elif grp is not None and hasattr(os, "chown"):
            os.chown(temp_name, 0, grp.getgrnam("wazuh").gr_gid)
        os.replace(temp_name, path)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def _validate_rule_file(path: pathlib.Path) -> None:
    if not path.is_file() or path.is_symlink():
        raise InstallError(f"required QAPAQ rule file missing: {path.name}")
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as error:
        raise InstallError(f"QAPAQ rule XML is invalid: {path.name}") from error
    if root.tag != "group" or not root.findall("rule"):
        raise InstallError(f"QAPAQ rule XML has no root group or rules: {path.name}")


def _updated_ossec_conf(content: bytes) -> bytes:
    text = content.decode("utf-8")
    matches = list(RULESET.finditer(text))
    if len(matches) != 1:
        raise InstallError("ossec.conf must contain exactly one ruleset block")
    match = matches[0]
    if LOCAL_RULE_DIR.search(match.group(1)):
        return content
    insertion = "\n    <rule_dir>etc/rules</rule_dir>\n  "
    closing = match.end() - len("</ruleset>")
    updated = (text[:closing] + insertion + text[closing:]).encode("utf-8")
    try:
        ET.fromstring(updated)
    except ET.ParseError as error:
        raise InstallError("could not safely add etc/rules to the Wazuh ruleset") from error
    return updated


def _restore(backups: dict[pathlib.Path, tuple[bytes, int, int, int] | None]) -> None:
    for path, backup in backups.items():
        if backup is None:
            path.unlink(missing_ok=True)
        else:
            content, mode, uid, gid = backup
            _atomic_write(path, content, mode, (uid, gid))


def install(bundle_wazuh: pathlib.Path, wazuh_root: pathlib.Path, *, restart: bool = True) -> None:
    source_root = bundle_wazuh.resolve()
    rules_dir = wazuh_root / "etc" / "rules"
    config_path = wazuh_root / "etc" / "ossec.conf"
    analysisd = wazuh_root / "bin" / "wazuh-analysisd"
    if (
        not config_path.is_file()
        or config_path.is_symlink()
        or not rules_dir.is_dir()
        or rules_dir.is_symlink()
        or not analysisd.is_file()
    ):
        raise InstallError("Wazuh manager paths are incomplete; refusing to install local rules")

    sources = [source_root / relative for relative in RULE_FILES]
    for source in sources:
        _validate_rule_file(source)

    targets = [rules_dir / source.name for source in sources]
    all_paths = [config_path, *targets]
    backups: dict[pathlib.Path, tuple[bytes, int, int, int] | None] = {}
    for path in all_paths:
        if path.is_symlink():
            raise InstallError(f"refusing to replace symlink: {path.name}")
        info = path.stat() if path.exists() else None
        backups[path] = (
            (path.read_bytes(), stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
            if info is not None
            else None
        )

    try:
        for source, target in zip(sources, targets):
            _atomic_write(target, source.read_bytes(), 0o640)
        config_backup = backups[config_path]
        assert config_backup is not None
        mode = config_backup[1]
        _atomic_write(config_path, _updated_ossec_conf(config_backup[0]), mode,
                      (config_backup[2], config_backup[3]))

        checked = subprocess.run([str(analysisd), "-t"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if checked.returncode != 0:
            raise InstallError("wazuh-analysisd rejected the QAPAQ rules; previous local rules were restored")
        if restart:
            restarted = subprocess.run(["systemctl", "restart", "wazuh-manager"], check=False,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if restarted.returncode != 0:
                raise InstallError("wazuh-manager restart failed; previous local rules were restored")
    except Exception:
        _restore(backups)
        if restart:
            subprocess.run(["systemctl", "restart", "wazuh-manager"], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle-wazuh", type=pathlib.Path, required=True)
    parser.add_argument("--wazuh-root", type=pathlib.Path, default=pathlib.Path("/var/ossec"))
    args = parser.parse_args()
    try:
        install(args.bundle_wazuh, args.wazuh_root)
    except (OSError, InstallError, KeyError, UnicodeError) as error:
        print(f"qapaq-detection-rules: {error}", file=os.sys.stderr)
        return 1
    print("qapaq-detection-rules: endpoint and provider rules installed and manager restarted")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
