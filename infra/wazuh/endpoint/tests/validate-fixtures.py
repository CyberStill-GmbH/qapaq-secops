#!/usr/bin/env python3
"""Evaluate synthetic Sysmon fields against the regexes in the production rule."""

import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

here = Path(__file__).resolve().parent
rule_path = here.parent / "rules" / "qapaq_endpoint_rules.xml"
rule_root = ET.parse(rule_path).getroot()
rule = rule_root.find("rule[@id='101100']")
if rule is None:
    raise SystemExit("Missing production rule 101100")

if_group = rule.findtext("if_group", "").strip()
if if_group != "sysmon_event1":
    raise SystemExit(f"Rule 101100 must retain if_group sysmon_event1; got {if_group!r}")

patterns = {}
for field in rule.findall("field"):
    name = field.attrib.get("name")
    pattern = field.text or ""
    flags = re.IGNORECASE if pattern.startswith("(?i)") else 0
    pattern = pattern.removeprefix("(?i)")
    patterns[name] = re.compile(pattern, flags)

required = {"win.eventdata.parentImage", "win.eventdata.image"}
if set(patterns) != required:
    raise SystemExit(f"Rule fields changed unexpectedly: {sorted(patterns)}")

expected = [line.strip() for line in (here / "expected-rules.txt").read_text().splitlines() if line.strip()]
events = [json.loads(line) for line in (here / "sysmon-cases.jsonl").read_text().splitlines() if line.strip()]
if len(events) != len(expected):
    raise SystemExit(f"Fixture count mismatch: {len(events)} events / {len(expected)} expectations")

failures = 0
for index, (event, wanted) in enumerate(zip(events, expected), start=1):
    data = event.get("win", {}).get("eventdata", {})
    matched = all(patterns[name].search(str(data.get(name.rsplit(".", 1)[1], ""))) for name in required)
    should_match = wanted == "101100"
    if matched != should_match:
        failures += 1
        print(f"case {index:02d}: expected {'101100' if should_match else 'no alert'}, got {'101100' if matched else 'no alert'}")

if failures:
    sys.exit(1)
print(f"PASS: {len(expected)} synthetic positive/negative cases match rule 101100 patterns")
print("Note: analysisd -t validates Wazuh syntax; this harness does not emulate native EventChannel decoding.")
