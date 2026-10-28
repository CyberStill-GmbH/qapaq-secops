#!/usr/bin/env bash
# Verifica las reglas de prioridad QAPAQ contra un manager Wazuh 4.14.8 con wazuh-logtest.
#
# Uso: run-logtest.sh <contenedor-wazuh-manager>
#
# El contenedor debe tener cargadas las reglas de AD, endpoint, launch-detections, office365
# y prioridad, más las listas CDB de ../lists/*.example normalizadas por apply-priority.sh
# (ver .github/workflows/wazuh-priority-detections.yml). Los eventos son sintéticos (RFC 5737,
# dominios .example).
#
# Cada línea de expected-rules.txt corresponde a la línea homóloga de logtest-cases.jsonl:
#   <id>          la regla final debe ser esa
#   <id>|<id>     se acepta cualquiera (reglas que dependen de la hora del manager)
#   0             ninguna regla con nivel mayor que 0
# Lo que sigue a un tabulador o `#` es comentario. Los casos se envían en una sola sesión
# porque las reglas de frecuencia (101213, 100503, 100505) dependen del orden.
set -Eeuo pipefail

container="${1:?Uso: run-logtest.sh <contenedor-wazuh-manager>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output="$(mktemp)"
trap 'rm -f "${output}"' EXIT

docker exec "${container}" /var/ossec/bin/wazuh-analysisd -t
docker exec --interactive "${container}" /var/ossec/bin/wazuh-logtest \
  <"${here}/logtest-cases.jsonl" >"${output}" 2>&1

python_bin="$(command -v python3 || command -v python)" || { echo 'Se requiere Python 3.' >&2; exit 1; }
"${python_bin}" - "${output}" "${here}/expected-rules.txt" <<'PY'
import re
import sys

output_path, expected_path = sys.argv[1:3]
text = open(output_path, encoding="utf-8", errors="replace").read()
blocks = text.split("**Phase 1: Completed pre-decoding.")[1:]
expected = []
for line in open(expected_path, encoding="utf-8"):
    value = re.split(r"[\t#]", line, maxsplit=1)[0].strip()
    if value:
        expected.append((value, line.strip()))
if len(blocks) != len(expected):
    print(text)
    sys.exit(f"logtest procesó {len(blocks)} eventos; se esperaban {len(expected)}")

failures = []
for index, (block, (wanted, label)) in enumerate(zip(blocks, expected), start=1):
    match = re.search(r"id: '(\d+)'\s+level: '(\d+)'", block)
    actual = match.group(1) if match else "none"
    if wanted == "0":
        valid = not match or match.group(2) == "0"
    else:
        valid = actual in wanted.split("|")
    if not valid:
        level = match.group(2) if match else "-"
        failures.append(f"caso {index:02d}: esperado {wanted}, obtenido {actual} (nivel {level}) · {label}")

if failures:
    print(text)
    print("\n".join(failures))
    sys.exit(1)
print(f"{len(expected)}/{len(expected)} casos correctos")
PY
