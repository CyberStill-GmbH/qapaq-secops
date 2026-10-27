#!/usr/bin/env python3
"""Create a mode-restricted ARM parameter file without logging secret values."""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import stat
import sys
import tarfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit


SOURCE_TO_SECRET = {
    "QAPAQ_EUS2_ENTRA_CLIENT_SECRET": "qapaq-entra-client-secret",
    "QAPAQ_EUS2_OFFICE365_CLIENT_SECRET": "office365-client-secret",
    "QAPAQ_EUS2_SOPHOS_CLIENT_ID": "sophos-client-id",
    "QAPAQ_EUS2_SOPHOS_CLIENT_SECRET": "sophos-client-secret",
    "QAPAQ_EUS2_CATO_API_KEY": "cato-api-key",
    "QAPAQ_EUS2_TEAMS_WORKFLOW_URL": "qapaq-teams-workflow-url",
    "QAPAQ_EUS2_WAZUH_INSTALL_FILES_TAR_B64": "wazuh-install-files.tar.b64",
}

MAX_TEXT_BYTES = 24_000
MAX_ARCHIVE_BYTES = 18_000
MAX_MEMBERS = 32
MAX_MEMBER_BYTES = 2 * 1024 * 1024
MAX_EXPANDED_BYTES = 4 * 1024 * 1024


class SeedInputError(ValueError):
    """A safe validation error that never includes a provided secret value."""


def resolve_secret_name(source_name: str) -> str:
    try:
        return SOURCE_TO_SECRET[source_name]
    except KeyError as exc:
        raise SeedInputError("Source secret name is not allowlisted.") from exc


def _validate_wazuh_archive(encoded: str) -> None:
    if len(encoded) > MAX_TEXT_BYTES or not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", encoded):
        raise SeedInputError("Wazuh bundle is not valid bounded base64.")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise SeedInputError("Wazuh bundle is not valid bounded base64.") from exc
    if not raw or len(raw) > MAX_ARCHIVE_BYTES:
        raise SeedInputError("Wazuh bundle exceeds the Key Vault input limit.")

    try:
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
            members = archive.getmembers()
            if not members or len(members) > MAX_MEMBERS:
                raise SeedInputError("Wazuh bundle has an invalid member count.")
            seen: set[str] = set()
            expanded_bytes = 0
            has_password_file = False
            has_certificate = False
            for member in members:
                name = member.name
                normalized = PurePosixPath(name).as_posix().rstrip("/")
                path = PurePosixPath(name)
                if (
                    not normalized
                    or normalized == "."
                    or path.is_absolute()
                    or ".." in path.parts
                    or "\\" in name
                    or "\x00" in name
                    or not (member.isfile() or member.isdir())
                    or normalized in seen
                ):
                    raise SeedInputError("Wazuh bundle contains an unsafe archive member.")
                seen.add(normalized)
                if member.size < 0 or member.size > MAX_MEMBER_BYTES:
                    raise SeedInputError("Wazuh bundle member exceeds its size limit.")
                expanded_bytes += member.size
                if expanded_bytes > MAX_EXPANDED_BYTES:
                    raise SeedInputError("Wazuh bundle exceeds its expanded size limit.")
                has_password_file |= name == "wazuh-install-files/wazuh-passwords.txt" and member.isfile()
                has_certificate |= name.startswith("wazuh-install-files/wazuh-certificates/") and member.isfile()
            if not has_password_file or not has_certificate:
                raise SeedInputError("Wazuh bundle is missing required installation material.")
    except SeedInputError:
        raise
    except (tarfile.TarError, OSError, EOFError) as exc:
        raise SeedInputError("Wazuh bundle is not a valid tar archive.") from exc
    finally:
        del raw


def _validate_secret(source_name: str, value: str) -> None:
    resolve_secret_name(source_name)
    if not value or "\r" in value or "\n" in value or "\x00" in value:
        raise SeedInputError("Selected secret is empty or not a single-line value.")
    try:
        byte_length = len(value.encode("utf-8", errors="strict"))
    except UnicodeEncodeError as exc:
        raise SeedInputError("Selected secret is not valid UTF-8.") from exc
    if byte_length > MAX_TEXT_BYTES:
        raise SeedInputError("Selected secret exceeds the Key Vault input limit.")
    if source_name == "QAPAQ_EUS2_TEAMS_WORKFLOW_URL":
        parsed = urlsplit(value)
        if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
            raise SeedInputError("Teams workflow URL must be an HTTPS URL without embedded credentials.")
    if source_name == "QAPAQ_EUS2_WAZUH_INSTALL_FILES_TAR_B64":
        _validate_wazuh_archive(value)


def write_parameters(destination: Path, source_name: str, value: str) -> None:
    _validate_secret(source_name, value)
    secret_name = resolve_secret_name(source_name)
    payload = {
        "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
        "contentVersion": "1.0.0.0",
        "parameters": {
            "vaultName": {"value": "kv-qapaqsecopsd-3a2405f3"},
            "secretName": {"value": secret_name},
            "secretValue": {"value": value},
        },
    }
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(destination, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
            stream.write("\n")
    except BaseException:
        try:
            destination.unlink(missing_ok=True)
        finally:
            raise


def write_wazuh_archive_parameters(destination: Path, archive_path: Path) -> None:
    """Build the ARM secureString parameter file from a bounded local tar.

    The generated archive value is never passed through argv, the environment,
    GitHub outputs, logs, summaries, or artifacts. The caller owns cleanup of
    both ephemeral files after the ARM request finishes.
    """
    try:
        path_info = archive_path.lstat()
    except OSError as exc:
        raise SeedInputError("Generated Wazuh archive cannot be inspected safely.") from exc
    if (
        not stat.S_ISREG(path_info.st_mode)
        or path_info.st_size <= 0
        or path_info.st_size > MAX_ARCHIVE_BYTES
    ):
        raise SeedInputError("Generated Wazuh archive exceeds the bounded regular-file contract.")

    try:
        descriptor = os.open(archive_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError as exc:
        raise SeedInputError("Generated Wazuh archive cannot be opened safely.") from exc
    encoded = ""
    try:
        file_info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(file_info.st_mode)
            or file_info.st_size <= 0
            or file_info.st_size > MAX_ARCHIVE_BYTES
            or (file_info.st_dev, file_info.st_ino) != (path_info.st_dev, path_info.st_ino)
        ):
            raise SeedInputError("Generated Wazuh archive exceeds the bounded regular-file contract.")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            raw = stream.read(MAX_ARCHIVE_BYTES + 1)
        if len(raw) > MAX_ARCHIVE_BYTES or len(raw) != file_info.st_size:
            raise SeedInputError("Generated Wazuh archive changed or exceeds its size limit.")
        encoded = base64.b64encode(raw).decode("ascii")
        del raw
        write_parameters(destination, "QAPAQ_EUS2_WAZUH_INSTALL_FILES_TAR_B64", encoded)
    finally:
        encoded = ""
        os.close(descriptor)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--resolve-name", metavar="SOURCE_SECRET_NAME")
    group.add_argument("--write", metavar="PARAMETER_FILE")
    group.add_argument(
        "--write-wazuh-archive",
        nargs=2,
        metavar=("PARAMETER_FILE", "GENERATED_TAR_FILE"),
    )
    args = parser.parse_args()
    try:
        if args.resolve_name is not None:
            print(resolve_secret_name(args.resolve_name))
            return 0
        if args.write_wazuh_archive is not None:
            parameter_path, archive_path = args.write_wazuh_archive
            write_wazuh_archive_parameters(Path(parameter_path), Path(archive_path))
            print("Protected ARM parameters prepared from the generated Wazuh archive; value was not logged.")
            return 0
        source_name = os.environ.get("SOURCE_SECRET_NAME", "")
        value = os.environ.get("SELECTED_SECRET_VALUE", "")
        write_parameters(Path(args.write), source_name, value)
    except (SeedInputError, OSError, ValueError):
        print("::error::Secret input validation or protected file creation failed.", file=sys.stderr)
        return 1
    finally:
        # This only drops Python references; it is not a forensic memory wipe.
        if "value" in locals():
            value = ""
    print("Protected ARM parameter file prepared; secret value was not logged.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
