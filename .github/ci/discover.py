"""Descubre únicamente entradas de CI respaldadas por archivos versionados."""

from __future__ import annotations

import json
import os
from pathlib import Path, PurePosixPath
import subprocess
from typing import Iterable


WORKSPACE_FILES = {".nvmrc", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"}
NODE_VERSION = "24.21.0"
PNPM_VERSION = "12.4.2"


def _repository_path(name: str) -> PurePosixPath:
    normalized = name.replace("\\", "/")
    path = PurePosixPath(normalized)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"Repository path escapes the checkout: {name}")
    return path


def _resolved_inside(root: Path, path: PurePosixPath) -> Path:
    repository = root.resolve(strict=True)
    resolved = (root / Path(*path.parts)).resolve(strict=True)
    if not resolved.is_relative_to(repository):
        raise ValueError(f"Repository path resolves outside the checkout: {path}")
    return resolved


def discover(files: Iterable[str], root: Path = Path(".")) -> dict[str, object]:
    paths = {_repository_path(name) for name in files}
    languages = []
    if any(path.suffix in {".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"} for path in paths):
        languages.append("javascript-typescript")
    if any(path.suffix == ".py" for path in paths):
        languages.append("python")

    package_manifests = {path for path in paths if path.name == "package.json"}
    pnpm_inputs = {PurePosixPath(name) for name in WORKSPACE_FILES}
    present_pnpm_inputs = paths & pnpm_inputs
    npm_locks = {path for path in paths if path.name in {"package-lock.json", "npm-shrinkwrap.json"}}

    if npm_locks:
        joined = ", ".join(sorted(map(str, npm_locks)))
        raise ValueError(f"Unsupported npm lockfile; the accepted workspace uses pnpm: {joined}")
    if package_manifests or present_pnpm_inputs:
        missing = pnpm_inputs - paths
        if missing:
            joined = ", ".join(sorted(map(str, missing)))
            raise ValueError(f"NOT_CONFIGURED: missing root pnpm inputs: {joined}")
        if PurePosixPath("package.json") not in package_manifests:
            raise ValueError("NOT_CONFIGURED: the root package.json must own the pnpm workspace")
        manifest = json.loads((root / "package.json").read_text(encoding="utf-8"))
        package_manager = manifest.get("packageManager", "")
        if package_manager != f"pnpm@{PNPM_VERSION}":
            raise ValueError(f"NOT_CONFIGURED: packageManager must be pnpm@{PNPM_VERSION}")
        node_version = (root / ".nvmrc").read_text(encoding="utf-8").strip()
        if node_version != NODE_VERSION:
            raise ValueError(f"NOT_CONFIGURED: .nvmrc must be {NODE_VERSION}")

    containers_file = root / ".github" / "ci" / "containers.json"
    containers = json.loads(containers_file.read_text(encoding="utf-8"))
    if not isinstance(containers, list):
        raise ValueError("containers.json must contain an array")
    configured: set[PurePosixPath] = set()
    for item in containers:
        if not isinstance(item, dict) or set(item) != {"dockerfile", "context"}:
            raise ValueError("Each container needs only dockerfile and context")
        dockerfile = _repository_path(item["dockerfile"])
        context = _repository_path(item["context"])
        if str(dockerfile).startswith("-") or str(context).startswith("-"):
            raise ValueError("Container paths cannot be command options")
        if dockerfile not in paths:
            raise ValueError("Container input does not exist")
        resolved_dockerfile = _resolved_inside(root, dockerfile)
        resolved_context = _resolved_inside(root, context)
        if not resolved_dockerfile.is_file() or not resolved_context.is_dir():
            raise ValueError("Container input has an invalid type")
        configured.add(dockerfile)

    dockerfiles = {
        path
        for path in paths
        if path.name == "Dockerfile" or path.name.startswith("Dockerfile.") or path.suffix == ".Dockerfile"
    }
    if dockerfiles - configured:
        missing = ", ".join(sorted(map(str, dockerfiles - configured)))
        raise ValueError(f"NOT_CONFIGURED: add every Dockerfile to containers.json: {missing}")

    has_pnpm = bool(package_manifests or present_pnpm_inputs)
    return {
        "languages": languages,
        "containers": containers,
        "has_pnpm": has_pnpm,
        "has_containers": bool(containers),
    }


def main() -> None:
    files = subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")
    result = discover((name for name in files if name))
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        for key, value in result.items():
            output.write(f"{key}={json.dumps(value, separators=(',', ':'))}\n")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
        summary.write("## Coverage\n")
        summary.write(f"CodeQL: {', '.join(result['languages'])}\n\n")
        summary.write(
            f"pnpm workspace: {'configured' if result['has_pnpm'] else 'absent'}; "
            f"container targets: {len(result['containers'])}\n\n"
        )
        if not result["has_pnpm"]:
            summary.write("NOT_CONFIGURED: pnpm audit and application checks (no workspace).\n\n")
        summary.write(
            "NOT_CONFIGURED: GitHub Dependency Review requires Dependency Graph and GHAS "
            "for this private repository; pnpm audit remains the dependency gate.\n\n"
        )
        if not result["has_containers"]:
            summary.write("NOT_CONFIGURED: container scan (no container targets).\n\n")
        summary.write("NOT_CONFIGURED: deployment destination; no deployment is performed.\n")


if __name__ == "__main__":
    main()
