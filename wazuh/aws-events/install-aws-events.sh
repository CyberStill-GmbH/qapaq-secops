#!/usr/bin/env bash
# QAPAQ SOC — instala en el manager Wazuh (nodo AWS PowerUser) la parte Wazuh del monitoreo de la
# cuenta AWS (EventBridge → SNS → receptor aws-events → JSONL):
#
#   sudo bash wazuh/aws-events/install-aws-events.sh
#
#   1. Crea <volumen de logs del manager>/qapaq-collectors/aws (uid 1000 = usuario del receptor) y el
#      JSONL vacío ANTES de reiniciar (si no existe al arrancar, logcollector lo abre desde el final).
#   2. Instala reglas 101600-101699 y un bloque <localfile> entre marcadores QAPAQ:aws-events en el
#      ossec.conf del contenedor; valida con wazuh-analysisd -t (revierte si falla); persiste el
#      ossec.conf en el montaje del host; reinicia SOLO el manager (QAPAQ_RESTART=false lo omite).
# Idempotente. No toca otros servicios ni bloques (QAPAQ:collectors, office365, …).
set -Eeuo pipefail
umask 027

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
M="${QAPAQ_WAZUH_CONTAINER:-qapaq-wazuh.manager-1}"
RECEIVER_UID="${QAPAQ_AWS_EVENTS_UID:-1000}"
BEGIN='<!-- QAPAQ:aws-events:begin -->'
END='<!-- QAPAQ:aws-events:end -->'
log() { printf '[qapaq-aws-events] %s\n' "$*"; }
fail() { printf '[qapaq-aws-events] ERROR: %s\n' "$*" >&2; exit 1; }

[[ $(id -u) -eq 0 ]] || fail 'ejecutar como root'
docker inspect "$M" >/dev/null 2>&1 || fail "no existe el contenedor $M"

LOGVOL="$(docker inspect "$M" --format '{{range .Mounts}}{{if eq .Destination "/var/ossec/logs"}}{{.Source}}{{end}}{{end}}')"
[[ -d $LOGVOL ]] || fail 'no se encontró el volumen de /var/ossec/logs del manager'
install -d -m 0750 -o root -g root "$LOGVOL/qapaq-collectors"
install -d -m 0750 -o "$RECEIVER_UID" -g root "$LOGVOL/qapaq-collectors/aws"
[[ -e $LOGVOL/qapaq-collectors/aws/aws-events.jsonl ]] ||
  install -m 0640 -o "$RECEIVER_UID" -g root /dev/null "$LOGVOL/qapaq-collectors/aws/aws-events.jsonl"
log "salida: $LOGVOL/qapaq-collectors/aws/aws-events.jsonl"

stage="$(mktemp -d)"
hostbak=''
hosttmp=''
manager_restarted=false
cleanup() {
  status=$?
  if [[ $status -ne 0 && $manager_restarted == true && -n $hostbak && -f $hostbak ]]; then
    docker cp "$hostbak" "$M:/tmp/qapaq-aws-events-host-rollback.conf" >/dev/null 2>&1 || true
    docker exec -u 0 "$M" bash -euo pipefail -c \
      'install -o root -g wazuh -m 0660 /tmp/qapaq-aws-events-host-rollback.conf /var/ossec/etc/ossec.conf; rm -f /tmp/qapaq-aws-events-host-rollback.conf; /var/ossec/bin/wazuh-control restart >/dev/null 2>&1' \
      >/dev/null 2>&1 || true
    log 'falló la persistencia host; ossec.conf del manager restaurado desde el backup'
  fi
  [[ -z $hosttmp ]] || rm -f "$hosttmp"
  rm -rf "$stage"
  exit "$status"
}
trap cleanup EXIT
chmod 0700 "$stage"
cp "$HERE/rules/qapaq_aws_rules.xml" "$stage/"
sed -i 's/\r$//' "$stage/qapaq_aws_rules.xml"
docker cp "$M:/var/ossec/etc/ossec.conf" "$stage/ossec.conf"
python3 - "$stage/ossec.conf" "$BEGIN" "$END" <<'PY'
import re, sys
path, begin, end = sys.argv[1:4]
block = (
    "<ossec_config>\n  <localfile>\n"
    "    <location>/var/ossec/logs/qapaq-collectors/aws/aws-events.jsonl</location>\n"
    "    <log_format>json</log_format>\n"
    "    <label key=\"qapaq.channel\">aws-eventbridge</label>\n"
    "  </localfile>\n</ossec_config>"
)
text = open(path, encoding="utf-8").read()
text = re.sub(re.escape(begin) + r".*?" + re.escape(end) + r"\n?", "", text, flags=re.S)
text = text.rstrip("\n") + "\n" + begin + "\n" + block + "\n" + end + "\n"
open(path, "w", encoding="utf-8").write(text)
PY
docker cp "$stage/." "$M:/tmp/qapaq-aws-events"
docker exec -u 0 -e RESTART="${QAPAQ_RESTART:-true}" "$M" bash -euo pipefail -c '
  O=/var/ossec; S=/tmp/qapaq-aws-events
  bak=$O/etc/qapaq-backup-aws-events-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$bak"
  cp -a $O/etc/ossec.conf "$bak/"; [ -f $O/etc/rules/qapaq_aws_rules.xml ] && cp -a $O/etc/rules/qapaq_aws_rules.xml "$bak/" || true
  install -o wazuh -g wazuh -m 0660 $S/qapaq_aws_rules.xml $O/etc/rules/
  install -o root -g wazuh -m 0660 $S/ossec.conf $O/etc/ossec.conf
  if ! $O/bin/wazuh-analysisd -t >/tmp/qapaq-aws-events-analysisd.log 2>&1; then
    tail -20 /tmp/qapaq-aws-events-analysisd.log >&2
    cp -a "$bak/ossec.conf" $O/etc/ossec.conf
    if [ -f "$bak/qapaq_aws_rules.xml" ]; then cp -a "$bak/qapaq_aws_rules.xml" $O/etc/rules/; else rm -f $O/etc/rules/qapaq_aws_rules.xml; fi
    echo "configuración inválida: revertida a $bak" >&2; exit 1
  fi
  rm -rf $S
  if [ "$RESTART" = true ] && ! $O/bin/wazuh-control restart >/dev/null 2>&1; then
    cp -a "$bak/ossec.conf" $O/etc/ossec.conf
    if [ -f "$bak/qapaq_aws_rules.xml" ]; then
      cp -a "$bak/qapaq_aws_rules.xml" $O/etc/rules/qapaq_aws_rules.xml
    else
      rm -f $O/etc/rules/qapaq_aws_rules.xml
    fi
    $O/bin/wazuh-control restart >/dev/null 2>&1 || true
    echo "reinicio falló; configuración AWS revertida a $bak" >&2
    exit 1
  fi
'
[[ ${QAPAQ_RESTART:-true} != true ]] || manager_restarted=true
log 'reglas 101600-101699 y <localfile> instalados; wazuh-analysisd -t OK'
HOSTCONF="$(docker inspect "$M" --format '{{range .Mounts}}{{if eq .Destination "/wazuh-config-mount/etc/ossec.conf"}}{{.Source}}{{end}}{{end}}')"
if [[ -n $HOSTCONF && -f $HOSTCONF ]]; then
  hostbak="${HOSTCONF}.qapaq-bak-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$HOSTCONF" "$hostbak"
  docker cp "$M:/var/ossec/etc/ossec.conf" "$stage/persist.conf"
  hosttmp="$(mktemp "${HOSTCONF}.qapaq-new.XXXXXX")"
  cat "$stage/persist.conf" >"$hosttmp"
  chown --reference="$HOSTCONF" "$hosttmp"
  chmod --reference="$HOSTCONF" "$hosttmp"
  mv -f "$hosttmp" "$HOSTCONF"
  hosttmp=''
  log 'ossec.conf persistido en el montaje del host'
fi
[[ ${QAPAQ_RESTART:-true} == true ]] && log 'manager reiniciado' || log 'manager NO reiniciado (QAPAQ_RESTART=false)'
