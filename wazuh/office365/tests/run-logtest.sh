#!/usr/bin/env bash
# Verifica las reglas QAPAQ de Office 365 contra un manager Wazuh real con wazuh-logtest.
#
# Uso: run-logtest.sh <contenedor-wazuh-manager>
#
# El contenedor debe tener aplicadas las reglas y la lista break-glass de ejemplo, por
# ejemplo ejecutando antes apply-office365.sh con QAPAQ_BREAK_GLASS_SOURCE apuntando a
# lists/qapaq-break-glass.example. Los eventos son sintéticos (RFC 5737, dominios
# .example) y reproducen la forma que el módulo office365 deja en el log.
#
# Cada línea de expected-rules.txt es el ID de regla esperado para la línea homóloga de
# logtest-cases.jsonl; `!<id>` exige que esa regla NO dispare. Las reglas de frecuencia
# dependen del orden: los casos se envían en una sola sesión de logtest.
set -Eeuo pipefail

container="${1:?Uso: run-logtest.sh <contenedor-wazuh-manager>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output="$(mktemp)"
trap 'rm -f "${output}"' EXIT

docker cp "${here}/logtest-cases.jsonl" "${container}:/tmp/qapaq-logtest-cases.jsonl" >/dev/null
MSYS_NO_PATHCONV=1 docker exec "${container}" \
  sh -c '/var/ossec/bin/wazuh-logtest < /tmp/qapaq-logtest-cases.jsonl' >"${output}" 2>&1

# `python3` en Linux/CI; `python` en Windows (Git Bash).
python_bin="$(command -v python3 || command -v python)" || { echo 'Se requiere Python 3.' >&2; exit 1; }
"${python_bin}" - "${output}" "${here}/expected-rules.txt" <<'PY'
import re
import sys

output, expected_path = sys.argv[1:3]
blocks = open(output, encoding='utf-8', errors='replace').read().split(
    '**Phase 1: Completed pre-decoding.')[1:]
expected = [line.strip() for line in open(expected_path, encoding='utf-8') if line.strip()]
if len(blocks) != len(expected):
    sys.exit(f'logtest procesó {len(blocks)} eventos; se esperaban {len(expected)}.')

failures = 0
for index, (block, want) in enumerate(zip(blocks, expected), start=1):
    match = re.search(r"id: '(\d+)'", block)
    got = match.group(1) if match else '-'
    ok = got != want[1:] if want.startswith('!') else got == want
    if not ok:
        failures += 1
        print(f'caso {index:02d}: esperado {want}, obtenido {got}')
print(f'{len(expected) - failures}/{len(expected)} casos correctos')
sys.exit(1 if failures else 0)
PY
