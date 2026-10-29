#!/usr/bin/env python3
"""Synchronize the stale Guava Maven descriptor in OpenSearch's OpenSAML aggregate jar.

The OpenSAML aggregate shipped by the pinned opensearch-security 3.9.0.0 plugin contains
Guava's Maven descriptor (33.0.0-jre) but no Guava classes: the plugin loads Guava from its
own guava jar, which opensearch-dependencies.lock replaces with the checksum-pinned
33.7.2-jre. Trivy still reports the stale descriptor. Like the Jackson helper, this copies the
exact descriptors from the patched runtime jar after proving no Guava implementation is
bundled, and reuses its verified ZIP rewriter. Runs after prune_opensearch_shadow_metadata.py.
"""

from __future__ import annotations

import argparse
import importlib.util
import zipfile
from pathlib import Path

GROUP = "com.google.guava"
ARTIFACT = "guava"
EXPECTED_VERSION = "33.0.0-jre"
PATCHED_VERSION = "33.7.2-jre"
PATCHED_JAR = f"guava-{PATCHED_VERSION}.jar"
REQUIRED_CLASS = "com/google/common/base/Preconditions.class"
DESCRIPTORS = (
    f"META-INF/maven/{GROUP}/{ARTIFACT}/pom.properties",
    f"META-INF/maven/{GROUP}/{ARTIFACT}/pom.xml",
)


def _jackson_helper():
    path = Path(__file__).with_name("prune_opensearch_shadow_metadata.py")
    spec = importlib.util.spec_from_file_location("prune_opensearch_shadow_metadata", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _properties(content: bytes) -> dict[str, str]:
    return dict(line.split("=", 1) for line in content.decode("utf-8").splitlines() if "=" in line and not line.startswith("#"))


def patched_descriptors(root: Path) -> dict[str, bytes]:
    copies = list(root.rglob(PATCHED_JAR))
    if not copies:
        raise ValueError(f"Patched runtime dependency is missing: {PATCHED_JAR}")
    found: dict[str, bytes] = {}
    for jar in copies:
        with zipfile.ZipFile(jar) as archive:
            names = archive.namelist()
            if REQUIRED_CLASS not in names:
                raise ValueError(f"Patched Guava jar has no implementation classes: {jar}")
            for descriptor in DESCRIPTORS:
                if names.count(descriptor) != 1:
                    raise ValueError(f"Expected exactly one {descriptor} in {jar}")
                content = archive.read(descriptor)
                if found.setdefault(descriptor, content) != content:
                    raise ValueError(f"Patched Guava descriptors differ across copies: {descriptor}")
    props = _properties(found[DESCRIPTORS[0]])
    if props.get("groupId") != GROUP or props.get("artifactId") != ARTIFACT or props.get("version") != PATCHED_VERSION:
        raise ValueError("Patched Guava jar has unexpected Maven coordinates")
    return found


def synchronize(opensaml: Path, replacements: dict[str, bytes]) -> int:
    with zipfile.ZipFile(opensaml) as archive:
        names = archive.namelist()
        bundled = [name for name in names if name.startswith("com/google/common/") or name.startswith("com/google/thirdparty/")]
        if bundled:
            raise ValueError("Refusing to rewrite descriptors: OpenSAML bundles Guava classes: " + ", ".join(bundled[:5]))
        for descriptor in DESCRIPTORS:
            if names.count(descriptor) != 1:
                raise ValueError(f"Expected exactly one pinned Guava descriptor {descriptor}")
        if _properties(archive.read(DESCRIPTORS[0])).get("version") != EXPECTED_VERSION:
            raise ValueError("Unexpected Guava descriptor version in OpenSAML")
    _jackson_helper()._replace_zip_members(opensaml, {name: replacements[name] for name in DESCRIPTORS})
    with zipfile.ZipFile(opensaml) as archive:
        if _properties(archive.read(DESCRIPTORS[0])).get("version") != PATCHED_VERSION:
            raise ValueError("Guava descriptor was not synchronized")
        if EXPECTED_VERSION.encode() in archive.read(DESCRIPTORS[1]):
            raise ValueError("Stale Guava version remains in pom.xml")
    return len(DESCRIPTORS)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path, help="OpenSearch installation root")
    args = parser.parse_args()
    jars = list(args.root.rglob("opensaml-3.9.0.0-all.jar"))
    if len(jars) != 1:
        raise SystemExit(f"Expected exactly one OpenSAML aggregate jar; found {len(jars)}")
    updated = synchronize(jars[0], patched_descriptors(args.root))
    print(f"Updated {updated} Guava Maven metadata entries from {EXPECTED_VERSION} to {PATCHED_VERSION}; no Guava classes bundled in OpenSAML.")


if __name__ == "__main__":
    main()
