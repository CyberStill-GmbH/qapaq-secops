#!/usr/bin/env bash
# Prueba LOCAL de extremo a extremo «alerta Wazuh → QAPAQ»: indexa en wazuh-alerts-* una secuencia
# SINTÉTICA de Office 365 (varios UserLoginFailed y luego un New-InboxRule del mismo usuario,
# cadena de compromiso de cuenta) con la forma que deja el módulo office365 del manager
# (data.office365.*). La ingesta del API (static-token, compose.qapaq-engine.yaml) la lee en su
# siguiente pasada y la convierte en alerta QAPAQ.
#
#   bash infra/local/edge/inject-office365-alerts.sh [usuario@dominio]
#
# Solo para el indexer local (admin por basic dentro del contenedor). Los documentos llevan
# `rule.description` con «[prueba local QAPAQ]» para poder distinguirlos y borrarlos.
set -euo pipefail
idx_c="${INDEXER_CONTAINER:-single-node-wazuh.indexer-1}"
admin_pw="${INDEXER_ADMIN_PASSWORD:-SecretPassword}"
user="${1:-ana.prueba@qapaq.pe}"
ip='203.0.113.45'
export MSYS_NO_PATHCONV=1
index="wazuh-alerts-4.x-$(date -u +%Y.%m.%d)"
base="$(date -u +%s)"

doc() { # segundos_offset operación rule_id nivel grupo resultado
  local ts id
  ts="$(date -u -d "@$(( base + $1 ))" +%Y-%m-%dT%H:%M:%S.000+0000)"
  id="$(( base + $1 )).$RANDOM"
  cat <<JSON
{"timestamp":"$ts","id":"$id","agent":{"id":"000","name":"wazuh.manager"},"manager":{"name":"wazuh.manager"},
 "rule":{"id":"$3","level":$4,"description":"Office 365: $2 [prueba local QAPAQ]","groups":["office365","$5"],"firedtimes":1},
 "decoder":{"name":"json"},"location":"office365",
 "data":{"integration":"office365","office365":{"Id":"$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo $id)","CreationTime":"${ts%.*}","Operation":"$2",
  "OrganizationId":"00000000-0000-4000-8000-0000000b8900","RecordType":15,"ResultStatus":"$6","UserKey":"10032001B8900001",
  "UserType":0,"Workload":"AzureActiveDirectory","ClientIP":"$ip","ObjectId":"$user","UserId":"$user",
  "Subscription":"Audit.AzureActiveDirectory"}}}
JSON
}

post() {
  docker exec -i "$idx_c" curl -sk -o /dev/null -w '%{http_code}' -u "admin:$admin_pw" \
    -H 'content-type: application/json' -X POST "https://127.0.0.1:9200/$index/_doc?refresh=true" --data-binary @-
}

for i in 0 5 10 15 20; do
  [[ "$(doc "$i" UserLoginFailed 91545 5 authentication_failed Failed | post)" == 201 ]] || { echo 'fallo al indexar' >&2; exit 1; }
done
[[ "$(doc 40 UserLoggedIn 91544 3 authentication_success Succeeded | post)" == 201 ]] || exit 1
[[ "$(doc 60 New-InboxRule 91575 10 office365_exchange Succeeded | post)" == 201 ]] || exit 1
echo "7 alertas sintéticas de Office 365 indexadas en $index para $user (IP $ip)"
