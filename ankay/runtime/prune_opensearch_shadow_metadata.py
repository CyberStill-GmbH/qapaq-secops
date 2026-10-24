#!/usr/bin/env python3
"""Remove stale Jackson Maven descriptors from OpenSearch's metadata-only OpenSAML jar.

The pinned OpenSearch 3.9.0 security plugin's OpenSAML aggregate jar contains Maven
descriptors for Jackson 2.22.2, but no Jackson implementation classes. Trivy reports the
descriptor as a vulnerable component. This helper removes only those descriptors after
proving the relevant classes are absent; it refuses to modify any jar that contains them.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import stat
import tempfile
import zipfile


JACKSON_ARTIFACTS = ("jackson-core", "jackson-databind")
EXPECTED_VERSION = "2.22.2"
PATCHED_VERSION = "2.22.3"
PATCHED_RUNTIME_CLASSES = {
    "jackson-core-2.22.3.jar": "com/fasterxml/jackson/core/JsonFactory.class",
    "jackson-databind-2.22.3.jar": "com/fasterxml/jackson/databind/ObjectMapper.class",
}
JACKSON_CLASS_PREFIXES = (
    "com/fasterxml/jackson/core/",
    "com/fasterxml/jackson/databind/",
    "tools/jackson/core/",
    "tools/jackson/databind/",
)


def _descriptor_names(artifact: str) -> tuple[str, str]:
    base = f"META-INF/maven/com.fasterxml.jackson.core/{artifact}"
    return (f"{base}/pom.properties", f"{base}/pom.xml")


def verify_patched_runtime(root: Path) -> None:
    for jar_name, required_class in PATCHED_RUNTIME_CLASSES.items():
        matches = list(root.rglob(jar_name))
        if not matches:
            raise ValueError(f"Patched runtime dependency is missing: {jar_name}")
        artifact = jar_name.removesuffix("-2.22.3.jar")
        properties_name = f"META-INF/maven/com.fasterxml.jackson.core/{artifact}/pom.properties"
        for jar_path in matches:
            with zipfile.ZipFile(jar_path, "r") as archive:
                if properties_name not in archive.namelist():
                    raise ValueError(f"Patched runtime dependency has no Maven version: {jar_path}")
                properties = archive.read(properties_name).decode("utf-8")
                versions = [
                    line.partition("=")[2]
                    for line in properties.splitlines()
                    if line.startswith("version=")
                ]
                if versions != [PATCHED_VERSION]:
                    raise ValueError(f"Unexpected patched dependency version in {jar_path}: {versions}")
                if required_class not in archive.namelist():
                    raise ValueError(f"Patched runtime dependency class is missing: {required_class}")


def prune_descriptors(jar_path: Path) -> int:
    with zipfile.ZipFile(jar_path, "r") as source:
        bad_entry = source.testzip()
        if bad_entry is not None:
            raise ValueError(f"Corrupt OpenSAML archive entry: {bad_entry}")

        entries = {entry.filename for entry in source.infolist()}
        required = {
            descriptor
            for artifact in JACKSON_ARTIFACTS
            for descriptor in _descriptor_names(artifact)
        }
        if not required.issubset(entries):
            missing = sorted(required - entries)
            raise ValueError(f"Expected pinned Jackson metadata is missing: {missing}")

        for artifact in JACKSON_ARTIFACTS:
            properties = f"META-INF/maven/com.fasterxml.jackson.core/{artifact}/pom.properties"
            content = source.read(properties).decode("utf-8")
            version_lines = [line.partition("=")[2] for line in content.splitlines() if line.startswith("version=")]
            if version_lines != [EXPECTED_VERSION]:
                raise ValueError(f"Unexpected {artifact} descriptor version: {version_lines}")

        class_entries = [
            name
            for name in entries
            if name.endswith(".class") and name.startswith(JACKSON_CLASS_PREFIXES)
        ]
        if class_entries:
            raise ValueError(
                "Refusing to prune metadata because Jackson classes are present: "
                + ", ".join(sorted(class_entries)[:8])
            )

        removed = required
        retained_entries = [
            (entry, source.read(entry))
            for entry in source.infolist()
            if entry.filename not in removed
        ]
        archive_comment = source.comment
        original_mode = stat.S_IMODE(jar_path.stat().st_mode)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{jar_path.name}.", suffix=".tmp", dir=jar_path.parent)
    os.close(fd)
    temporary_path = Path(temporary_name)
    try:
        with zipfile.ZipFile(temporary_path, "w") as target:
            target.comment = archive_comment
            for entry, content in retained_entries:
                target.writestr(entry, content)
        os.chmod(temporary_path, original_mode)
        with zipfile.ZipFile(temporary_path, "r") as verified:
            bad_entry = verified.testzip()
            if bad_entry is not None:
                raise ValueError(f"Rebuilt OpenSAML archive is corrupt: {bad_entry}")
            if removed.intersection(verified.namelist()):
                raise ValueError("Jackson Maven descriptors remain after pruning")
        os.replace(temporary_path, jar_path)
    finally:
        temporary_path.unlink(missing_ok=True)
    return len(removed)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path, help="OpenSearch installation root")
    args = parser.parse_args()
    jars = list(args.root.rglob("opensaml-3.9.0.0-all.jar"))
    if len(jars) != 1:
        raise SystemExit(f"Expected exactly one pinned OpenSAML aggregate jar; found {len(jars)}")
    verify_patched_runtime(args.root)
    removed = prune_descriptors(jars[0])
    print(
        f"Removed {removed} stale Jackson 2.22.2 metadata entries; "
        "verified Jackson 2.22.3 runtime jars and no Jackson implementation classes in OpenSAML."
    )


if __name__ == "__main__":
    main()
