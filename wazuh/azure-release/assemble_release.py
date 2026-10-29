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
SOPHOS_SIEM_COMMIT = "4fd97bbc7ec54e507bca9eaf4245f136cc90097d"
SOPHOS_SIEM_TAG = "v2.1.0"


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_normalized_text(path: pathlib.Path) -> str:
    content = path.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    return hashlib.sha256(content).hexdigest()


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


def validate_sophos_source(repo_root: pathlib.Path) -> dict:
    source = repo_root / "wazuh" / "provider-ingestion" / "sophos"
    metadata = json.loads((source / "UPSTREAM-SOURCE.json").read_text(encoding="utf-8"))
    revision_parts = metadata.get("source_revision")
    revision = "".join(revision_parts) if isinstance(revision_parts, list) and all(isinstance(part, str) for part in revision_parts) else ""
    if (metadata.get("repository"), metadata.get("tag"), revision, metadata.get("license")) != (
        "https://github.com/sophos/Sophos-Central-SIEM-Integration", SOPHOS_SIEM_TAG, SOPHOS_SIEM_COMMIT, "Apache-2.0"
    ):
        raise ValueError("Sophos SIEM upstream identity does not match the immutable pin")
    files = metadata.get("files")
    if not isinstance(files, dict) or not files:
        raise ValueError("Sophos SIEM upstream file hashes are missing")
    for name, hash_parts in files.items():
        expected = "".join(hash_parts) if isinstance(hash_parts, list) and all(isinstance(part, str) for part in hash_parts) else ""
        if len(expected) != 64 or any(character not in "0123456789abcdef" for character in expected):
            raise ValueError(f"Sophos SIEM upstream hash metadata is invalid: {name}")
        path = source / name
        if not path.is_file() or path.is_symlink() or sha256_normalized_text(path) != expected:
            raise ValueError(f"Sophos SIEM upstream source hash mismatch: {name}")
    return {**metadata, "commit": revision}


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
    sophos_source_metadata = validate_sophos_source(pathlib.Path(args.repo_root).resolve())

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

        provider_ingestion = pathlib.Path(args.repo_root) / "wazuh" / "provider-ingestion"
        copy_regular(provider_ingestion / "sophos" / "UPSTREAM-SOURCE.json",
                     root / "wazuh" / "provider-ingestion" / "sophos" / "UPSTREAM-SOURCE.json")
        for name in ("configure.py", "cato/events_feed.py", "systemd/qapaq-sophos-ingest.service",
                     "systemd/qapaq-sophos-ingest.timer", "systemd/qapaq-cato-ingest.service",
                     "systemd/qapaq-cato-ingest.timer", "README.md"):
            copy_regular(provider_ingestion / name, root / "wazuh" / "provider-ingestion" / name)
        for name in ("siem.py", "state.py", "name_mapping.py", "config.py", "api_client.py", "vercheck.py", "LICENSE-2.0.txt"):
            copy_regular(provider_ingestion / "sophos" / "upstream" / name,
                         root / "wazuh" / "provider-ingestion" / "sophos" / "upstream" / name)

        teams = pathlib.Path(args.repo_root) / "infra" / "wazuh" / "teams"
        for name in ("custom-qapaq-teams", "apply_teams_workflow.py", "ossec-teams-workflow.xml"):
            copy_regular(teams / name, root / "wazuh" / "teams" / name)

        # Edge QAPAQ (nginx + proxy auth) y Ankay: siempre empaquetados; install.sh solo los
        # aplica si el bundle trae edge.json.
        repo = pathlib.Path(args.repo_root)
        for relative, source in {
            "wazuh/azure-release/configure_edge_azure.sh": repo / "wazuh/azure-release/configure_edge_azure.sh",
            "wazuh/edge/apply-edge.sh": repo / "wazuh/edge/apply-edge.sh",
            "wazuh/edge/qapaq-edge.conf": repo / "wazuh/edge/qapaq-edge.conf",
            "wazuh/edge/qapaq-ankay.location.conf": repo / "wazuh/edge/qapaq-ankay.location.conf",
            "wazuh/dashboard/opensearch_dashboards.qapaq.yml": repo / "wazuh/dashboard/opensearch_dashboards.qapaq.yml",
            "wazuh/indexer/security/apply-security.sh": repo / "wazuh/indexer/security/apply-security.sh",
            "wazuh/indexer/security/config.qapaq.yml": repo / "wazuh/indexer/security/config.qapaq.yml",
            "wazuh/indexer/security/roles.qapaq.yml": repo / "wazuh/indexer/security/roles.qapaq.yml",
            "wazuh/indexer/security/roles_mapping.qapaq.yml": repo / "wazuh/indexer/security/roles_mapping.qapaq.yml",
            "wazuh/scripts/indexer-admin.sh": repo / "wazuh/scripts/indexer-admin.sh",
            "wazuh/shuffle/custom-qapaq-shuffle": repo / "infra/wazuh/shuffle/custom-qapaq-shuffle",
            "wazuh/shuffle/ossec-shuffle-webhook.xml": repo / "infra/wazuh/shuffle/ossec-shuffle-webhook.xml",
            "wazuh/shuffle/apply_ankay_webhook.py": repo / "infra/wazuh/shuffle/apply_ankay_webhook.py",
        }.items():
            copy_regular(source, root / relative)
        if getattr(args, "edge_config", ""):
            edge = json.loads(pathlib.Path(args.edge_config).read_text(encoding="utf-8"))
            if not isinstance(edge, dict) or edge.get("schemaVersion") != 1 or not edge.get("hostname"):
                raise ValueError("edge config must be a schemaVersion 1 object with a hostname")
            (root / "edge.json").write_text(json.dumps(edge, sort_keys=True, indent=2) + "\n", encoding="utf-8")

        detection_sources = {
            "wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml":
                pathlib.Path(args.repo_root) / "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
            "wazuh/endpoint/rules/qapaq_endpoint_rules.xml":
                pathlib.Path(args.repo_root) / "infra/wazuh/endpoint/rules/qapaq_endpoint_rules.xml",
            "wazuh/active-directory/rules/qapaq_active_directory_rules.xml":
                pathlib.Path(args.repo_root) / "infra/wazuh/active-directory/rules/qapaq_active_directory_rules.xml",
            "wazuh/launch-detections/catalog.json":
                pathlib.Path(args.repo_root) / "docs/security/launch-detection-catalog-2026-10-20.json",
            "wazuh/launch-detections/install_detection_rules.py":
                pathlib.Path(args.repo_root) / "wazuh/azure-release/install_detection_rules.py",
        }
        for relative, source in detection_sources.items():
            destination = root / relative
            copy_regular(source, destination)
            artifact_paths[f"detection:{relative}"] = destination.relative_to(root).as_posix()

        profile_catalog_source = pathlib.Path(args.repo_root) / "infra/wazuh/active-directory/profile-catalog.json"
        profile_catalog = json.loads(profile_catalog_source.read_text(encoding="utf-8"))
        profile_safety = profile_catalog.get("safety", {})
        if (
            profile_catalog.get("status") != "candidate-disabled"
            or profile_catalog.get("activation") != "owner-approval-and-domain-controller-pilot-required"
            or profile_safety.get("activeResponse") is not False
            or profile_safety.get("rollout") is not False
            or profile_safety.get("installerAppliesAgentProfiles") is not False
            or profile_safety.get("requiresDomainOwnerApproval") is not True
            or profile_safety.get("requiresPilotVolumeAndFalsePositiveReview") is not True
        ):
            raise ValueError("agent profile catalog must remain candidate-disabled")
        profiles = profile_catalog.get("profiles")
        if not isinstance(profiles, list) or not profiles:
            raise ValueError("agent profile catalog must include disabled profile artifacts")
        agent_profile_paths: list[str] = []
        seen_profile_paths: set[str] = set()
        for profile in profiles:
            source_relative = pathlib.PurePosixPath(profile.get("path", ""))
            artifact_relative = pathlib.PurePosixPath(profile.get("artifactPath", ""))
            if (
                not source_relative.parts
                or source_relative.is_absolute()
                or ".." in source_relative.parts
                or not artifact_relative.parts
                or artifact_relative.is_absolute()
                or ".." in artifact_relative.parts
                or artifact_relative.parts[:2] != ("wazuh", "agent-profiles")
                or profile.get("status") != "candidate-disabled"
            ):
                raise ValueError("agent profile catalog contains an unsafe path or enabled profile")
            artifact_path = artifact_relative.as_posix()
            if artifact_path in seen_profile_paths:
                raise ValueError("agent profile catalog contains duplicate artifact paths")
            seen_profile_paths.add(artifact_path)
            copy_regular(pathlib.Path(args.repo_root) / pathlib.Path(*source_relative.parts), root / artifact_path)
            agent_profile_paths.append(artifact_path)

        profile_catalog_destination = root / "wazuh" / "agent-profiles" / "active-directory" / "profile-catalog.json"
        copy_regular(profile_catalog_source, profile_catalog_destination)
        profile_documentation = pathlib.Path(args.repo_root) / "infra/wazuh/active-directory/README.md"
        copy_regular(profile_documentation, root / "wazuh" / "agent-profiles" / "active-directory" / "README.md")
        agent_profile_pack = {
            "status": "candidate-disabled",
            "catalog": profile_catalog_destination.relative_to(root).as_posix(),
            "profiles": sorted(agent_profile_paths),
            "activation": "owner-approval-and-domain-controller-pilot-required",
            "installerAppliesAgentProfiles": False,
        }

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
            "optionalIntegrations": ["sophos-central-siem-api", "cato-events-feed", "microsoft-teams-workflows"],
            "detectionPack": {
                "catalog": "wazuh/launch-detections/catalog.json",
                "rules": [
                    "wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml",
                    "wazuh/endpoint/rules/qapaq_endpoint_rules.xml",
                    "wazuh/active-directory/rules/qapaq_active_directory_rules.xml",
                ],
                "activation": "rules-installed-provider-connectors-remain-opt-in",
            },
            "agentProfilePack": agent_profile_pack,
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
                "sophosCentralSiemIntegration": {
                    "repository": "https://github.com/sophos/Sophos-Central-SIEM-Integration",
                    "tag": sophos_source_metadata["tag"],
                    "commit": sophos_source_metadata["commit"],
                    "license": sophos_source_metadata["license"],
                },
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
    parser.add_argument("--edge-config", default="", help="edge.json opcional (hostname, Ankay); sin él el edge no se aplica")
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
