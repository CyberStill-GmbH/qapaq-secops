#!/usr/bin/env python3
"""Prepare the protected ARM parameters for the EUS2 PostgreSQL role bootstrap.

Generates the runtime password (and, only when asked, the entity-reference HMAC key) on the
runner, reads the Flexible Server administrator password from the environment, and writes
one 0600 create-only parameter file. No value is printed or passed in argv.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
HOST_SCRIPT = ROOT / "wazuh" / "core" / "postgres-bootstrap-azure.py"
HEREDOC_DELIMITER = "QAPAQ_POSTGRES_BOOTSTRAP_PY"
MASTER_USERNAME = "qapaqbootstrap"
VAULT_NAME = "kv-qapaqsecopsd-3a2405f3"
VM_NAME = "vm-qapaqsecopsdemoeus-siem"
LOCATION = "eastus2"
MAX_SCRIPT_CHARS = 32_000


class BootstrapInputError(ValueError):
    """A validation error whose message never contains a secret value."""


def run_command_script() -> str:
    """Wrap the host script in bash: Run Command executes shell scripts on Linux."""
    source = HOST_SCRIPT.read_text(encoding="utf-8")
    if HEREDOC_DELIMITER in source:
        raise BootstrapInputError("Host script contains the heredoc delimiter.")
    script = (
        "#!/bin/bash\nset -euo pipefail\numask 077\n"
        f"exec /usr/bin/python3 - <<'{HEREDOC_DELIMITER}'\n{source}{HEREDOC_DELIMITER}\n"
    )
    if len(script) > MAX_SCRIPT_CHARS:
        raise BootstrapInputError("Host script exceeds the Run Command template limit.")
    return script


def run_command_name(run_id: str, run_attempt: str) -> str:
    if not re.fullmatch(r"[0-9]{1,20}", run_id) or not re.fullmatch(r"[0-9]{1,4}", run_attempt):
        raise BootstrapInputError("GitHub run identifiers are invalid.")
    return f"qapaq-postgres-bootstrap-{run_id}-{run_attempt}"


def build_parameters(
    *,
    master_password: str,
    create_entity_ref_key: bool,
    run_id: str,
    run_attempt: str,
    token: callable = secrets.token_urlsafe,
) -> dict:
    if not master_password or any(character in master_password for character in "\r\n\x00"):
        raise BootstrapInputError("Administrator password is empty or not a single line.")
    runtime_password = token(48)
    if len(runtime_password) < 64 or runtime_password == master_password:
        raise BootstrapInputError("Generated runtime password is invalid.")
    parameters = {
        "vaultName": {"value": VAULT_NAME},
        "vmName": {"value": VM_NAME},
        "location": {"value": LOCATION},
        "runCommandName": {"value": run_command_name(run_id, run_attempt)},
        "script": {"value": run_command_script()},
        "masterUsername": {"value": MASTER_USERNAME},
        "masterPassword": {"value": master_password},
        "runtimePassword": {"value": runtime_password},
        "createEntityRefKey": {"value": create_entity_ref_key},
    }
    if create_entity_ref_key:
        # D-10b: created once; an existing key is never rotated by this flow.
        parameters["entityRefKey"] = {"value": token(48)}
    return {
        "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
        "contentVersion": "1.0.0.0",
        "parameters": parameters,
    }


def write_parameters(destination: Path, payload: dict) -> None:
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", metavar="PARAMETER_FILE", required=True)
    args = parser.parse_args()
    try:
        create_flag = os.environ.get("CREATE_ENTITY_REF_KEY", "")
        if create_flag not in ("true", "false"):
            raise BootstrapInputError("CREATE_ENTITY_REF_KEY must be true or false.")
        payload = build_parameters(
            master_password=os.environ.get("POSTGRES_ADMIN_PASSWORD", ""),
            create_entity_ref_key=create_flag == "true",
            run_id=os.environ.get("GITHUB_RUN_ID", ""),
            run_attempt=os.environ.get("GITHUB_RUN_ATTEMPT", ""),
        )
        write_parameters(Path(args.write), payload)
    except (BootstrapInputError, OSError) as error:
        message = str(error) if isinstance(error, BootstrapInputError) else "Protected file creation failed."
        print(f"::error::{message}", file=sys.stderr)
        return 1
    finally:
        # This only drops Python references; it is not a forensic memory wipe.
        payload = None
    print("Protected PostgreSQL bootstrap parameters prepared; no value was logged.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
