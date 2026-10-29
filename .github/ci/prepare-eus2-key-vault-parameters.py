#!/usr/bin/env python3
"""Create a mode-restricted ARM parameter file without logging secret values."""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import secrets
import sys
import tarfile
import uuid
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit


SOURCE_TO_SECRET = {
    "QAPAQ_EUS2_ENTRA_CLIENT_SECRET": "qapaq-entra-client-secret",
    "QAPAQ_EUS2_OFFICE365_CLIENT_SECRET": "office365-client-secret",
    "QAPAQ_EUS2_SOPHOS_CLIENT_ID": "sophos-client-id",
    "QAPAQ_EUS2_SOPHOS_CLIENT_SECRET": "sophos-client-secret",
    "QAPAQ_EUS2_CATO_API_KEY": "cato-api-key",
    "QAPAQ_EUS2_CATO_API_ENDPOINT": "cato-api-endpoint",
    "QAPAQ_EUS2_TEAMS_WORKFLOW_URL": "qapaq-teams-workflow-url",
    "QAPAQ_EUS2_WAZUH_INSTALL_FILES_TAR_B64": "wazuh-install-files.tar.b64",
}
BOOTSTRAP_SOURCE_TO_SECRET = {
    "QAPAQ_EUS2_WAZUH_INDEXER_READER_BOOTSTRAP": "wazuh-reader-b64",
    "QAPAQ_EUS2_WAZUH_INDEXER_PROXY_CA_BOOTSTRAP": "wazuh-proxy-ca",
}
BOOTSTRAP_PLACEHOLDER = "bootstrap-pending"
# Secretos de Ankay que nadie necesita conocer: el job los genera con CSPRNG justo antes
# del despliegue ARM create-only. Los consumidores (host Ankay, QAPAQ Core, Wazuh) los leen
# de Key Vault con su identidad; rotarlos es una operación aparte.
GENERATED_SOURCE_TO_SECRET = {
    "QAPAQ_EUS2_ANKAY_ENCRYPTION_MODIFIER": "ankay-shuffle-encryption-modifier",
    "QAPAQ_EUS2_ANKAY_OPENSEARCH_PASSWORD": "ankay-opensearch-admin-password",
    "QAPAQ_EUS2_ANKAY_ADMIN_PASSWORD": "ankay-admin-password",
    "QAPAQ_EUS2_ANKAY_ADMIN_API_KEY": "ankay-admin-api-key",
    "QAPAQ_EUS2_ANKAY_WAZUH_WEBHOOK_TOKEN": "ankay-wazuh-webhook-token",
    "QAPAQ_EUS2_ANKAY_DISPATCH_WEBHOOK_TOKEN": "ankay-dispatch-webhook-token",
    "QAPAQ_EUS2_ANKAY_DISPATCH_HMAC_KEY": "ankay-dispatch-hmac-key",
}


def generate_value(source_name: str) -> str:
    """Valor aleatorio del secreto generado; formato aceptado por Shuffle y el importador."""
    if source_name not in GENERATED_SOURCE_TO_SECRET:
        raise SeedInputError("Generated target is not allowlisted.")
    if source_name == "QAPAQ_EUS2_ANKAY_ADMIN_API_KEY":
        return str(uuid.UUID(bytes=secrets.token_bytes(16), version=4))
    # token_urlsafe: [A-Za-z0-9_-], válido como cabecera, en .env de Compose y en curl -u.
    return secrets.token_urlsafe(48)

MAX_TEXT_BYTES = 24_000
MAX_ARCHIVE_BYTES = 18_000
MAX_MEMBERS = 32
MAX_MEMBER_BYTES = 2 * 1024 * 1024
MAX_EXPANDED_BYTES = 4 * 1024 * 1024


class SeedInputError(ValueError):
    """A safe validation error that never includes a provided secret value."""


def resolve_secret_name(source_name: str) -> str:
    try:
        return {**SOURCE_TO_SECRET, **BOOTSTRAP_SOURCE_TO_SECRET, **GENERATED_SOURCE_TO_SECRET}[source_name]
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
    if source_name in BOOTSTRAP_SOURCE_TO_SECRET:
        raise SeedInputError("Bootstrap placeholders must use the fixed create-only path.")
    if source_name in GENERATED_SOURCE_TO_SECRET:
        raise SeedInputError("Generated Ankay secrets must use the generated create-only path.")
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


def _write_parameters(destination: Path, secret_name: str, value: str) -> None:
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


def write_parameters(destination: Path, source_name: str, value: str) -> None:
    _validate_secret(source_name, value)
    _write_parameters(destination, resolve_secret_name(source_name), value)


def write_bootstrap_placeholder(destination: Path, source_name: str) -> None:
    try:
        secret_name = BOOTSTRAP_SOURCE_TO_SECRET[source_name]
    except KeyError as exc:
        raise SeedInputError("Bootstrap target is not allowlisted.") from exc
    _write_parameters(destination, secret_name, BOOTSTRAP_PLACEHOLDER)


def write_generated(destination: Path, source_name: str) -> None:
    secret_name = GENERATED_SOURCE_TO_SECRET.get(source_name)
    if secret_name is None:
        raise SeedInputError("Generated target is not allowlisted.")
    value = generate_value(source_name)
    try:
        _write_parameters(destination, secret_name, value)
    finally:
        value = ""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--resolve-name", metavar="SOURCE_SECRET_NAME")
    group.add_argument("--write", metavar="PARAMETER_FILE")
    group.add_argument("--write-bootstrap-placeholder", metavar="PARAMETER_FILE")
    group.add_argument("--write-generated", metavar="PARAMETER_FILE")
    args = parser.parse_args()
    try:
        if args.resolve_name is not None:
            print(resolve_secret_name(args.resolve_name))
            return 0
        if args.write_generated is not None:
            write_generated(Path(args.write_generated), os.environ.get("SOURCE_SECRET_NAME", ""))
            print("Random Ankay secret generated into a protected ARM parameter file; value was not logged.")
            return 0
        if args.write_bootstrap_placeholder is not None:
            source_name = os.environ.get("SOURCE_SECRET_NAME", "")
            write_bootstrap_placeholder(Path(args.write_bootstrap_placeholder), source_name)
            print("Fixed Key Vault bootstrap placeholder prepared; no environment secret was resolved.")
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
