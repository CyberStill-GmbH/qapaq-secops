#!/usr/bin/env python3
"""Synchronize stale Jackson Maven descriptors in OpenSearch's OpenSAML aggregate jar.

The pinned OpenSearch 3.9.0 security plugin's OpenSAML aggregate jar contains Maven
descriptors for Jackson 2.22.2 while the runtime Jackson jars are patched to 2.22.3. Trivy
reports the stale descriptors as vulnerable components. This helper updates only those
descriptors after proving the Jackson implementation classes are not bundled in OpenSAML.
"""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import stat
import struct
import tempfile
import xml.etree.ElementTree as ET
import zipfile
import zlib


JACKSON_ARTIFACTS = ("jackson-core", "jackson-databind")
EXPECTED_VERSION = "2.22.2"
PATCHED_VERSION = "2.22.3"
OPEN_SAML_SHA256 = "2d0c1db9e284a36ec2c279c7b7cb1cdaaae9d64f55f60548a32a1babfddbd1ab"
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


def _compressed_member(content: bytes, compression: int) -> bytes:
    if compression == zipfile.ZIP_STORED:
        return content
    if compression != zipfile.ZIP_DEFLATED:
        raise ValueError(f"Unsupported compression method for Maven metadata: {compression}")
    compressor = zlib.compressobj(level=9, method=zlib.DEFLATED, wbits=-15)
    return compressor.compress(content) + compressor.flush()


def _central_directory_records(data: bytes, start: int, end: int) -> list[tuple[int, bytes, tuple[int, ...], str]]:
    records: list[tuple[int, bytes, tuple[int, ...], str]] = []
    position = start
    while position < end:
        if data[position : position + 4] != b"PK\x01\x02" or position + 46 > end:
            raise ValueError("Unsupported or malformed OpenSAML central directory")
        fields = struct.unpack_from("<IHHHHHHIIIHHHHHII", data, position)
        name_len, extra_len, comment_len = fields[10], fields[11], fields[12]
        record_end = position + 46 + name_len + extra_len + comment_len
        if record_end > end:
            raise ValueError("Truncated OpenSAML central directory entry")
        encoding = "utf-8" if fields[3] & 0x800 else "cp437"
        name = data[position + 46 : position + 46 + name_len].decode(encoding)
        records.append((position, data[position:record_end], fields, name))
        position = record_end
    if position != end:
        raise ValueError("Unexpected bytes at end of OpenSAML central directory")
    return records


def _replacement_local_record(name: str, content: bytes, info: zipfile.ZipInfo) -> tuple[bytes, int, int, int]:
    name_bytes = name.encode("utf-8")
    compressed = _compressed_member(content, info.compress_type)
    crc = zlib.crc32(content) & 0xFFFFFFFF
    year, month, day, _, _, _ = info.date_time
    dos_date = ((year - 1980) << 9) | (month << 5) | day
    # New local records use no data descriptor or extra fields. Keep the upstream
    # compression method and timestamps, but clear descriptor/encryption flags.
    flags = info.flag_bits & ~0x09
    local = struct.pack(
        "<IHHHHHIIIHH",
        0x04034B50,
        max(info.extract_version, 20),
        flags,
        info.compress_type,
        info._raw_time,
        dos_date,
        crc,
        len(compressed),
        len(content),
        len(name_bytes),
        0,
    ) + name_bytes + compressed
    return local, crc, len(compressed), len(content)


def _replace_zip_members(jar_path: Path, replacements: dict[str, bytes]) -> None:
    original = jar_path.read_bytes()
    with zipfile.ZipFile(jar_path, "r") as archive:
        start_dir = archive.start_dir
        infos = {name: archive.getinfo(name) for name in replacements}
        original_infos = archive.infolist()
    eocd = original.rfind(b"PK\x05\x06")
    if eocd < start_dir or eocd + 22 > len(original):
        raise ValueError("Could not locate a standard OpenSAML end-of-central-directory record")
    _, disk, directory_disk, disk_entries, total_entries, directory_size, directory_offset, comment_size = struct.unpack_from(
        "<IHHHHIIH", original, eocd
    )
    if disk or directory_disk or disk_entries != total_entries or total_entries == 0xFFFF or directory_size == 0xFFFFFFFF or directory_offset == 0xFFFFFFFF:
        raise ValueError("Refusing to rewrite unsupported multi-disk or ZIP64 OpenSAML archive")
    directory_end = eocd
    if directory_offset != start_dir or directory_size != directory_end - start_dir or eocd + 22 + comment_size != len(original):
        raise ValueError("OpenSAML central directory offsets or comment are inconsistent")
    records = _central_directory_records(original, start_dir, directory_end)
    replacements_by_old_offset: dict[int, tuple[str, bytes, int, int, int]] = {}
    appended = bytearray()
    for name, content in replacements.items():
        info = infos[name]
        old_offset = info.header_offset
        raw = original[old_offset : old_offset + 30]
        if len(raw) != 30:
            raise ValueError(f"Truncated local header for {name}")
        local_fields = struct.unpack("<IHHHHHIIIHH", raw)
        if local_fields[0] != 0x04034B50 or local_fields[7] == 0xFFFFFFFF or local_fields[8] == 0xFFFFFFFF:
            raise ValueError(f"Unsupported local header for {name}")
        if local_fields[2] & 1:
            raise ValueError(f"Encrypted Maven metadata is not supported: {name}")
        data_start = old_offset + 30 + local_fields[9] + local_fields[10]
        data_end = data_start + info.compress_size
        if data_end > start_dir:
            raise ValueError(f"Maven metadata data exceeds the local-file area: {name}")
        target_range = (old_offset, data_end)
        for other in original_infos:
            if other is info:
                continue
            if other.header_offset == old_offset:
                raise ValueError(f"Maven metadata local header is shared by another ZIP entry: {name}")
            other_header = original[other.header_offset : other.header_offset + 30]
            if len(other_header) != 30 or other_header[:4] != b"PK\x03\x04":
                raise ValueError(f"Invalid neighboring local ZIP header for {other.filename}")
            other_fields = struct.unpack("<IHHHHHIIIHH", other_header)
            other_start = other.header_offset + 30 + other_fields[9] + other_fields[10]
            other_end = other_start + other.compress_size
            if target_range[0] < other_end and other.header_offset < target_range[1]:
                raise ValueError(f"Maven metadata entry overlaps another ZIP member: {name}")
        # The old entry becomes unreferenced after its central record is redirected.
        # Clear its compressed payload so stale vulnerable metadata is not left in
        # the archive's raw bytes.
        appended_offset = len(appended)
        local, crc, compressed_size, file_size = _replacement_local_record(name, content, info)
        replacements_by_old_offset[old_offset] = (name, local, appended_offset, crc, compressed_size, file_size)
        appended.extend(local)

    patched_records = bytearray()
    seen: set[str] = set()
    new_local_base = start_dir
    for _, record, fields, name in records:
        replacement = replacements_by_old_offset.get(fields[16])
        if replacement is None:
            patched_records.extend(record)
            continue
        replacement_name, _, appended_offset, crc, compressed_size, file_size = replacement
        if replacement_name != name or name in seen:
            raise ValueError(f"Central-directory mapping is ambiguous for {name}")
        seen.add(name)
        new_record = bytearray(record)
        flags = fields[3] & ~0x09
        local_offset = new_local_base + appended_offset
        struct.pack_into("<H", new_record, 8, flags)
        struct.pack_into("<I", new_record, 16, crc)
        struct.pack_into("<I", new_record, 20, compressed_size)
        struct.pack_into("<I", new_record, 24, file_size)
        struct.pack_into("<I", new_record, 42, local_offset)
        patched_records.extend(new_record)
    if seen != set(replacements):
        raise ValueError(f"Could not uniquely redirect metadata entries: {sorted(set(replacements) - seen)}")

    # Mark old payloads as unreachable and stale-free in the same bytearray.
    result_prefix = bytearray(original[:start_dir])
    for old_offset, (name, _, _, _, _, _) in replacements_by_old_offset.items():
        info = infos[name]
        local_fields = struct.unpack_from("<IHHHHHIIIHH", original, old_offset)
        data_start = old_offset + 30 + local_fields[9] + local_fields[10]
        data_end = data_start + info.compress_size
        result_prefix[data_start:data_end] = bytes(data_end - data_start)
    new_directory_offset = len(result_prefix) + len(appended)
    new_eocd = bytearray(original[eocd:])
    struct.pack_into("<I", new_eocd, 12, len(patched_records))
    struct.pack_into("<I", new_eocd, 16, new_directory_offset)
    output = bytes(result_prefix) + bytes(appended) + bytes(patched_records) + bytes(new_eocd)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{jar_path.name}.", suffix=".tmp", dir=jar_path.parent)
    os.close(fd)
    temporary_path = Path(temporary_name)
    try:
        temporary_path.write_bytes(output)
        os.chmod(temporary_path, stat.S_IMODE(jar_path.stat().st_mode))
        with zipfile.ZipFile(temporary_path, "r") as verified:
            for name, expected in replacements.items():
                if verified.read(name) != expected:
                    raise ValueError(f"Patched Maven metadata failed ZIP verification: {name}")
        os.replace(temporary_path, jar_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def verify_pinned_opensaml(jar_path: Path, expected_sha256: str = OPEN_SAML_SHA256) -> None:
    actual_sha256 = hashlib.sha256(jar_path.read_bytes()).hexdigest()
    if actual_sha256 != expected_sha256:
        raise ValueError(f"Unexpected pinned OpenSAML aggregate SHA-256: {actual_sha256}")


def _local_text(parent: ET.Element, name: str) -> str | None:
    return next((child.text for child in parent if child.tag.rsplit("}", 1)[-1] == name), None)


def _verify_patched_pom(content: bytes, artifact: str) -> None:
    root = ET.fromstring(content)
    project = {key: _local_text(root, key) for key in ("groupId", "artifactId", "version")}
    parent = next((child for child in root if child.tag.rsplit("}", 1)[-1] == "parent"), None)
    parent_version = _local_text(parent, "version") if parent is not None else None
    expected = {"groupId": "com.fasterxml.jackson.core", "artifactId": artifact, "version": PATCHED_VERSION}
    if project != expected or parent_version != PATCHED_VERSION:
        raise ValueError(f"Patched Maven POM has an unexpected GAV or parent version: {artifact}")


def verify_patched_runtime(root: Path) -> tuple[set[str], dict[str, bytes]]:
    jackson_class_basenames: set[str] = set()
    patched_descriptors: dict[str, bytes] = {}
    for jar_name, required_class in PATCHED_RUNTIME_CLASSES.items():
        matches = list(root.rglob(jar_name))
        if not matches:
            raise ValueError(f"Patched runtime dependency is missing: {jar_name}")
        artifact = jar_name.removesuffix("-2.22.3.jar")
        descriptor_names = _descriptor_names(artifact)
        for jar_path in matches:
            with zipfile.ZipFile(jar_path, "r") as archive:
                archive_names = [entry.filename for entry in archive.infolist()]
                for descriptor in descriptor_names:
                    if archive_names.count(descriptor) != 1:
                        raise ValueError(f"Expected exactly one patched metadata entry {descriptor} in {jar_path}")
                    content = archive.read(descriptor)
                    previous = patched_descriptors.get(descriptor)
                    if previous is not None and previous != content:
                        raise ValueError(f"Patched runtime metadata differs across copies: {descriptor}")
                    patched_descriptors[descriptor] = content
                properties_name = descriptor_names[0]
                if properties_name not in archive.namelist():
                    raise ValueError(f"Patched runtime dependency has no Maven version: {jar_path}")
                properties = archive.read(properties_name).decode("utf-8")
                property_map = dict(
                    line.split("=", 1)
                    for line in properties.splitlines()
                    if "=" in line
                )
                expected_properties = {
                    "groupId": "com.fasterxml.jackson.core",
                    "artifactId": artifact,
                    "version": PATCHED_VERSION,
                }
                if any(property_map.get(key) != value for key, value in expected_properties.items()):
                    raise ValueError(f"Unexpected patched dependency Maven coordinates in {jar_path}")
                _verify_patched_pom(archive.read(descriptor_names[1]), artifact)
                if required_class not in archive.namelist():
                    raise ValueError(f"Patched runtime dependency class is missing: {required_class}")
                jackson_class_basenames.update(
                    Path(name).name
                    for name in archive.namelist()
                    if name.endswith(".class")
                    and Path(name).name not in {"module-info.class", "package-info.class"}
                )
    return jackson_class_basenames, patched_descriptors


def synchronize_descriptors(
    jar_path: Path,
    jackson_class_basenames: set[str],
    patched_descriptors: dict[str, bytes],
) -> int:
    with zipfile.ZipFile(jar_path, "r") as source:
        entries = {entry.filename for entry in source.infolist()}
        required = {
            descriptor
            for artifact in JACKSON_ARTIFACTS
            for descriptor in _descriptor_names(artifact)
        }
        entry_names = [entry.filename for entry in source.infolist()]
        for descriptor in required:
            if entry_names.count(descriptor) != 1:
                raise ValueError(f"Expected exactly one pinned Jackson metadata entry {descriptor}")
            if descriptor not in patched_descriptors:
                raise ValueError(f"Patched runtime metadata is missing: {descriptor}")

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
            else:
                text = content.decode("utf-8")
                if text.count(EXPECTED_VERSION) != 3:
                    raise ValueError(f"Expected parent, project, and SCM versions in {descriptor}")
            # Copy the exact Maven descriptors from the checksum-pinned patched
            # runtime jar; do not synthesize a POM or rewrite a version heuristically.
            updated_contents[descriptor] = patched_descriptors[descriptor]

    _replace_zip_members(jar_path, updated_contents)
    with zipfile.ZipFile(jar_path, "r") as verified:
        for descriptor in required:
            content = verified.read(descriptor).decode("utf-8")
            if EXPECTED_VERSION in content:
                raise ValueError(f"Stale Jackson descriptor remains after synchronization: {descriptor}")
            if descriptor.endswith("pom.properties") and f"version={PATCHED_VERSION}" not in content:
                raise ValueError(f"Corrected Jackson version missing after synchronization: {descriptor}")
    return len(updated_contents)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path, help="OpenSearch installation root")
    args = parser.parse_args()
    jars = list(args.root.rglob("opensaml-3.9.0.0-all.jar"))
    if len(jars) != 1:
        raise SystemExit(f"Expected exactly one pinned OpenSAML aggregate jar; found {len(jars)}")
    verify_pinned_opensaml(jars[0])
    jackson_class_basenames, patched_descriptors = verify_patched_runtime(args.root)
    updated = synchronize_descriptors(jars[0], jackson_class_basenames, patched_descriptors)
    print(
        f"Updated {updated} Jackson Maven metadata entries from 2.22.2 to 2.22.3; "
        "verified patched runtime jars and no Jackson implementation classes bundled in OpenSAML."
    )


if __name__ == "__main__":
    main()
