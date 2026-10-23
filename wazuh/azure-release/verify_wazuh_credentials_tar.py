#!/usr/bin/env python3
"""Decode and validate the Wazuh assistant credential/certificate tar from Key Vault."""

from __future__ import annotations

import base64
import io
import pathlib
import sys
import tarfile


MAX_ENCODED_BYTES = 24_000
MAX_ARCHIVE_BYTES = 18_000
MAX_ARCHIVE_MEMBERS = 32
MAX_EXTRACTED_BYTES = 4 * 1024 * 1024
MAX_MEMBER_BYTES = 2 * 1024 * 1024
PASSWORDS_MEMBER = "wazuh-install-files/wazuh-passwords.txt"
CERTIFICATES_PREFIX = "wazuh-install-files/wazuh-certificates/"


def decode_and_validate(encoded_path: pathlib.Path, output_path: pathlib.Path) -> None:
    encoded = encoded_path.read_bytes()
    if len(encoded) > MAX_ENCODED_BYTES or b"\n" in encoded or b"\r" in encoded:
        raise ValueError("Key Vault archive must be one-line base64 within the configured size limit")
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise ValueError("Key Vault archive is not strict base64") from error
    if not payload or len(payload) > MAX_ARCHIVE_BYTES:
        raise ValueError("decoded Wazuh archive is empty or exceeds the configured size limit")

    try:
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:") as archive:
            members = archive.getmembers()
            if len(members) > MAX_ARCHIVE_MEMBERS:
                raise ValueError("Wazuh archive contains too many members")

            names: set[str] = set()
            extracted_bytes = 0
            for member in members:
                path = pathlib.PurePosixPath(member.name)
                normalized_name = path.as_posix().rstrip("/")
                if (
                    normalized_name in {"", "."}
                    or path.is_absolute()
                    or ".." in path.parts
                    or "\\" in member.name
                    or "\x00" in member.name
                    or not (member.isfile() or member.isdir())
                ):
                    raise ValueError("Wazuh archive contains an unsafe member")
                if normalized_name in names:
                    raise ValueError("Wazuh archive contains duplicate member paths")
                names.add(normalized_name)
                if member.size < 0 or member.size > MAX_MEMBER_BYTES:
                    raise ValueError("Wazuh archive member exceeds the configured size limit")
                extracted_bytes += member.size
                if extracted_bytes > MAX_EXTRACTED_BYTES:
                    raise ValueError("Wazuh archive exceeds the configured expanded size limit")

            if not any(member.name == PASSWORDS_MEMBER and member.isfile() for member in members):
                raise ValueError("Wazuh archive lacks the official passwords file")
            if not any(member.name.startswith(CERTIFICATES_PREFIX) and member.isfile() for member in members):
                raise ValueError("Wazuh archive lacks generated Wazuh certificates")
    except tarfile.TarError as error:
        raise ValueError("Wazuh credential archive is not a valid tar") from error

    output_path.write_bytes(payload)
    output_path.chmod(0o600)


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: verify_wazuh_credentials_tar.py <base64-file> <output-tar>", file=sys.stderr)
        return 2
    try:
        decode_and_validate(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
    except (OSError, ValueError) as error:
        print(f"wazuh-certificate-input: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
