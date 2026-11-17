#!/usr/bin/env bash
# QAPAQ SecOps · pruebas de detección como código en un manager Wazuh DESECHABLE (docs/17).
#
#   bash detections/tools/test-in-container.sh                  # arranca wazuh/wazuh-manager:4.14.8 sin red
#   bash detections/tools/test-in-container.sh --keep           # deja el contenedor para depurar
#   QAPAQ_TEST_IMAGE=wazuh/wazuh-manager:4.14.8 bash detections/tools/test-in-container.sh
#
# Qué hace (igual en CI y en el host AWS; NUNCA toca el manager productivo):
#   1. Arranca un manager aislado (--network none) e instala TODAS las reglas QAPAQ: los archivos canónicos
#      del catálogo (O365, AD, endpoint, lanzamiento, collectors y, si existen, AWS y servicio de
#      proveedores) más las reglas del programa (qapaq_soc_*.xml) y las listas CDB de ejemplo.
#   2. wazuh-analysisd -t (sintaxis, dependencias if_sid y listas).
#   3. Corre con wazuh-logtest los fixtures de cada suite existente (aplicando los refinamientos
#      declarados en detections/catalog.yaml) y de cada caso de uso nuevo del programa.
# Sale 1 si algo falla. Requiere docker y Python 3 con PyYAML.
set -Eeuo pipefail
# Solo contenido versionado en git: el trabajo en curso de otros agentes en detections/ no se prueba ni se instala.
export QAPAQ_DETECTIONS_TRACKED_ONLY="${QAPAQ_DETECTIONS_TRACKED_ONLY:-1}"
export MSYS_NO_PATHCONV=1
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
image="${QAPAQ_TEST_IMAGE:-wazuh/wazuh-manager:4.14.8}"
name="${QAPAQ_TEST_CONTAINER:-qapaq-detections-test}"
keep=0
[[ "${1:-}" == "--keep" ]] && keep=1
# Ruta del host que entienden docker y Python también desde Git Bash en Windows.
hp() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
py=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import yaml' >/dev/null 2>&1; then py="$candidate"; break; fi
done
[[ -n "$py" ]] || { echo 'Se requiere Python 3 con PyYAML' >&2; exit 1; }
export PYTHONIOENCODING=utf-8
tool=("$py" "$(hp "$repo")/detections/tools/qapaq_detections.py")
work="$(mktemp -d)"
cleanup() {
  rm -rf "$work"
  if [[ $keep == 0 ]]; then docker rm -f "$name" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

log() { printf '[qapaq-detections] %s\n' "$*"; }

docker rm -f "$name" >/dev/null 2>&1 || true
log "arrancando manager desechable $name ($image, sin red)"
docker run --detach --name "$name" --network none --ulimit nofile=458752:458752 "$image" >/dev/null

"${tool[@]}" bundle "$(hp "$work/bundle")" --existing all --example-lists >/dev/null
for f in "$work"/bundle/existing/*.xml "$work"/bundle/rules/*.xml; do
  docker cp "$(hp "$f")" "$name:/var/ossec/etc/rules/$(basename "$f")"
done
for f in "$work"/bundle/lists/*; do
  docker cp "$(hp "$f")" "$name:/var/ossec/etc/lists/$(basename "$f")"
done
docker exec -u 0 "$name" sh -c '
  chown wazuh:wazuh /var/ossec/etc/rules/*.xml /var/ossec/etc/lists/qapaq-* && chmod 660 /var/ossec/etc/rules/*.xml
  for l in /var/ossec/etc/lists/qapaq-*; do
    n="etc/lists/$(basename "$l")"
    grep -q "<list>$n</list>" /var/ossec/etc/ossec.conf || sed -i "0,/<\/ruleset>/s##  <list>$n</list>\n  </ruleset>#" /var/ossec/etc/ossec.conf
  done'

# Igual que .github/workflows/wazuh-active-directory-detection.yml: en el contenedor DESECHABLE la regla
# base 60000 lee los fixtures EventChannel como JSON (wazuh-logtest no fija location EventChannel).
docker exec -u 0 "$name" sed -i -e '/<category>ossec<\/category>/d'   -e 's|<decoded_as>windows_eventchannel</decoded_as>|<decoded_as>json</decoded_as>|'   /var/ossec/ruleset/rules/0575-win-base_rules.xml
# La imagen arranca el manager sola: se espera a que termine el arranque y se reinicia con las reglas QAPAQ.
sleep 15
docker exec "$name" /var/ossec/bin/wazuh-control restart >/dev/null 2>&1 || true
ready=0
for _ in $(seq 1 60); do
  st="$(docker exec "$name" /var/ossec/bin/wazuh-control status 2>/dev/null || true)"
  if grep -q 'wazuh-analysisd is running' <<<"$st"; then ready=1; break; fi
  sleep 2
done
[[ $ready == 1 ]] || { docker exec "$name" tail -n 40 /var/ossec/logs/ossec.log; log 'analysisd no arrancó'; exit 1; }

log 'wazuh-analysisd -t'
docker exec "$name" /var/ossec/bin/wazuh-analysisd -t
log "reglas QAPAQ cargadas: $(docker exec "$name" sh -c 'cat /var/ossec/etc/rules/qapaq_*.xml | grep -c "<rule id="')"

failures=0
run_suite() { # run_suite <etiqueta> <fixtures> <expected> [suite]
  local label="$1" fixtures="$repo/$2" expected="$repo/$3" suite="${4:-}" out="$work/out-$RANDOM.txt"
  tr -d '\r' <"$fixtures" | docker exec -i "$name" /var/ossec/bin/wazuh-logtest >"$out" 2>&1 || true
  if ! "${tool[@]}" check-logtest "$(hp "$out")" "$(hp "$expected")" ${suite:+--suite "$suite"}; then failures=$((failures + 1)); fi
}

log 'suites existentes (archivos canónicos; refinamientos de catalog.yaml)'
while IFS=$'\t' read -r suite fixtures expected; do
  expected="${expected%$'\r'}"
  [[ -f "$repo/$fixtures" && -f "$repo/$expected" ]] || { log "omitida $suite (sin fixtures)"; continue; }
  run_suite "$suite" "$fixtures" "$expected" "$suite"
done < <("$py" - "$(hp "$repo")" <<'PY'
import sys, yaml, pathlib
cat = yaml.safe_load((pathlib.Path(sys.argv[1]) / "detections/catalog.yaml").read_text(encoding="utf-8"))
seen = set()
for e in cat["rule_files"]:
    s = e.get("suite") or {}
    if s.get("fixtures") and s.get("expected") and s["name"] not in seen:
        seen.add(s["name"])
        print(f"{s['name']}\t{s['fixtures']}\t{s['expected']}")
PY
)

log 'casos de uso del programa (detections/<fuente>/<caso>)'
while IFS=$'\t' read -r uc fixtures expected _suite; do
  expected="${expected%$'\r'}"
  [[ "$fixtures" == detections/* ]] || continue
  run_suite "$uc" "$fixtures" "$expected"
done < <("${tool[@]}" cases)

if [[ $failures -gt 0 ]]; then log "FALLÓ: $failures suite(s) con errores"; exit 1; fi
log 'todas las suites pasan'
