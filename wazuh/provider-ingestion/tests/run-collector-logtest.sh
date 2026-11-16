#!/usr/bin/env bash
# Valida las reglas QAPAQ de Bitdefender/Snyk/Cloudflare contra un manager Wazuh real.
#   bash wazuh/provider-ingestion/tests/run-collector-logtest.sh <contenedor-manager>
# El contenedor debe tener instaladas las reglas de wazuh/provider-ingestion/rules/.
set -Eeuo pipefail
container="${1:?contenedor del manager}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output="$(mktemp)"
trap 'rm -f "${output}"' EXIT
docker exec "${container}" /var/ossec/bin/wazuh-analysisd -t
docker exec --interactive "${container}" /var/ossec/bin/wazuh-logtest <"${here}/collector-cases.jsonl" >"${output}" 2>&1
"${PYTHON:-python3}" - "${output}" "${here}/collector-expected-rules.txt" <<'PY'
import re
import sys

output_path, expected_path = sys.argv[1:3]
text = open(output_path, encoding="utf-8", errors="replace").read()
blocks = text.split("**Phase 1: Completed pre-decoding.")[1:]
expected = [line.strip() for line in open(expected_path, encoding="utf-8") if line.strip()]
if len(blocks) != len(expected):
    print(text[-4000:])
    sys.exit(f"logtest procesó {len(blocks)} eventos; se esperaban {len(expected)}")
failures = []
for index, (block, wanted) in enumerate(zip(blocks, expected), start=1):
    match = re.search(r"id: '(\d+)'\s+level: '(\d+)'", block)
    actual = match.group(1) if match else "none"
    if actual != wanted:
        failures.append(f"caso {index:02d}: esperado {wanted}, obtenido {actual}")
if failures:
    print("\n".join(failures))
    sys.exit(1)
print(f"{len(expected)}/{len(expected)} casos correctos")
PY
