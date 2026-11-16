#!/usr/bin/env bash
# QAPAQ SOC · despliegue de las reglas del programa de detección en el manager (docs/17 §despliegue).
#
# Corre EN el host de los contenedores (EC2 PowerUser), como root, desde una copia del repo:
#   sudo bash detections/tools/deploy-detections.sh            # instala, valida, reinicia y verifica
#   sudo bash detections/tools/deploy-detections.sh --check    # solo muestra qué cambiaría
#
# Instala:
#   - reglas del programa: detections/<fuente>/<caso>/rule.xml → etc/rules/qapaq_soc_<fuente>_<caso>.xml
#   - archivos QAPAQ del SOC con descripciones normalizadas (owner soc-detection-engineering en catalog.yaml)
#   - listas versionadas de detections/lists (allowlists de reducción de FP), si cambian
#   - listas CDB de entorno que falten (con un centinela .invalid; nunca pisa una con contenido)
#     y su <list> en <ruleset>
# Seguridad: check_rule_ids.py contra lo instalado, respaldo en etc/qapaq-backup-<ts>-detections/,
# wazuh-analysisd -t antes de reiniciar, verificación de analysisd/remoted y del agente 001 después;
# cualquier fallo restaura el respaldo y reinicia. No toca integraciones, collectors ni el paquete AWS.
# Persistencia: aplica la misma <list> al ossec.conf montado de wazuh-docker si es escribible.
# No usar deploy-host.sh ni ship.sh para esto.
set -Eeuo pipefail
# En el host no hay checkout git: se instala lo que trae la copia (armarla con git ls-files). 1 = solo lo versionado.
export QAPAQ_DETECTIONS_TRACKED_ONLY="${QAPAQ_DETECTIONS_TRACKED_ONLY:-0}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source=../../wazuh/manager/policy/lib.sh
source "$repo/wazuh/manager/policy/lib.sh"
M="$(qapaq_manager)"
check_only=0
[[ "${1:-}" == "--check" ]] && check_only=1
agent_id="${QAPAQ_VERIFY_AGENT:-001}"
log() { printf '[qapaq-detections] %s\n' "$*"; }

stage="$QAPAQ_WORK/stage"
qapaq_python "$repo/detections/tools/qapaq_detections.py" bundle "$stage" --existing soc --managed-lists >/dev/null
mkdir -p "$stage/install/lists"
cp "$stage"/rules/*.xml "$stage"/existing/*.xml "$stage/install/"
cp "$stage"/managed-lists/* "$stage/install/lists/"
names="$(cd "$stage/install" && ls *.xml)"
log "manager: $M · archivos: $(echo "$names" | wc -l)"

# Colisiones contra lo instalado fuera de estos archivos (ruleset oficial y reglas de otros owners).
# shellcheck disable=SC2016
qapaq_mexec bash -c '
  cd /var/ossec
  for f in ruleset/rules/*.xml etc/rules/*.xml; do
    case " $* " in *" $(basename "$f") "*) continue ;; esac
    grep -oE "<rule[^>]* id=\"[0-9]+\"" "$f" | grep -oE "[0-9]+\"$" | tr -d "\"" | sed "s#\$# $f#"
  done' _ $names >"$QAPAQ_WORK/installed-ids.txt"
if ! qapaq_python "$repo/wazuh/manager/policy/check_rule_ids.py" --installed "$QAPAQ_WORK/installed-ids.txt" \
  "$stage"/install/*.xml >"$QAPAQ_WORK/ids.log"; then
  cat "$QAPAQ_WORK/ids.log" >&2
  qapaq_die 'colisión de IDs de reglas: no se instala nada'
fi
sed 's/^/[qapaq-detections] ids: /' "$QAPAQ_WORK/ids.log" | tail -n 3

lists="$(qapaq_python - "$repo/detections/catalog.yaml" <<'PY'
import sys, yaml
print(" ".join(l["path"] for l in yaml.safe_load(open(sys.argv[1], encoding="utf-8"))["lists"]))
PY
)"

docker exec -u 0 "$M" rm -rf /tmp/qapaq-detections-stage
docker cp "$(qapaq_hp "$stage/install")" "$M:/tmp/qapaq-detections-stage" >/dev/null
# shellcheck disable=SC2016
qapaq_mexec bash -euo pipefail -c '
  O=/var/ossec; S=/tmp/qapaq-detections-stage; check="$1"; agent="$2"; shift 2; lists="$*"; changed=0
  trap "rm -rf $S" EXIT
  same() { [ -f "$2" ] && [ "$(sha256sum <"$1")" = "$(sha256sum <"$2")" ]; }
  for f in $S/*.xml; do
    if ! same "$f" "$O/etc/rules/$(basename "$f")"; then echo "[qapaq-detections] cambia: etc/rules/$(basename "$f")"; changed=1; fi
  done
  for f in $S/lists/*; do
    if ! same "$f" "$O/etc/lists/$(basename "$f")"; then echo "[qapaq-detections] cambia lista versionada: etc/lists/$(basename "$f")"; changed=1; fi
  done
  for l in $lists; do
    [ -s "$O/$l" ] || { echo "[qapaq-detections] falta lista: $l (se crea con centinela .invalid)"; changed=1; }
    grep -q "<list>$l</list>" $O/etc/ossec.conf || { echo "[qapaq-detections] falta <list>$l</list> en ossec.conf"; changed=1; }
  done
  if [ $changed = 0 ]; then echo "[qapaq-detections] el manager ya tiene estas reglas: sin cambios ni reinicio"; exit 0; fi
  if [ "$check" = 1 ]; then echo "[qapaq-detections] --check: no se aplica nada"; exit 0; fi

  bak=$O/etc/qapaq-backup-$(date -u +%Y%m%dT%H%M%SZ)-detections
  mkdir -p "$bak"; cp -a $O/etc/ossec.conf "$bak/"; cp -a $O/etc/rules "$bak/rules"; cp -a $O/etc/lists "$bak/lists"
  echo "[qapaq-detections] respaldo: $bak"
  restore() {
    rm -rf $O/etc/rules && cp -a "$bak/rules" $O/etc/rules
    rm -rf $O/etc/lists && cp -a "$bak/lists" $O/etc/lists
    cp -a "$bak/ossec.conf" $O/etc/ossec.conf
    $O/bin/wazuh-control restart >/dev/null 2>&1 || true
  }
  install -o wazuh -g wazuh -m 0660 $S/*.xml $O/etc/rules/
  # Listas versionadas (detections/lists): el repo es la fuente de verdad.
  for f in $S/lists/*; do same "$f" "$O/etc/lists/$(basename "$f")" || install -o wazuh -g wazuh -m 0660 "$f" $O/etc/lists/; done
  for l in $lists; do
    # Vacía rompe GET /lists de la API («Bad format in CDB list»): centinela que nunca coincide.
    [ -s "$O/$l" ] || { echo "qapaq-sin-datos-$(basename "$l").invalid:placeholder" >"$O/$l"; chown wazuh:wazuh "$O/$l"; chmod 0660 "$O/$l"; }
    grep -q "<list>$l</list>" $O/etc/ossec.conf || sed -i "0,/<\/ruleset>/s##  <list>$l</list>\n  </ruleset>#" $O/etc/ossec.conf
  done
  if ! $O/bin/wazuh-analysisd -t >/tmp/qapaq-detections-test.log 2>&1; then
    tail -20 /tmp/qapaq-detections-test.log >&2; restore
    echo "[qapaq-detections] analysisd -t falló: restaurado $bak" >&2; exit 1
  fi
  echo "[qapaq-detections] analysisd -t OK"
  $O/bin/wazuh-control restart >/dev/null 2>&1 || true
  for i in $(seq 1 45); do
    st="$($O/bin/wazuh-control status 2>&1 || true)"
    if echo "$st" | grep -q "wazuh-analysisd is running" && echo "$st" | grep -q "wazuh-remoted is running"; then
      for j in $(seq 1 30); do
        if $O/bin/agent_control -i "$agent" 2>/dev/null | grep -q "Status:.*Active"; then
          echo "[qapaq-detections] manager reiniciado; agente $agent activo"; exit 0
        fi
        sleep 4
      done
      echo "[qapaq-detections] el agente $agent no volvió a Active: restaurando" >&2; restore; exit 1
    fi
    sleep 2
  done
  echo "$st" >&2; restore
  echo "[qapaq-detections] el manager no arrancó: restaurado $bak" >&2; exit 1
' _ "$check_only" "$agent_id" $lists

# Persistencia: wazuh-docker copia el ossec.conf montado en cada arranque del contenedor.
[[ $check_only == 1 ]] && exit 0
mount_src="$(docker inspect "$M" --format '{{range .Mounts}}{{if eq .Destination "/wazuh-config-mount/etc/ossec.conf"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)"
if [[ -n "$mount_src" && -f "$mount_src" && -w "$mount_src" ]]; then
  for l in $lists; do
    if ! grep -q "<list>$l</list>" "$mount_src"; then
      [[ -e "$mount_src.qapaq-orig" ]] || cp -p "$mount_src" "$mount_src.qapaq-orig"
      sed -i "0,/<\/ruleset>/s##  <list>$l</list>\n  </ruleset>#" "$mount_src"
      log "origen montado $mount_src: agregado <list>$l</list>"
    fi
  done
else
  log "AVISO: ossec.conf montado no accesible (${mount_src:-ninguno}); si se recrea el contenedor, reaplicar"
fi
