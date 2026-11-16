#!/usr/bin/env bash
# QAPAQ SOC · despliegue de la visibilidad de red en el manager (docs/18-visibilidad-de-red-y-capacidades-wazuh.md).
#
# Corre EN el host de los contenedores (EC2 PowerUser), como root, desde una copia del repo:
#   sudo bash infra/wazuh/network/deploy-network.sh manager   # decoders, reglas de red, listas, <localfile> del edge
#   sudo bash infra/wazuh/network/deploy-network.sh lists     # solo refresca las listas de reputación (timer diario)
#   sudo bash infra/wazuh/network/deploy-network.sh check     # muestra qué cambiaría, sin aplicar
#
# Instala en el manager:
#   - etc/decoders/qapaq_network_decoders.xml
#   - las reglas de los casos de uso con owner network-visibility (detections/<fuente>/<caso>/rule.xml →
#     etc/rules/qapaq_soc_<fuente>_<caso>.xml, mismo nombre que usa deploy-detections.sh)
#   - listas: qapaq-expected-listeners (versionada), qapaq-ti-blocklist, qapaq-ti-tor, qapaq-egress-known (fuentes
#     públicas, qapaq_threat_intel.py) y qapaq-cf-waf-attackers (consulta al indexer), con claves canario TEST-NET
#     para las pruebas de wazuh-logtest en productivo; y su <list> en <ruleset>
#   - <localfile> json del edge (qapaq-collectors/edge/access.json) y syslog del error.log, entre marcadores
# Seguridad: check_rule_ids.py contra lo instalado, respaldo en etc/qapaq-backup-<ts>-network/, wazuh-analysisd -t
# antes de reiniciar, verificación de analysisd/remoted y del agente 001 después; cualquier fallo restaura el
# respaldo y reinicia. Solo reinicia si algo cambió. Persiste el ossec.conf en el montaje del host.
# No usar deploy-host.sh ni ship.sh para esto.
set -Eeuo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
# shellcheck source=../../../wazuh/manager/policy/lib.sh
source "$repo/wazuh/manager/policy/lib.sh"
M="$(qapaq_manager)"
mode="${1:-manager}"
agent_id="${QAPAQ_VERIFY_AGENT:-001}"
cache="${QAPAQ_TI_CACHE:-/var/lib/qapaq-threat-intel}"
log() { printf '[qapaq-network] %s\n' "$*"; }
case "$mode" in manager | lists | check) ;; *) qapaq_die "uso: $0 manager|lists|check" ;; esac

stage="$QAPAQ_WORK/stage"
mkdir -p "$stage/rules" "$stage/decoders" "$stage/lists"

# ---------------------------------------------------------------- listas
qapaq_python "$here/threat-intel/qapaq_threat_intel.py" fetch --out "$stage/lists" --cache "$cache" \
  --egress-static "$here/lists/qapaq-egress-static" ${QAPAQ_TI_FIREHOL:+--firehol} >&2
# IPs del WAF de Cloudflare (bloqueo/desafío) con 5+ eventos en 7 días.
cat >"$QAPAQ_WORK/cf-query.json" <<'JSON'
{"size":0,"query":{"bool":{"filter":[{"terms":{"rule.id":["101510","101513","101740","101741","101742"]}},
 {"range":{"timestamp":{"gte":"now-7d"}}}]}},
 "aggs":{"ips":{"terms":{"field":"data.cloudflare.firewall.client_ip","size":5000,"min_doc_count":5}}}}
JSON
qapaq_indexer POST '/wazuh-alerts-*/_search' "$QAPAQ_WORK/cf-query.json"
if [[ "$INDEXER_STATUS" == 200 ]]; then
  qapaq_python "$here/threat-intel/qapaq_threat_intel.py" cloudflare --in "$INDEXER_BODY" --out "$stage/lists/qapaq-cf-waf-attackers" >&2
else
  log "AVISO: consulta de Cloudflare al indexer devolvió $INDEXER_STATUS; se conserva la lista instalada"
  qapaq_mexec cat /var/ossec/etc/lists/qapaq-cf-waf-attackers >"$stage/lists/qapaq-cf-waf-attackers" 2>/dev/null ||
    echo 'qapaq-sin-datos-qapaq-cf-waf-attackers.invalid:placeholder' >"$stage/lists/qapaq-cf-waf-attackers"
fi
# Canarios TEST-NET (RFC 5737): nunca aparecen en tráfico real; los usan los fixtures en productivo.
{
  echo '203.0.113.211:qapaq-canario-prueba'
  echo '203.0.113.212:qapaq-canario-prueba'
} >>"$stage/lists/qapaq-ti-blocklist"
echo '203.0.113.221:qapaq-canario-prueba' >>"$stage/lists/qapaq-ti-tor"
echo '203.0.113.231:qapaq-canario-prueba' >>"$stage/lists/qapaq-cf-waf-attackers"
echo '192.0.2.:qapaq-canario-prueba' >>"$stage/lists/qapaq-egress-known"
sed -i '/^qapaq-sin-datos-.*\.invalid:placeholder$/d' "$stage"/lists/qapaq-*
tr -d '\r' <"$here/lists/qapaq-expected-listeners" >"$stage/lists/qapaq-expected-listeners"
lists="qapaq-ti-blocklist qapaq-ti-tor qapaq-cf-waf-attackers qapaq-egress-known qapaq-expected-listeners"

# ---------------------------------------------------------------- reglas y decoders
if [[ "$mode" != lists ]]; then
  tr -d '\r' <"$here/decoders/qapaq_network_decoders.xml" >"$stage/decoders/qapaq_network_decoders.xml"
  # Copia del 0040 oficial del manager con el hermano QAPAQ de auditd-syscall (IP del SOCKADDR) y exclusión
  # del original: los hermanos solo se encadenan dentro del mismo archivo (build_auditd_override.py).
  docker cp "$M:/var/ossec/ruleset/decoders/0040-auditd_decoders.xml" "$(qapaq_hp "$QAPAQ_WORK/0040-auditd_decoders.xml")"
  qapaq_python "$here/decoders/build_auditd_override.py" "$QAPAQ_WORK/0040-auditd_decoders.xml" \
    "$stage/decoders/qapaq_auditd_decoders.xml" >&2
  qapaq_python - "$repo" >"$QAPAQ_WORK/rules.tsv" <<'PY'
import sys, yaml, pathlib
root = pathlib.Path(sys.argv[1])
for meta in sorted((root / "detections").glob("*/*/metadata.yaml")):
    m = yaml.safe_load(meta.read_text(encoding="utf-8"))
    if m.get("owner") == "network-visibility" and (meta.parent / "rule.xml").exists():
        rel = meta.parent.relative_to(root / "detections")
        print(f"{(meta.parent / 'rule.xml').as_posix()}\tqapaq_soc_{'_'.join(p.replace('-', '_') for p in rel.parts)}.xml")
PY
  while IFS=$'\t' read -r src name; do tr -d '\r' <"$src" >"$stage/rules/$name"; done <"$QAPAQ_WORK/rules.tsv"
  names="$(cd "$stage/rules" && ls)"
  log "reglas de red: $(echo "$names" | wc -l) archivos"
  # shellcheck disable=SC2016
  qapaq_mexec bash -c '
    cd /var/ossec
    for f in ruleset/rules/*.xml etc/rules/*.xml; do
      case " $* " in *" $(basename "$f") "*) continue ;; esac
      grep -oE "<rule[^>]* id=\"[0-9]+\"" "$f" | grep -oE "[0-9]+\"$" | tr -d "\"" | sed "s#\$# $f#"
    done' _ $names >"$QAPAQ_WORK/installed-ids.txt"
  if ! qapaq_python "$repo/wazuh/manager/policy/check_rule_ids.py" --installed "$QAPAQ_WORK/installed-ids.txt" \
    "$stage"/rules/*.xml >"$QAPAQ_WORK/ids.log"; then
    cat "$QAPAQ_WORK/ids.log" >&2
    qapaq_die 'colisión de IDs de reglas: no se instala nada'
  fi
  tail -n 1 "$QAPAQ_WORK/ids.log" | sed 's/^/[qapaq-network] ids: /'
fi

# ---------------------------------------------------------------- bloque <localfile> del edge
BEGIN='<!-- QAPAQ:edge-logs:begin (infra/wazuh/network/deploy-network.sh) -->'
END='<!-- QAPAQ:edge-logs:end -->'
cat >"$stage/edge-localfile.xml" <<XML
$BEGIN
<ossec_config>
  <!-- Edge nginx de la consola del SOC (docs/18): JSON con la IP real del cliente. -->
  <localfile>
    <log_format>json</log_format>
    <location>/var/ossec/logs/qapaq-collectors/edge/access.json</location>
    <label key="qapaq.source">edge-nginx</label>
  </localfile>
  <localfile>
    <log_format>syslog</log_format>
    <location>/var/ossec/logs/qapaq-collectors/edge/error.log</location>
  </localfile>
</ossec_config>
$END
XML

docker exec -u 0 "$M" rm -rf /tmp/qapaq-network-stage
docker cp "$(qapaq_hp "$stage")" "$M:/tmp/qapaq-network-stage" >/dev/null
# shellcheck disable=SC2016
qapaq_mexec bash -euo pipefail -c '
  O=/var/ossec; S=/tmp/qapaq-network-stage; mode="$1"; agent="$2"; shift 2; lists="$*"; changed=0
  trap "rm -rf $S" EXIT
  same() { [ -f "$2" ] && [ "$(sha256sum <"$1")" = "$(sha256sum <"$2")" ]; }
  if [ "$mode" != lists ]; then
    for f in $S/rules/*.xml; do same "$f" "$O/etc/rules/$(basename "$f")" || { echo "[qapaq-network] cambia: etc/rules/$(basename "$f")"; changed=1; }; done
    for f in $S/decoders/*.xml; do same "$f" "$O/etc/decoders/$(basename "$f")" || { echo "[qapaq-network] cambia: etc/decoders/$(basename "$f")"; changed=1; }; done
    grep -q "<decoder_exclude>ruleset/decoders/0040-auditd_decoders.xml</decoder_exclude>" $O/etc/ossec.conf || { echo "[qapaq-network] falta <decoder_exclude> de 0040-auditd"; changed=1; }
    grep -qF "QAPAQ:edge-logs:begin" $O/etc/ossec.conf || { echo "[qapaq-network] falta el <localfile> del edge"; changed=1; }
  fi
  for l in $lists; do
    same "$S/lists/$l" "$O/etc/lists/$l" || { echo "[qapaq-network] cambia: etc/lists/$l ($(wc -l <"$S/lists/$l") claves)"; changed=1; }
    grep -q "<list>etc/lists/$l</list>" $O/etc/ossec.conf || { echo "[qapaq-network] falta <list>etc/lists/$l</list>"; changed=1; }
  done
  if [ $changed = 0 ]; then echo "[qapaq-network] sin cambios: no se reinicia"; exit 0; fi
  if [ "$mode" = check ]; then echo "[qapaq-network] check: no se aplica nada"; exit 0; fi

  bak=$O/etc/qapaq-backup-$(date -u +%Y%m%dT%H%M%SZ)-network
  mkdir -p "$bak"; cp -a $O/etc/ossec.conf "$bak/"; cp -a $O/etc/rules "$bak/rules"; cp -a $O/etc/lists "$bak/lists"; cp -a $O/etc/decoders "$bak/decoders"
  echo "[qapaq-network] respaldo: $bak"
  restore() {
    for d in rules lists decoders; do rm -rf $O/etc/$d && cp -a "$bak/$d" $O/etc/$d; done
    cp -a "$bak/ossec.conf" $O/etc/ossec.conf
    $O/bin/wazuh-control restart >/dev/null 2>&1 || true
  }
  if [ "$mode" != lists ]; then
    install -o wazuh -g wazuh -m 0660 $S/rules/*.xml $O/etc/rules/
    install -o wazuh -g wazuh -m 0660 $S/decoders/*.xml $O/etc/decoders/
    grep -q "<decoder_exclude>ruleset/decoders/0040-auditd_decoders.xml</decoder_exclude>" $O/etc/ossec.conf ||
      sed -i "0,/<\/ruleset>/s##  <decoder_exclude>ruleset/decoders/0040-auditd_decoders.xml</decoder_exclude>\n  </ruleset>#" $O/etc/ossec.conf
    mkdir -p $O/logs/qapaq-collectors/edge && chown wazuh:wazuh $O/logs/qapaq-collectors/edge
    touch $O/logs/qapaq-collectors/edge/access.json $O/logs/qapaq-collectors/edge/error.log
    if ! grep -qF "QAPAQ:edge-logs:begin" $O/etc/ossec.conf; then
      { echo; cat $S/edge-localfile.xml; } >>$O/etc/ossec.conf
    fi
  fi
  for l in $lists; do
    install -o wazuh -g wazuh -m 0660 "$S/lists/$l" "$O/etc/lists/$l"
    grep -q "<list>etc/lists/$l</list>" $O/etc/ossec.conf || sed -i "0,/<\/ruleset>/s##  <list>etc/lists/$l</list>\n  </ruleset>#" $O/etc/ossec.conf
  done
  if ! $O/bin/wazuh-analysisd -t >/tmp/qapaq-network-test.log 2>&1; then
    tail -20 /tmp/qapaq-network-test.log >&2; restore
    echo "[qapaq-network] analysisd -t falló: restaurado $bak" >&2; exit 1
  fi
  echo "[qapaq-network] analysisd -t OK"
  $O/bin/wazuh-control restart >/dev/null 2>&1 || true
  for i in $(seq 1 45); do
    st="$($O/bin/wazuh-control status 2>&1 || true)"
    if echo "$st" | grep -q "wazuh-analysisd is running" && echo "$st" | grep -q "wazuh-remoted is running"; then
      for j in $(seq 1 30); do
        if $O/bin/agent_control -i "$agent" 2>/dev/null | grep -q "Status:.*Active"; then
          echo "[qapaq-network] manager reiniciado; agente $agent activo"; exit 0
        fi
        sleep 4
      done
      echo "[qapaq-network] el agente $agent no volvió a Active: restaurando" >&2; restore; exit 1
    fi
    sleep 2
  done
  echo "$st" >&2; restore
  echo "[qapaq-network] el manager no arrancó: restaurado $bak" >&2; exit 1
' _ "$mode" "$agent_id" $lists

# ---------------------------------------------------------------- persistencia del ossec.conf
[[ "$mode" == check ]] && exit 0
mount_src="$(docker inspect "$M" --format '{{range .Mounts}}{{if eq .Destination "/wazuh-config-mount/etc/ossec.conf"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)"
if [[ -n "$mount_src" && -f "$mount_src" && -w "$mount_src" ]]; then
  [[ -e "$mount_src.qapaq-orig" ]] || cp -p "$mount_src" "$mount_src.qapaq-orig"
  for l in $lists; do
    grep -q "<list>etc/lists/$l</list>" "$mount_src" || sed -i "0,/<\/ruleset>/s##  <list>etc/lists/$l</list>\n  </ruleset>#" "$mount_src"
  done
  if [[ "$mode" == manager ]] && ! grep -q '<decoder_exclude>ruleset/decoders/0040-auditd_decoders.xml' "$mount_src"; then
    sed -i "0,/<\/ruleset>/s##  <decoder_exclude>ruleset/decoders/0040-auditd_decoders.xml</decoder_exclude>\n  </ruleset>#" "$mount_src"
  fi
  if [[ "$mode" == manager ]] && ! grep -qF 'QAPAQ:edge-logs:begin' "$mount_src"; then
    { echo; cat "$stage/edge-localfile.xml"; } >>"$mount_src"
  fi
  log "ossec.conf persistido en el montaje del host ($mount_src)"
else
  log "AVISO: ossec.conf montado no accesible (${mount_src:-ninguno}); si se recrea el contenedor, reaplicar"
fi
