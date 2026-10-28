#!/usr/bin/env python3
"""Fetch Ankay runtime secrets from Key Vault using the VM managed identity.

Only environment-variable names and Key Vault secret names are supplied in the
configuration. Secret values are kept in memory and written to a root-only,
atomically replaced Compose env file. Values are never printed.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import stat
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


IMDS_TOKEN_URL = "http://169.254.169.254/metadata/identity/oauth2/token"
KEY_VAULT_RESOURCE = "https://vault.azure.net"
KEY_VAULT_API_VERSION = "7.4"
NAME_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{0,127}$")
SECRET_NAME_PATTERN = re.compile(r"^[A-Za-z0-9-]{1,127}$")


class BootstrapError(Exception):
    """An error safe to report without including a credential value."""


def request_json(request: urllib.request.Request, *, attempts: int = 12) -> dict:
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                value = json.load(response)
            if not isinstance(value, dict):
                raise BootstrapError("identity or Key Vault returned an invalid response")
            return value
        except urllib.error.HTTPError as error:
            if error.code not in (403, 408, 429, 500, 502, 503, 504) or attempt == attempts - 1:
                raise BootstrapError(f"identity or Key Vault request failed (HTTP {error.code})") from None
        except (OSError, json.JSONDecodeError, urllib.error.URLError):
            if attempt == attempts - 1:
                raise BootstrapError("identity or Key Vault request failed") from None
        time.sleep(min(2 ** attempt, 20))
    raise BootstrapError("identity or Key Vault request failed")


def managed_identity_token(client_id: str) -> str:
    query = urllib.parse.urlencode(
        {
            "api-version": "2018-02-01",
            "resource": KEY_VAULT_RESOURCE,
            "client_id": client_id,
        }
    )
    request = urllib.request.Request(
        f"{IMDS_TOKEN_URL}?{query}", headers={"Metadata": "true"}
    )
    token = request_json(request).get("access_token")
    if not isinstance(token, str) or not token:
        raise BootstrapError("managed identity did not return a Key Vault token")
    return token


def get_secret(vault_uri: str, token: str, secret_name: str) -> str:
    url = (
        f"{vault_uri.rstrip('/')}/secrets/{urllib.parse.quote(secret_name, safe='')}"
        f"?api-version={KEY_VAULT_API_VERSION}"
    )
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    value = request_json(request).get("value")
    if not isinstance(value, str) or not value or any(char in value for char in ("\r", "\n", "\x00")):
        raise BootstrapError(f"Key Vault secret {secret_name} is missing or is not a single-line value")
    return value


def compose_env_quote(value: str) -> str:
    # Compose .env supports single-quoted values and backslash escapes inside them.
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def write_private_file(path: pathlib.Path, content: bytes) -> None:
    if not path.parent.is_dir():
        raise BootstrapError("runtime env directory is missing")
    fd, temp_name = tempfile.mkstemp(prefix=".runtime.env.", dir=path.parent)
    temp_path = pathlib.Path(temp_name)
    try:
        os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(fd, "wb", closefd=True) as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, path)
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
        dir_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except Exception:
        try:
            temp_path.unlink(missing_ok=True)
        finally:
            raise


def parse_mapping(raw: str) -> dict[str, str]:
    try:
        mapping = json.loads(raw)
    except json.JSONDecodeError:
        raise BootstrapError("secret-name mapping is invalid JSON") from None
    if not isinstance(mapping, dict) or not mapping:
        raise BootstrapError("secret-name mapping must be a non-empty JSON object")
    for env_name, secret_name in mapping.items():
        if not isinstance(env_name, str) or not NAME_PATTERN.fullmatch(env_name):
            raise BootstrapError("secret-name mapping has an invalid environment-variable name")
        if not isinstance(secret_name, str) or not SECRET_NAME_PATTERN.fullmatch(secret_name):
            raise BootstrapError("secret-name mapping has an invalid Key Vault secret name")
    return mapping


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--key-vault-uri", required=True)
    parser.add_argument("--identity-client-id", required=True)
    parser.add_argument("--mapping-json", required=True)
    parser.add_argument("--output", default="/etc/ankay/runtime.env")
    args = parser.parse_args()

    if os.geteuid() != 0:
        raise BootstrapError("runtime secret retrieval must run as root")
    if not re.fullmatch(r"https://[A-Za-z0-9-]+\.vault\.azure\.net/?", args.key_vault_uri):
        raise BootstrapError("Key Vault URI is invalid")
    if not re.fullmatch(
        r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
        args.identity_client_id,
    ):
        raise BootstrapError("managed identity client ID is invalid")

    mapping = parse_mapping(args.mapping_json)
    token = managed_identity_token(args.identity_client_id)
    entries = [f"{env_name}={compose_env_quote(get_secret(args.key_vault_uri, token, secret_name))}" for env_name, secret_name in mapping.items()]
    del token
    output = pathlib.Path(args.output)
    write_private_file(output, ("\n".join(entries) + "\n").encode("utf-8"))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BootstrapError as error:
        print(f"ankay-secret-bootstrap: ERROR: {error}", file=__import__("sys").stderr, flush=True)
        raise SystemExit(1)
