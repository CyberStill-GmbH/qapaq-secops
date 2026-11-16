#!/usr/bin/env bash
# QAPAQ SOC — política del manager: ossec.conf + reglas QAPAQ (docs/16-politicas.md). Idempotente.
#
#   1. Reglas: comprueba que los IDs QAPAQ no colisionan entre sí ni con lo instalado
#      (check_rule_ids.py) y prepara wazuh/office365/rules + infra/wazuh/*/rules.
#      Incluye las reglas del programa de detección (detections/*/*/rule.xml → qapaq_soc_*.xml).
#      Las listas etc/lists/qapaq-break-glass y qapaq-internet-facing-projects se crean con un
#      centinela .invalid si faltan o están vacías (nunca se pisa una con contenido).
#   2. ossec.conf: render_ossec_policy.py (VD + indexer, umbral de alertas, correo apagado,
#      lista QAPAQ en <ruleset>, bloque QAPAQ:policy con Active Response opt-in).
#   3. Si algo cambió: respaldo en etc/qapaq-backup-<ts>-policy/, instala, valida con
#      wazuh-analysisd/modulesd/remoted/execd -t, reinicia y comprueba los daemons. Si falla,
#      restaura todo el respaldo y reinicia.
#   4. Persistencia: wazuh-docker copia /wazuh-config-mount/etc/ossec.conf sobre etc/ossec.conf en
#      cada arranque. Si ese origen existe y es escribible aquí (EC2:
#      /opt/qapaq/wazuh-docker/single-node/config/wazuh_cluster/wazuh_manager.conf) se le aplica
#      la misma política. QAPAQ_PERSIST_MOUNT=0 lo omite. Reglas y listas viven en el volumen etc.
#
# Variables: QAPAQ_AR_AUTO_BLOCK (0), QAPAQ_AR_TIMEOUT (600), QAPAQ_AR_WHITELIST (""),
#            QAPAQ_LOG_ALERT_LEVEL (3), QAPAQ_VD_FEED_INTERVAL (60m), QAPAQ_PERSIST_MOUNT (auto).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"

M="$(qapaq_manager)"
tmpl="$here/../ossec.qapaq-policy.xml.tmpl"
render="$here/render_ossec_policy.py"
qapaq_log "manager: $M (auto-block=${QAPAQ_AR_AUTO_BLOCK:-0})"

# --- 1. Reglas QAPAQ ---------------------------------------------------------------
mapfile -t rule_files < <(ls "$QAPAQ_REPO_ROOT"/wazuh/office365/rules/*.xml "$QAPAQ_REPO_ROOT"/infra/wazuh/*/rules/*.xml)
stage="$QAPAQ_WORK/stage"; mkdir -p "$stage/rules"
for f in "${rule_files[@]}"; do tr -d '\r' <"$f" >"$stage/rules/$(basename "$f")"; done
# Reglas del programa de detección (docs/17): detections/<fuente>/<caso>/rule.xml → qapaq_soc_<fuente>_<caso>.xml.
for f in "$QAPAQ_REPO_ROOT"/detections/*/*/rule.xml; do
  [[ -f "$f" ]] || continue
  rel="${f#"$QAPAQ_REPO_ROOT"/detections/}"; rel="${rel%/rule.xml}"
  tr -d '\r' <"$f" >"$stage/rules/qapaq_soc_$(tr '/-' '__' <<<"$rel").xml"
done
names="$(cd "$stage/rules" && ls)"
# IDs instalados fuera de los archivos QAPAQ (ruleset oficial y reglas locales de otros dueños).
# shellcheck disable=SC2016
qapaq_mexec bash -c '
  cd /var/ossec
  for f in ruleset/rules/*.xml etc/rules/*.xml; do
    case " $* " in *" $(basename "$f") "*) continue ;; esac
    grep -oE "<rule[^>]* id=\"[0-9]+\"" "$f" | grep -oE "[0-9]+\"$" | tr -d "\"" | sed "s#\$# $f#"
  done' _ $names >"$QAPAQ_WORK/installed-ids.txt"
if ! qapaq_python "$here/check_rule_ids.py" --installed "$QAPAQ_WORK/installed-ids.txt" "$stage"/rules/*.xml \
  >"$QAPAQ_WORK/ids.log"; then
  cat "$QAPAQ_WORK/ids.log" >&2
  qapaq_die 'colisión de IDs de reglas: no se instala nada'
fi
sed 's/^/[qapaq-policy] reglas: /' "$QAPAQ_WORK/ids.log"

# --- 2. ossec.conf ------------------------------------------------------------------
conf="$stage/ossec.conf"
docker cp "$M:/var/ossec/etc/ossec.conf" "$(qapaq_hp "$conf")" >/dev/null
conf_result="$(qapaq_python "$render" "$conf" "$tmpl")"

# --- 3. Instalar con validación y rollback -------------------------------------------
docker exec -u 0 "$M" rm -rf /tmp/qapaq-policy-stage
docker cp "$(qapaq_hp "$stage")" "$M:/tmp/qapaq-policy-stage" >/dev/null
# shellcheck disable=SC2016
qapaq_mexec bash -euo pipefail -c '
  O=/var/ossec; S=/tmp/qapaq-policy-stage; changed=0
  trap "rm -rf $S" EXIT
  same() { [ -f "$2" ] && [ "$(sha256sum <"$1")" = "$(sha256sum <"$2")" ]; }
  for f in $S/rules/*.xml; do same "$f" "$O/etc/rules/$(basename "$f")" || changed=1; done
  [ -s $O/etc/lists/qapaq-break-glass ] || changed=1
  [ -s $O/etc/lists/qapaq-internet-facing-projects ] || changed=1
  [ "$1" = changed ] && changed=1
  if [ $changed = 0 ]; then echo "[qapaq-policy] manager ya cumple la política: sin cambios ni reinicio"; exit 0; fi

  bak=$O/etc/qapaq-backup-$(date -u +%Y%m%dT%H%M%SZ)-policy
  mkdir -p "$bak"; cp -a $O/etc/ossec.conf "$bak/"; cp -a $O/etc/rules "$bak/rules"; cp -a $O/etc/lists "$bak/lists"
  restore() {
    rm -rf $O/etc/rules && cp -a "$bak/rules" $O/etc/rules
    rm -rf $O/etc/lists && cp -a "$bak/lists" $O/etc/lists
    cp -a "$bak/ossec.conf" $O/etc/ossec.conf
    $O/bin/wazuh-control restart >/dev/null 2>&1 || true
  }
  install -o wazuh -g wazuh -m 0660 $S/rules/*.xml $O/etc/rules/
  # Vacía rompe GET /lists de la API («Bad format in CDB list»): centinela que nunca coincide.
  [ -s $O/etc/lists/qapaq-break-glass ] || { echo qapaq-sin-cuentas-break-glass@qapaq.invalid:placeholder >$O/etc/lists/qapaq-break-glass
    chown wazuh:wazuh $O/etc/lists/qapaq-break-glass; chmod 0660 $O/etc/lists/qapaq-break-glass; }
  # Proyectos Snyk expuestos por Cloudflare (detections/snyk/exposed-critical-exploit): mismo centinela.
  [ -s $O/etc/lists/qapaq-internet-facing-projects ] || { echo qapaq-sin-proyectos-expuestos.invalid:placeholder >$O/etc/lists/qapaq-internet-facing-projects
    chown wazuh:wazuh $O/etc/lists/qapaq-internet-facing-projects; chmod 0660 $O/etc/lists/qapaq-internet-facing-projects; }
  install -o root -g wazuh -m 0660 $S/ossec.conf $O/etc/ossec.conf
  for t in wazuh-analysisd wazuh-modulesd wazuh-remoted wazuh-execd; do
    if ! $O/bin/$t -t >/tmp/qapaq-policy-test.log 2>&1; then
      tail -20 /tmp/qapaq-policy-test.log >&2; restore
      echo "configuración inválida ($t -t): restaurado $bak" >&2; exit 1
    fi
  done
  $O/bin/wazuh-control restart >/dev/null 2>&1 || true
  for i in $(seq 1 30); do
    st="$($O/bin/wazuh-control status 2>&1 || true)"
    if echo "$st" | grep -q "wazuh-analysisd is running" && echo "$st" | grep -q "wazuh-modulesd is running"; then
      echo "[qapaq-policy] manager reiniciado con la política (respaldo: $bak)"; exit 0
    fi
    sleep 2
  done
  echo "$st" >&2; restore
  echo "el manager no arrancó con la política: restaurado $bak" >&2; exit 1
' _ "$conf_result"

# --- 4. Persistencia frente a recreación/reinicio del contenedor ------------------------
mount_src="$(docker inspect "$M" --format '{{range .Mounts}}{{if eq .Destination "/wazuh-config-mount/etc/ossec.conf"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)"
if [[ "${QAPAQ_PERSIST_MOUNT:-auto}" == 0 ]]; then
  qapaq_log 'persistencia omitida (QAPAQ_PERSIST_MOUNT=0)'
elif [[ -n "$mount_src" && -f "$mount_src" && -w "$mount_src" ]]; then
  [[ -e "$mount_src.qapaq-orig" ]] || cp -p "$mount_src" "$mount_src.qapaq-orig"
  r="$(qapaq_python "$render" "$mount_src" "$tmpl")"
  qapaq_log "origen montado $mount_src: $r (original en .qapaq-orig)"
else
  qapaq_log "AVISO: el origen montado de ossec.conf no es accesible desde este host (${mount_src:-ninguno}); si el contenedor se reinicia o recrea, reaplicar este script"
fi
