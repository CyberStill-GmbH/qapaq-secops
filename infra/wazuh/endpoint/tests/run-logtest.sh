#!/usr/bin/env bash
# Prueba la regla QAPAQ de Outlook contra el motor Wazuh real en un contenedor aislado.
set -Eeuo pipefail

container="${1:-qapaq-wazuh-endpoint-test}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="$(mktemp)"
trap 'rm -f "${output}"' EXIT

docker cp "${here}/rules/qapaq_endpoint_rules.xml" "${container}:/var/ossec/etc/rules/qapaq_endpoint_rules.xml" >/dev/null
docker exec "${container}" python3 - <<'PY'
import re
from pathlib import Path

path = Path('/var/ossec/ruleset/rules/0575-win-base_rules.xml')
source = path.read_text(encoding='utf-8')
updated, count = re.subn(
    r'(<rule id="60000" level="0">\s*)<category>ossec</category>\s*'
    r'<decoded_as>windows_eventchannel</decoded_as>',
    r'\1<decoded_as>json</decoded_as>',
    source,
    count=1,
)
if count != 1:
    raise SystemExit('No se pudo preparar el decoder JSON temporal de EventChannel en el contenedor.')
path.write_text(updated, encoding='utf-8')
PY
docker exec "${container}" /var/ossec/bin/wazuh-analysisd -t
docker exec --interactive "${container}" /var/ossec/bin/wazuh-logtest <"${here}/tests/sysmon-cases.jsonl" >"${output}" 2>&1

python3 - "${output}" "${here}/tests/expected-rules.txt" <<'PY'
import re
import sys

output_path, expected_path = sys.argv[1:3]
text = open(output_path, encoding="utf-8", errors="replace").read()
blocks = text.split("**Phase 1: Completed pre-decoding.")[1:]
expected = [line.strip() for line in open(expected_path, encoding="utf-8") if line.strip()]
if len(blocks) != len(expected):
    print(text)
    sys.exit(f"logtest procesó {len(blocks)} eventos; se esperaban {len(expected)}")

failures = 0
for index, (block, wanted) in enumerate(zip(blocks, expected), start=1):
    fired = bool(re.search(r"id: '101100'", block))
    should_fire = wanted == "101100"
    if fired != should_fire:
        failures += 1
        print(f"caso {index:02d}: esperado {wanted}, detección={'101100' if fired else 'ausente'}")
print(f"{len(expected) - failures}/{len(expected)} casos correctos")
sys.exit(1 if failures else 0)
PY
