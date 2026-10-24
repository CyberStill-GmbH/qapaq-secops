#!/usr/bin/env python3
"""Synchronize stale Jackson Maven descriptors in OpenSearch's OpenSAML aggregate jar.

The pinned OpenSearch 3.9.0 security plugin's OpenSAML aggregate jar contains Maven
descriptors for Jackson 2.22.2 while the runtime Jackson jars are patched to 2.22.3. Trivy
reports the stale descriptors as vulnerable components. This helper updates only those
descriptors after proving the Jackson implementation classes are not bundled in OpenSAML.
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
SIGNATURE_SUFFIXES = (".SF", ".RSA", ".DSA", ".EC")
KNOWN_OPEN_SAML_NAME_COLLISIONS = {
    "org/opensaml/core/Version.class",
    "org/opensaml/xmlsec/encryption/ReferenceType.class",
    "org/opensaml/xmlsec/signature/support/ContentReference.class",
}


def _descriptor_names(artifact: str) -> tuple[str, str]:
    base = f"META-INF/maven/com.fasterxml.jackson.core/{artifact}"
    return (f"{base}/pom.properties", f"{base}/pom.xml")


def _verify_all_entries(archive: zipfile.ZipFile) -> None:
    # ZipFile.testzip() resolves duplicate names by filename and can report a false
    # CRC mismatch for valid upstream fat JARs. Opening each ZipInfo verifies every
    # physical member independently, including duplicate META-INF notices.
    for entry in archive.infolist():
        with archive.open(entry) as stream:
            while stream.read(1024 * 1024):
                pass


def verify_patched_runtime(root: Path) -> set[str]:
    jackson_class_basenames: set[str] = set()
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
                jackson_class_basenames.update(
                    Path(name).name
                    for name in archive.namelist()
                    if name.endswith(".class")
                    and Path(name).name not in {"module-info.class", "package-info.class"}
                )
    return jackson_class_basenames


def synchronize_descriptors(jar_path: Path, jackson_class_basenames: set[str]) -> int:
    with zipfile.ZipFile(jar_path, "r") as source:
        try:
            _verify_all_entries(source)
        except (zipfile.BadZipFile, RuntimeError) as error:
            raise ValueError(f"Corrupt OpenSAML archive entry: {error}") from error

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

        # Do not rewrite an archive if it is signed: removing any member invalidates
        # the signature and manifest digests even if the remaining ZIP is readable.
        signature_entries = [
            name
            for name in entries
            if name.upper().startswith("META-INF/")
            and (
                Path(name).name.upper().endswith(SIGNATURE_SUFFIXES)
                or Path(name).name.upper().startswith("SIG-")
            )
        ]
        manifest_entries = [entry for entry in source.infolist() if entry.filename.upper() == "META-INF/MANIFEST.MF"]
        manifest_digests = [
            entry.filename
            for entry in manifest_entries
            if b"-digest:" in source.read(entry).lower()
        ]
        if signature_entries or manifest_digests:
            raise ValueError(
                "Refusing to rewrite a signed OpenSAML archive; signature members or manifest digests are present"
            )

        nested_archives = [
            name for name in entries if name.lower().endswith((".jar", ".zip", ".war", ".ear"))
        ]
        if nested_archives:
            raise ValueError("Refusing to synchronize metadata in an archive containing nested archives: " + ", ".join(sorted(nested_archives)[:8]))

        class_entries = []
        for entry in source.infolist():
            name = entry.filename
            if not name.lower().endswith(".class"):
                continue
            lowered_name = name.lower()
            # This catches canonical and multi-release package paths, plus shaded
            # class names by comparing all class basenames with the patched Jackson
            # runtimes. Package-info metadata can legitimately reference Jackson APIs.
            if (
                (Path(name).name in jackson_class_basenames and name not in KNOWN_OPEN_SAML_NAME_COLLISIONS)
                or "jackson" in lowered_name
                or "fasterxml" in lowered_name
            ):
                class_entries.append(name)
        if class_entries:
            raise ValueError(
                "Refusing to synchronize metadata because Jackson implementation classes are present: "
                + ", ".join(sorted(class_entries)[:8])
            )

        updated_contents: dict[str, bytes] = {}
        for descriptor in required:
            content = source.read(descriptor)
            if descriptor.endswith("pom.properties"):
                text = content.decode("utf-8")
                old_line = f"version={EXPECTED_VERSION}"
                if text.splitlines().count(old_line) != 1:
                    raise ValueError(f"Expected one stale version in {descriptor}")
                text = text.replace(old_line, f"version={PATCHED_VERSION}")
            else:
                text = content.decode("utf-8")
                if text.count(EXPECTED_VERSION) != 3:
                    raise ValueError(f"Expected parent, project, and SCM versions in {descriptor}")
                text = text.replace(EXPECTED_VERSION, PATCHED_VERSION)
            updated_contents[descriptor] = text.encode("utf-8")
        retained_entries = [
            (entry, updated_contents.get(entry.filename, source.read(entry)))
            for entry in source.infolist()
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
            try:
                _verify_all_entries(verified)
            except (zipfile.BadZipFile, RuntimeError) as error:
                raise ValueError(f"Rebuilt OpenSAML archive is corrupt: {error}") from error
            for descriptor in required:
                content = verified.read(descriptor).decode("utf-8")
                if EXPECTED_VERSION in content:
                    raise ValueError(f"Stale Jackson descriptor remains after synchronization: {descriptor}")
                if descriptor.endswith("pom.properties") and f"version={PATCHED_VERSION}" not in content:
                    raise ValueError(f"Corrected Jackson version missing after synchronization: {descriptor}")
        os.replace(temporary_path, jar_path)
    finally:
        temporary_path.unlink(missing_ok=True)
    return len(updated_contents)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path, help="OpenSearch installation root")
    args = parser.parse_args()
    jars = list(args.root.rglob("opensaml-3.9.0.0-all.jar"))
    if len(jars) != 1:
        raise SystemExit(f"Expected exactly one pinned OpenSAML aggregate jar; found {len(jars)}")
    jackson_class_basenames = verify_patched_runtime(args.root)
    updated = synchronize_descriptors(jars[0], jackson_class_basenames)
    print(
        f"Updated {updated} Jackson Maven metadata entries from 2.22.2 to 2.22.3; "
        "verified patched runtime jars and no Jackson implementation classes bundled in OpenSAML."
    )


if __name__ == "__main__":
    main()
