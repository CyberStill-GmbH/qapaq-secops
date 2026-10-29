#!/usr/bin/env python3
"""Verifica los artefactos de Ankay y produce el plan exacto de publicación EUS2.

Entrada: el artefacto del frontend (image.tar.gz, metadata.txt, fuente AGPL, SHA256SUMS)
y el de runtime (component-manifest.json, imágenes, fuente correspondiente, SHA256SUMS)
de un mismo run de ankay-azure.yml. Salida: plan.json determinista con cada imagen,
su tag inmutable direccionado por contenido y cada blob de fuente AGPL. No usa red.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
RUNTIME_KEYS = ("backend", "worker", "orborus", "docker-guard", "opensearch", "app-qapaq-ankay")


class PlanError(ValueError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_sums(directory: Path) -> dict[str, str]:
    sums: dict[str, str] = {}
    lines = (directory / "SHA256SUMS").read_text(encoding="utf-8").splitlines()
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})\s+\*?(\S+)", line.strip())
        if not match or "/" in match.group(2) or match.group(2).startswith("."):
            raise PlanError(f"{directory.name}/SHA256SUMS has an invalid line")
        name = match.group(2)
        if sha256_file(directory / name) != match.group(1):
            raise PlanError(f"{directory.name}/{name} does not match SHA256SUMS")
        sums[name] = match.group(1)
    return sums


def build_plan(frontend: Path, runtime: Path, source_sha: str, acr: str, storage: str, container: str) -> dict:
    if not SHA.fullmatch(source_sha):
        raise PlanError("source sha must be a full commit")
    front_sums = check_sums(frontend)
    metadata = dict(line.split("=", 1) for line in (frontend / "metadata.txt").read_text(encoding="utf-8").splitlines() if "=" in line)
    if metadata.get("commit") != source_sha or metadata.get("image") != f"ankay-qapaq-frontend:{source_sha}":
        raise PlanError("frontend metadata does not match the requested commit")
    if front_sums.get("image.tar.gz") != metadata.get("image_sha256"):
        raise PlanError("frontend image checksum differs from its metadata")
    front_source = f"ankay-qapaq-frontend-source-{source_sha}.tar.gz"
    if front_sums.get(front_source) != metadata.get("source_sha256"):
        raise PlanError("frontend AGPL source is missing or differs from its metadata")

    run_sums = check_sums(runtime)
    manifest = json.loads((runtime / "component-manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 2 or manifest.get("targetPlatform") != "linux/amd64":
        raise PlanError("runtime manifest schema or platform is unexpected")
    built = manifest.get("built", {})
    if sorted(built) != sorted(RUNTIME_KEYS):
        raise PlanError("runtime manifest must describe exactly the six runtime images")

    images = [{
        "key": "frontend",
        "archive": "frontend/image.tar.gz",
        "localImage": f"ankay-qapaq-frontend:{source_sha}",
        "repository": "ankay-qapaq-frontend",
        "tag": f"git-{source_sha}-sha256-{front_sums['image.tar.gz']}",
    }]
    for key in RUNTIME_KEYS:
        entry = built[key]
        archive = entry.get("archive", "")
        if run_sums.get(archive) != entry.get("archiveSha256") or not SHA256.fullmatch(entry.get("archiveSha256", "")):
            raise PlanError(f"{key} archive checksum differs from the manifest")
        repository = entry.get("repository", "")
        if not re.fullmatch(r"ankay-qapaq-[a-z0-9-]+", repository):
            raise PlanError(f"{key} repository name is not allowlisted")
        images.append({
            "key": key,
            "archive": f"runtime/{archive}",
            "localImage": f"{repository}:{source_sha}",
            "repository": repository,
            "tag": f"git-{source_sha}-sha256-{entry['archiveSha256']}",
        })

    runtime_source = "shuffle-corresponding-source.tar.gz"
    if run_sums.get(runtime_source) != manifest.get("sourceArchiveSha256"):
        raise PlanError("runtime corresponding source differs from the manifest")
    sources = [
        {"file": f"frontend/{front_source}", "blob": f"ankay-source/{source_sha}/{front_source}", "sha256": front_sums[front_source]},
        {"file": f"runtime/{runtime_source}", "blob": f"ankay-source/{source_sha}/ankay-runtime-source-{source_sha}.tar.gz", "sha256": run_sums[runtime_source]},
    ]
    return {"schemaVersion": 1, "sourceSha": source_sha, "acr": acr, "storageAccount": storage, "container": container, "images": images, "sources": sources}


def summary(plan: dict) -> str:
    lines = ["## Revisión de publicación Ankay EUS2", "", f"- Commit QAPAQ: `{plan['sourceSha']}`"]
    for image in plan["images"]:
        lines.append(f"- ACR: `{plan['acr']}/{image['repository']}:{image['tag']}`")
    for source in plan["sources"]:
        lines.append(f"- Fuente AGPL: `https://{plan['storageAccount']}.blob.core.windows.net/{plan['container']}/{source['blob']}` (SHA-256 `{source['sha256']}`)")
    lines += [
        "- Efecto máximo: tags nuevos en el ACR existente y blobs privados de fuentes; se rechaza si alguno ya existe.",
        "- No crea ni cambia recursos, permisos, red, Key Vault, Terraform, DNS o cómputo.",
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frontend", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--acr", required=True)
    parser.add_argument("--storage-account", required=True)
    parser.add_argument("--container", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--summary", type=Path)
    args = parser.parse_args()
    try:
        plan = build_plan(args.frontend, args.runtime, args.source_sha, args.acr, args.storage_account, args.container)
    except (PlanError, OSError, ValueError, KeyError) as error:
        print(f"::error::Ankay publication plan rejected: {error}", file=sys.stderr)
        return 1
    args.output.write_text(json.dumps(plan, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if args.summary:
        with args.summary.open("a", encoding="utf-8") as stream:
            stream.write(summary(plan))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
