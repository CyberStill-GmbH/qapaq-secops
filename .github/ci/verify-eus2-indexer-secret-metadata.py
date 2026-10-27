#!/usr/bin/env python3
"""Confirm the two opt-in KrakenD Key Vault references exist without reading values."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys


EXPECTED_NAMES = {
    "indexer_reader_secret_name": "wazuh-reader-b64",
    "indexer_proxy_ca_secret_name": "wazuh-proxy-ca",
}
SUBSCRIPTION_ID = "aaf787f8-5964-4470-9eb6-89d15eacda61"
RESOURCE_GROUP = "rg-qapaqsecopsdemoeus-3a2405f3"
VAULT_NAME = "kv-qapaqsecopsd-3a2405f3"
API_VERSION = "2025-05-01"


class PreflightError(ValueError):
    """A safe error that includes no secret material or CLI response body."""


def selected_secret_ids(environment: dict[str, str]) -> list[str]:
    raw = environment.get("TF_VAR_krakend_gateway", "null")
    try:
        gateway = json.loads(raw)
    except (json.JSONDecodeError, TypeError) as exc:
        raise PreflightError("KrakenD configuration is not valid JSON.") from exc
    if gateway is None:
        return []
    if not isinstance(gateway, dict):
        raise PreflightError("KrakenD configuration is not an object.")

    ids: list[str] = []
    for key, expected in EXPECTED_NAMES.items():
        if gateway.get(key) != expected:
            raise PreflightError("KrakenD must use the exact two pre-seeded Key Vault references.")
        ids.append(
            f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups/{RESOURCE_GROUP}"
            f"/providers/Microsoft.KeyVault/vaults/{VAULT_NAME}/secrets/{expected}"
        )
    if len(set(ids)) != 2:
        raise PreflightError("KrakenD Key Vault references must be distinct.")
    return ids


def verify_metadata(environment: dict[str, str], run=subprocess.run) -> None:
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", environment.get("AZURE_SUBSCRIPTION_ID", "")):
        raise PreflightError("Azure subscription context is missing or malformed.")
    if environment["AZURE_SUBSCRIPTION_ID"].lower() != SUBSCRIPTION_ID:
        raise PreflightError("Azure CLI is not signed in to the dedicated EUS2 subscription.")

    for secret_id in selected_secret_ids(environment):
        result = run(
            [
                "az",
                "resource",
                "show",
                "--ids",
                secret_id,
                "--api-version",
                API_VERSION,
                "--query",
                "{id:id,enabled:properties.attributes.enabled}",
                "--output",
                "json",
                "--only-show-errors",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise PreflightError("A required Key Vault secret reference is absent or unreadable.")
        try:
            metadata = json.loads(result.stdout)
        except (json.JSONDecodeError, TypeError) as exc:
            raise PreflightError("Key Vault returned invalid metadata for a required reference.") from exc
        if not isinstance(metadata, dict) or metadata.get("id", "").lower() != secret_id.lower() or metadata.get("enabled") is not True:
            raise PreflightError("A required Key Vault secret is disabled or does not match its expected scope.")


def main() -> int:
    try:
        verify_metadata(os.environ)
    except PreflightError as exc:
        print(f"East US 2 KrakenD Key Vault preflight rejected: {exc}", file=sys.stderr)
        return 1
    print("Required KrakenD Key Vault secret references exist and are enabled; values were not requested.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
