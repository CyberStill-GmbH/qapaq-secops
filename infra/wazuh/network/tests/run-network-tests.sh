#!/usr/bin/env bash
# QAPAQ SOC · pruebas de wazuh-logtest de la visibilidad de red (docs/18).
#
#   bash infra/wazuh/network/tests/run-network-tests.sh                 # manager DESECHABLE (todas las suites)
#   bash infra/wazuh/network/tests/run-network-tests.sh --manager qapaq-wazuh.manager-1
#                                                                       # manager productivo, solo lectura
#   bash infra/wazuh/network/tests/run-network-tests.sh --keep          # deja el desechable para depurar
#
# Desechable: wazuh/wazuh-manager:4.14.8 sin red con TODAS las reglas QAPAQ (catálogo + programa), los
# decoders de red y las listas de ejemplo; wazuh-analysisd -t; luego los fixtures de cada caso de uso con
# tests.runner = network-logtest. La regla 60000 se adapta a JSON igual que en test-in-container.sh para
# leer los fixtures EventChannel (Windows).
# Productivo (--manager): no instala nada; corre con wazuh-logtest (sesión aislada, no genera alertas)
# los casos con tests.manager_safe = true. Las listas de reputación productivas llevan claves canario de
# TEST-NET (203.0.113.211/.212/.221/.231, 192.0.2.) que los fixtures usan: nunca aparecen en tráfico real.
# Sale 1 si algún caso falla. Requiere docker y Python 3 con PyYAML.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
image="${QAPAQ_TEST_IMAGE:-wazuh/wazuh-manager:4.14.8}"
name="${QAPAQ_TEST_CONTAINER:-qapaq-network-test}"
manager="" keep=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --manager) manager="$2"; shift 2 ;;
    --keep) keep=1; shift ;;
    *) echo "opción desconocida: $1" >&2; exit 2 ;;
  esac
done
hp() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
py=""
for p in python3 python; do
  if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import yaml' >/dev/null 2>&1; then py="$(command -v "$p")"; break; fi
done
[[ -n "$py" ]] || { echo "se requiere Python 3 con PyYAML" >&2; exit 1; }
tool=("$py" "$(hp "$repo/detections/tools/qapaq_detections.py")")
work="$(mktemp -d)"
log() { printf '[qapaq-network-tests] %s\n' "$*"; }
cleanup() {
  rm -rf "$work"
  if [[ -z "$manager" && $keep == 0 ]]; then docker rm -f "$name" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

# Casos de uso de red: "dir<TAB>fixtures<TAB>expected<TAB>manager_safe"
"$py" - "$(hp "$repo")" >"$work/cases.tsv" <<'PY'
import sys, yaml, pathlib
root = pathlib.Path(sys.argv[1])
for meta in sorted((root / "detections").glob("*/*/metadata.yaml")):
    m = yaml.safe_load(meta.read_text(encoding="utf-8"))
    t = m.get("tests") or {}
    if t.get("runner") == "network-logtest":
        print(f"{meta.parent.relative_to(root / 'detections').as_posix()}\t{t['fixtures']}\t{t['expected']}\t{str(t.get('manager_safe', False)).lower()}")
PY

if [[ -z "$manager" ]]; then
  docker rm -f "$name" >/dev/null 2>&1 || true
  log "arrancando manager desechable $name ($image, sin red)"
  docker run --detach --name "$name" --network none --ulimit nofile=458752:458752 "$image" >/dev/null
  "${tool[@]}" bundle "$(hp "$work/bundle")" --existing all --example-lists >/dev/null
  for f in "$work"/bundle/existing/*.xml "$work"/bundle/rules/*.xml; do
    docker cp "$(hp "$f")" "$name:/var/ossec/etc/rules/$(basename "$f")"
  done
  for f in "$work"/bundle/lists/*; do docker cp "$(hp "$f")" "$name:/var/ossec/etc/lists/$(basename "$f")"; done
  docker cp "$(hp "$repo/infra/wazuh/network/decoders/qapaq_network_decoders.xml")" "$name:/var/ossec/etc/decoders/qapaq_network_decoders.xml"
  docker cp "$name:/var/ossec/ruleset/decoders/0040-auditd_decoders.xml" "$(hp "$work/0040-auditd_decoders.xml")"
  "$py" "$(hp "$repo/infra/wazuh/network/decoders/build_auditd_override.py")" "$(hp "$work/0040-auditd_decoders.xml")" "$(hp "$work/qapaq_auditd_decoders.xml")" >/dev/null
  docker cp "$(hp "$work/qapaq_auditd_decoders.xml")" "$name:/var/ossec/etc/decoders/qapaq_auditd_decoders.xml"
  docker exec -u 0 "$name" sh -c '
    chown wazuh:wazuh /var/ossec/etc/rules/*.xml /var/ossec/etc/decoders/*.xml /var/ossec/etc/lists/qapaq-*
    chmod 660 /var/ossec/etc/rules/*.xml /var/ossec/etc/decoders/*.xml
    for l in /var/ossec/etc/lists/qapaq-*; do
      case "$l" in *.cdb) continue ;; esac
      n="etc/lists/$(basename "$l")"
      grep -q "<list>$n</list>" /var/ossec/etc/ossec.conf || sed -i "0,/<\/ruleset>/s##  <list>$n</list>\n  </ruleset>#" /var/ossec/etc/ossec.conf
    done
    grep -q "<decoder_exclude>ruleset/decoders/0040-auditd_decoders.xml" /var/ossec/etc/ossec.conf || sed -i "0,/<\/ruleset>/s##  <decoder_exclude>ruleset/decoders/0040-auditd_decoders.xml</decoder_exclude>\n  </ruleset>#" /var/ossec/etc/ossec.conf
    sed -i -e "/<category>ossec<\/category>/d" -e "s|<decoded_as>windows_eventchannel</decoded_as>|<decoded_as>json</decoded_as>|" /var/ossec/ruleset/rules/0575-win-base_rules.xml'
  sleep 15
  docker exec "$name" /var/ossec/bin/wazuh-control restart >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do
    docker exec "$name" /var/ossec/bin/wazuh-control status 2>/dev/null | grep -q 'wazuh-analysisd is running' && break
    sleep 2
  done
  log 'wazuh-analysisd -t'
  docker exec "$name" /var/ossec/bin/wazuh-analysisd -t
  target="$name"
else
  target="$manager"
  log "manager productivo $target: solo wazuh-logtest (sin instalar ni reiniciar nada)"
fi

failures=0 ran=0
while IFS=$'\t' read -r uc fixtures expected safe; do
  if [[ -n "$manager" && "$safe" != true ]]; then log "omitido en productivo: $uc (solo desechable)"; continue; fi
  out="$work/out-$RANDOM.txt"
  tr -d '\r' <"$repo/$fixtures" | docker exec -i "$target" /var/ossec/bin/wazuh-logtest >"$out" 2>&1 || true
  ran=$((ran + 1))
  if ! "${tool[@]}" check-logtest "$(hp "$out")" "$(hp "$repo/$expected")" >"$work/check.txt"; then
    failures=$((failures + 1))
  fi
  sed "s#\[$(basename "$(dirname "$repo/$expected")")\]#[$uc]#" "$work/check.txt"
done <"$work/cases.tsv"

if [[ $failures -gt 0 ]]; then log "FALLÓ: $failures de $ran suite(s)"; exit 1; fi
log "$ran suite(s) de red pasan en $target"
