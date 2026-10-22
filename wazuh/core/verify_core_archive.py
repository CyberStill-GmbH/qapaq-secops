#!/usr/bin/env python3
"""Validate the QAPAQ core tarball layout and link targets before extraction."""

from __future__ import annotations

import posixpath
import re
import sys
import tarfile
from pathlib import Path

ROOT_PATTERN = re.compile(r"qapaq-core-[0-9a-f]{12}\Z")
REQUIRED_MEMBERS = (
    "node/bin/node",
    "api",
    "worker",
    "systemd",
)


def verify_archive(archive_path: str | Path) -> str:
    """Return the single archive root or raise ValueError for unsafe content."""
    root: str | None = None
    normalized_names: set[str] = set()
    try:
        with tarfile.open(archive_path, "r:gz") as archive:
            members = archive.getmembers()
            if not members:
                raise ValueError("archive vacío")

            for member in members:
                name = member.name
                if not name or name.startswith("/") or "\\" in name:
                    raise ValueError("nombre de ruta inválido")
                components = name.rstrip("/").split("/")
                if any(part in ("", ".", "..") for part in components):
                    raise ValueError("path traversal o componente inválido")
                normalized = posixpath.normpath(name)
                if normalized in (".", "..") or normalized.startswith("../"):
                    raise ValueError("path traversal")
                if normalized in normalized_names:
                    raise ValueError("miembro duplicado")
                normalized_names.add(normalized)

                component = normalized.split("/", 1)[0]
                if not ROOT_PATTERN.fullmatch(component):
                    raise ValueError("raíz inesperada")
                if root is None:
                    root = component
                if component != root:
                    raise ValueError("más de una raíz")
                if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                    raise ValueError("tipo de archivo especial no permitido")

                if member.issym() or member.islnk():
                    target = member.linkname
                    if not target or target.startswith("/") or "\\" in target:
                        raise ValueError("destino de enlace inválido")
                    base = posixpath.dirname(normalized) if member.issym() else ""
                    resolved = posixpath.normpath(posixpath.join(base, target))
                    if resolved == ".." or resolved.startswith("../"):
                        raise ValueError("enlace fuera de la raíz")
                    target_root = resolved.split("/", 1)[0]
                    if target_root != root:
                        raise ValueError("enlace fuera de la raíz")

            if root is None:
                raise ValueError("archive vacío")

            available = {name.removesuffix("/") for name in normalized_names}
            for required in REQUIRED_MEMBERS:
                if f"{root}/{required}" not in available:
                    raise ValueError(f"falta contenido requerido: {required}")

            release_info = archive.getmember(f"{root}/RELEASE")
            if not release_info.isfile():
                raise ValueError("RELEASE no es un archivo regular")
            release_file = archive.extractfile(release_info)
            if release_file is None or release_file.read().decode("ascii").strip() != root.removeprefix("qapaq-core-"):
                raise ValueError("marcador RELEASE no coincide con el nombre del archive")
    except (KeyError, OSError, UnicodeError, tarfile.TarError) as exc:
        raise ValueError(f"archive ilegible: {exc}") from exc

    return root


def main() -> int:
    if len(sys.argv) != 2:
        print("uso: verify_core_archive.py <archive.tar.gz>", file=sys.stderr)
        return 2
    try:
        root = verify_archive(sys.argv[1])
    except ValueError as exc:
        print(f"qapaq-core-azure: ERROR archive inseguro o inválido: {exc}", file=sys.stderr)
        return 1
    print(f"qapaq-core-azure: archive válido ({root})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
