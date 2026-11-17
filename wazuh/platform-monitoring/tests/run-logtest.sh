#!/usr/bin/env bash
# Valida las reglas de wazuh/platform-monitoring (101800-101879) con wazuh-logtest.
#   bash wazuh/platform-monitoring/tests/run-logtest.sh                # manager desechable 4.14.8
#   bash wazuh/platform-monitoring/tests/run-logtest.sh <contenedor>   # manager existente (solo lectura de
#                                                                      # reglas ya instaladas)
# En modo desechable instala las reglas de provider-ingestion, aws-events y platform-monitoring y dos
# listas CDB de prueba (qapaq-vuln-kev con CVE-2021-44228, qapaq-vuln-noise con CVE-2020-0001).
# Cada línea de logtest-expected.txt es "<id>:<nivel>".
set -Eeuo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "${here}/../../.." && pwd)"
container="${1:-}"
image="${WAZUH_MANAGER_IMAGE:-wazuh/wazuh-manager:4.14.8}"
output="$(mktemp)"
cleanup() { rm -f "${output}"; [[ -n ${disposable:-} ]] && docker rm -f "${disposable}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [[ -z $container ]]; then
  disposable="qapaq-platform-logtest-$$"
  container="$disposable"
  docker run -d --name "$container" "$image" >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$container" test -S /var/ossec/queue/sockets/logtest 2>/dev/null && break
    sleep 2
  done
  stage="$(mktemp -d)"
  cp "${repo}"/wazuh/provider-ingestion/rules/*.xml "${repo}"/wazuh/aws-events/rules/qapaq_aws_rules.xml \
     "${repo}"/wazuh/platform-monitoring/rules/*.xml "$stage/"
  # Reglas Snyk del equipo de detección (cargan antes, qapaq_soc_*), como en producción.
  for d in "${repo}"/detections/snyk/*/; do
    [[ -f $d/rule.xml ]] && cp "$d/rule.xml" "$stage/qapaq_soc_snyk_$(basename "$d" | tr - _).xml"
  done
  printf 'web/portal.example:portal.example\n' >"$stage/qapaq-internet-facing-projects"
  printf 'CVE-2021-44228:kev\n' >"$stage/qapaq-vuln-kev"
  printf 'CVE-2020-0001:p4\n' >"$stage/qapaq-vuln-noise"
  # Git Bash en Windows: docker.exe necesita la ruta nativa del directorio temporal.
  docker cp "$(cygpath -w "$stage" 2>/dev/null || echo "$stage")/." "$container:/tmp/qapaq-rules"
  rm -rf "$stage"
  docker exec -u 0 "$container" bash -euo pipefail -c '
    O=/var/ossec
    sed -i "s/\r$//" /tmp/qapaq-rules/*
    install -o wazuh -g wazuh -m 0660 /tmp/qapaq-rules/*.xml $O/etc/rules/
    install -o wazuh -g wazuh -m 0660 /tmp/qapaq-rules/qapaq-vuln-kev /tmp/qapaq-rules/qapaq-vuln-noise /tmp/qapaq-rules/qapaq-internet-facing-projects $O/etc/lists/
    sed -i "0,/<ruleset>/s||<ruleset><list>etc/lists/qapaq-internet-facing-projects</list><list>etc/lists/qapaq-vuln-kev</list><list>etc/lists/qapaq-vuln-noise</list>|" $O/etc/ossec.conf
    $O/bin/wazuh-analysisd -t
    $O/bin/wazuh-control restart >/dev/null 2>&1
  '
  for _ in $(seq 1 60); do
    docker exec "$container" test -S /var/ossec/queue/sockets/logtest 2>/dev/null && break
    sleep 2
  done
  sleep 5
fi

docker exec "$container" /var/ossec/bin/wazuh-analysisd -t
docker exec --interactive "$container" /var/ossec/bin/wazuh-logtest <"${here}/logtest-cases.jsonl" >"$output" 2>&1
native() { cygpath -w "$1" 2>/dev/null || echo "$1"; }
"${PYTHON:-python3}" - "$(native "$output")" "$(native "${here}/logtest-expected.txt")" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
blocks = text.split("**Phase 1: Completed pre-decoding.")[1:]
expected = [l.strip() for l in open(sys.argv[2], encoding="utf-8") if l.strip()]
if len(blocks) != len(expected):
    print(text[-3000:])
    sys.exit(f"logtest procesó {len(blocks)} eventos; se esperaban {len(expected)}")
bad = []
for i, (block, want) in enumerate(zip(blocks, expected), 1):
    m = re.search(r"id: '(\d+)'\s+level: '(\d+)'", block)
    got = f"{m.group(1)}:{m.group(2)}" if m else "none"
    if got != want:
        bad.append(f"caso {i:02d}: esperado {want}, obtenido {got}")
if bad:
    print("\n".join(bad)); sys.exit(1)
print(f"{len(expected)}/{len(expected)} casos correctos")
PY
