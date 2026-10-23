#!/usr/bin/env python3
"""Assemble the pinned CI outputs into the siem_host offline release contract.

This tool never creates credentials or certificate material. The installer assistant,
QAPAQ dashboard/core, Wazuh packages, Filebeat module/template and signing key are
inputs from separately verified build steps.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tarfile
import tempfile


WAZUH = "4.14.8"
OSD = "2.19.6"
NODE = "24.21.0"
FILEBEAT = "7.10.2-2"
ASSISTANT_COMMIT = "33d2069715e8500b676d13cefe7ddaea8eb79019"
ASSISTANT_TAG = "v4.14.8"


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def command(*args: str) -> str:
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE).strip()


def package_field(path: pathlib.Path, field: str) -> str:
    return command("dpkg-deb", "--field", str(path), field)


def validate_package(path: pathlib.Path, name: str, version: str | None = None) -> str:
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"package input missing or not a regular file: {name}")
    if package_field(path, "Package") != name:
        raise ValueError(f"unexpected Debian package identity: {name}")
    actual_version = package_field(path, "Version")
    if version is not None and actual_version != version:
        raise ValueError(f"unexpected Debian version for {name}")
    if package_field(path, "Architecture") != "amd64":
        raise ValueError(f"unexpected Debian architecture for {name}")
    return actual_version


def copy_regular(source: pathlib.Path, destination: pathlib.Path) -> None:
    if not source.is_file() or source.is_symlink():
        raise ValueError(f"required release input missing or not a regular file: {source.name}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def sha256_map(root: pathlib.Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): sha256(path)
        for path in sorted(root.rglob("*"))
        if path.is_file() and path.name != "manifest.json"
    }


def assemble(args: argparse.Namespace) -> pathlib.Path:
    assistant = pathlib.Path(args.assistant_dir).resolve()
    output = pathlib.Path(args.output_dir).resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError("output directory must be empty")
    if not (assistant / ".git").is_dir():
        raise ValueError("assistant input must be a git checkout of the official repository")
    if command("git", "-C", str(assistant), "rev-parse", "HEAD") != ASSISTANT_COMMIT:
        raise ValueError("official Wazuh installation assistant commit does not match the pin")
    if command("git", "-C", str(assistant), "describe", "--tags", "--exact-match") != ASSISTANT_TAG:
        raise ValueError("official Wazuh installation assistant tag does not match the pin")
    if not (assistant / "LICENSE").is_file():
        raise ValueError("official Wazuh installation assistant license is missing")

    qapaq_commit = args.qapaq_commit
    if len(qapaq_commit) != 40 or any(c not in "0123456789abcdef" for c in qapaq_commit):
        raise ValueError("QAPAQ commit must be a full lowercase Git SHA")
    manager_version = validate_package(pathlib.Path(args.manager_deb), "wazuh-manager", f"{WAZUH}-1")
    indexer_version = validate_package(pathlib.Path(args.indexer_deb), "wazuh-indexer", f"{WAZUH}-1")
    filebeat_version = validate_package(pathlib.Path(args.filebeat_deb), "filebeat", FILEBEAT)
    dashboard_version = validate_package(pathlib.Path(args.dashboard_deb), "wazuh-dashboard", f"{WAZUH}-1qapaq1")

    output.mkdir(parents=True, exist_ok=True)
    root = output / f"qapaq-siem-{qapaq_commit[:12]}"
    root.mkdir()
    try:
        installer_source = assistant / "wazuh-install.sh"
        if not installer_source.exists():
            result = subprocess.run(["bash", "builder.sh", "-i"], cwd=assistant, check=False)
            if result.returncode != 0 or not installer_source.is_file():
                raise ValueError("official installer build failed")
        copy_regular(installer_source, root / "official-wazuh" / "wazuh-install.sh")
        copy_regular(assistant / "LICENSE", root / "official-wazuh" / "LICENSE")
        copy_regular(assistant / "VERSION.json", root / "official-wazuh" / "VERSION.json")
        copy_regular(pathlib.Path(args.install_script), root / "install.sh")
        copy_regular(
            pathlib.Path(args.verify_credentials_script),
            root / "wazuh" / "azure-release" / "verify_wazuh_credentials_tar.py",
        )
        copy_regular(
            pathlib.Path(args.repo_root) / "wazuh" / "azure-release" / "normalize_ubuntu_apt_sources.py",
            root / "wazuh" / "azure-release" / "normalize_ubuntu_apt_sources.py",
        )

        packages = {
            "managerDeb": (pathlib.Path(args.manager_deb), "wazuh-manager"),
            "indexerDeb": (pathlib.Path(args.indexer_deb), "wazuh-indexer"),
            "filebeatDeb": (pathlib.Path(args.filebeat_deb), "filebeat"),
            "qapaqDashboardDeb": (pathlib.Path(args.dashboard_deb), "wazuh-dashboard"),
        }
        debian_packages = {
            "wazuh-manager": manager_version,
            "wazuh-indexer": indexer_version,
            "filebeat": filebeat_version,
            "wazuh-dashboard": dashboard_version,
        }
        artifact_paths: dict[str, str] = {}
        for key, (source, package_name) in packages.items():
            destination = root / "files" / "debs" / source.name
            copy_regular(source, destination)
            artifact_paths[key] = destination.relative_to(root).as_posix()
            copy_regular(destination, root / "offline" / "wazuh-offline" / "wazuh-packages" / source.name)

        offline_files = root / "offline" / "wazuh-offline" / "wazuh-files"
        copy_regular(pathlib.Path(args.filebeat_config), offline_files / "filebeat.yml")
        copy_regular(pathlib.Path(args.wazuh_signing_key), offline_files / "GPG-KEY-WAZUH")
        copy_regular(pathlib.Path(args.filebeat_module), offline_files / "wazuh-filebeat-0.5.tar.gz")
        copy_regular(pathlib.Path(args.filebeat_template), offline_files / "wazuh-template.json")
        offline_tar = root / "offline" / "wazuh-offline.tar.gz"
        with tarfile.open(offline_tar, "w:gz") as archive:
            archive.add(root / "offline" / "wazuh-offline", arcname="wazuh-offline")
        copy_regular(offline_tar, root / "official-wazuh" / "wazuh-offline.tar.gz")

        core = pathlib.Path(args.core_archive)
        if not core.is_file() or core.is_symlink() or not core.name.endswith(".tar.gz"):
            raise ValueError("QAPAQ core archive is missing or malformed")
        copy_regular(core, root / "files" / "core" / core.name)
        artifact_paths["qapaqCoreArchive"] = (root / "files" / "core" / core.name).relative_to(root).as_posix()

        core_installer = pathlib.Path(args.repo_root) / "wazuh" / "core"
        for name in ("apply-core-azure.sh", "verify_core_archive.py"):
            copy_regular(core_installer / name, root / "wazuh" / "core" / name)

        office365 = pathlib.Path(args.repo_root) / "wazuh" / "office365"
        for relative in (
            pathlib.Path("apply-office365.sh"),
            pathlib.Path("ossec-office365.xml.tmpl"),
            pathlib.Path("rules") / "qapaq_office365_rules.xml",
            pathlib.Path("lists") / "qapaq-break-glass.example",
        ):
            copy_regular(office365 / relative, root / "wazuh" / "office365" / relative)

        files = sha256_map(root)
        manifest = {
            "schemaVersion": 1,
            "status": "installable-candidate",
            "qapaqCommit": qapaq_commit,
            "components": {
                "wazuhManager": WAZUH,
                "wazuhIndexer": WAZUH,
                "wazuhFilebeat": WAZUH,
                "wazuhDashboard": WAZUH,
                "openSearchDashboards": OSD,
                "qapaqCoreNode": NODE,
            },
            "qapaqDashboardPackage": dashboard_version,
            "qapaqCoreSourceCommit": qapaq_commit[:12],
            "debianPackages": debian_packages,
            "artifacts": artifact_paths,
            "files": files,
            "sources": {
                "wazuhInstallationAssistant": {
                    "repository": "https://github.com/wazuh/wazuh-installation-assistant",
                    "tag": ASSISTANT_TAG,
                    "commit": ASSISTANT_COMMIT,
                    "license": "GPL-2.0",
                },
                "wazuhManager": {"repository": "https://github.com/wazuh/wazuh", "commit": args.manager_commit},
                "wazuhIndexer": {"repository": "https://github.com/wazuh/wazuh-indexer", "commit": args.indexer_commit},
            },
        }
        (root / "manifest.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        bundle = output / f"{root.name}.tar.gz"
        with tarfile.open(bundle, "w:gz") as archive:
            archive.add(root, arcname=root.name)
        (output / "SHA256SUMS").write_text(f"{sha256(bundle)}  {bundle.name}\n", encoding="utf-8")
        return bundle
    except Exception:
        shutil.rmtree(root, ignore_errors=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("manager-deb", "indexer-deb", "filebeat-deb", "dashboard-deb", "core-archive", "assistant-dir", "filebeat-config", "wazuh-signing-key", "filebeat-module", "filebeat-template", "install-script", "verify-credentials-script", "repo-root", "output-dir", "qapaq-commit", "manager-commit", "indexer-commit"):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()
    try:
        bundle = assemble(args)
    except (OSError, subprocess.CalledProcessError, ValueError) as error:
        print(f"azure-siem-release: {type(error).__name__}: {error}", file=os.sys.stderr)
        return 1
    print(f"bundle={bundle.name} sha256={sha256(bundle)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
