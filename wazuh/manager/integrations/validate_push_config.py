#!/usr/bin/env python3
"""Validate and render the dormant Wazuh push integration template safely."""
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


DNS_LABEL = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")


def validate_hostname(hostname: str) -> None:
    if not hostname or len(hostname) > 253 or not hostname.isascii():
        raise ValueError("SOC_HOSTNAME must be an ASCII DNS hostname")
    labels = hostname.split(".")
    if len(labels) < 2 or any(not DNS_LABEL.fullmatch(label) for label in labels):
        raise ValueError("SOC_HOSTNAME must contain valid DNS labels")


def validate_template(template_path: Path, hostname: str) -> None:
    validate_hostname(hostname)
    template = template_path.read_text(encoding="utf-8")
    rendered = template.replace("${SOC_HOSTNAME}", hostname)
    root = ET.fromstring(rendered)
    integrations = [
        node for node in root.findall("integration")
        if node.findtext("name") == "custom-qapaq"
    ]
    if len(integrations) != 1:
        raise ValueError("expected exactly one custom-qapaq integration")
    integration = integrations[0]
    if integration.findtext("api_key") != "QAPAQ_SECRET_FILE_V1":
        raise ValueError("integration must use the non-secret file marker")
    expected_url = f"https://{hostname}/api/ingest/wazuh"
    if integration.findtext("hook_url") != expected_url:
        raise ValueError("unexpected Wazuh push URL")
    if integration.findtext("level") != "3":
        raise ValueError("Wazuh push minimum level must be 3")
    groups = {group.strip() for group in (integration.findtext("group") or "").split(",")}
    if not {"qapaq_provider", "office365"}.issubset(groups):
        raise ValueError("Wazuh push must include QAPAQ provider and Office 365 groups")


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: validate_push_config.py TEMPLATE SOC_HOSTNAME", file=sys.stderr)
        return 2
    try:
        validate_template(Path(argv[1]), argv[2])
    except (OSError, ValueError, ET.ParseError) as error:
        print(f"Wazuh push configuration invalid: {error}", file=sys.stderr)
        return 1
    print("Wazuh push XML template valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
