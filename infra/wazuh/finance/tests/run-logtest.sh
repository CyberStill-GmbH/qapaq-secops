#!/usr/bin/env bash
# Verifica las reglas financieras QAPAQ contra un Manager Wazuh real con wazuh-logtest.
#
# Uso: run-logtest.sh <contenedor-wazuh-manager>
#
# El contenedor debe tener cargadas las reglas de office365, active-directory,
# launch-detections y finance, y las listas CDB de ejemplo (ver
# .github/workflows/wazuh-finance-detections.yml, que lo prepara con prepare-container.sh).
# Las reglas con <time> exigen que analysisd corra con hora local nocturna; el workflow
# arranca el Manager con TZ calculada para que sean las 23:00.
#
# Cada línea de expected-rules.txt es la regla esperada para la línea homóloga de
# logtest-cases.jsonl; `!<id>` exige que esa regla NO dispare, `<a>|<b>` acepta
# cualquiera de las dos y `---` inicia una sesión nueva de wazuh-logtest (cada sesión
# tiene su propio estado de frecuencia e ignore).
set -Eeuo pipefail

container="${1:?Uso: run-logtest.sh <contenedor-wazuh-manager>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT

python_bin="$(command -v python3 || command -v python)" || { echo 'Se requiere Python 3.' >&2; exit 1; }
"${python_bin}" "${here}/generate_cases.py" --check

# Una sesión de logtest por bloque separado con `---`.
awk -v dir="${workdir}" 'BEGIN { n = 1 } /^---$/ { n++; next } { print > (dir "/session-" n ".jsonl") }' \
  "${here}/logtest-cases.jsonl"

for session in $(ls "${workdir}"/session-*.jsonl | sort -V); do
  name="$(basename "${session}" .jsonl)"
  docker cp "${session}" "${container}:/tmp/qapaq-finance-${name}.jsonl" >/dev/null
  MSYS_NO_PATHCONV=1 docker exec "${container}" \
    sh -c "/var/ossec/bin/wazuh-logtest < /tmp/qapaq-finance-${name}.jsonl" >"${workdir}/${name}.out" 2>&1
done

"${python_bin}" - "${workdir}" "${here}/expected-rules.txt" <<'PY'
import re
import sys
from pathlib import Path

workdir, expected_path = Path(sys.argv[1]), sys.argv[2]
sessions: list[list[str]] = [[]]
for line in open(expected_path, encoding='utf-8'):
    line = line.strip()
    if line == '---':
        sessions.append([])
    elif line:
        sessions[-1].append(line)

failures = total = 0
for number, expected in enumerate(sessions, start=1):
    text = (workdir / f'session-{number}.out').read_text(encoding='utf-8', errors='replace')
    blocks = text.split('**Phase 1: Completed pre-decoding.')[1:]
    if len(blocks) != len(expected):
        print(text[-3000:])
        sys.exit(f'sesión {number}: logtest procesó {len(blocks)} eventos; se esperaban {len(expected)}.')
    for index, (block, want) in enumerate(zip(blocks, expected), start=1):
        total += 1
        match = re.search(r"id: '(\d+)'", block)
        got = match.group(1) if match else '-'
        if want.startswith('!'):
            ok = got != want[1:]
        else:
            ok = got in want.split('|')
        if not ok:
            failures += 1
            print(f'sesión {number} caso {index:03d}: esperado {want}, obtenido {got}')
print(f'{total - failures}/{total} casos correctos en {len(sessions)} sesiones')
sys.exit(1 if failures else 0)
PY
