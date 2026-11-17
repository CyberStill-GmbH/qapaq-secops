#!/usr/bin/env bash
# Prepara tokens y CA para el correlador privado. Ejecutar EN el host como root y después
# de setup-ingestion.sh. No imprime ni pasa secretos por argumentos o logs.
set -euo pipefail
umask 077

ROOT=/opt/qapaq
SECRETS=$ROOT/secrets
API_ENV=$SECRETS/api.env
GATEWAY_ENV=$SECRETS/gateway.env
CORRELATOR_SECRETS=$SECRETS/correlator
CONFIG=$ROOT/config/correlator.env
UID_CORRELATOR=65532

fail() { printf '[qapaq-correlator-bootstrap] %s\n' "$1" >&2; exit 1; }
[[ $EUID == 0 ]] || fail 'debe ejecutarse como root'
[[ -s $API_ENV ]] || fail 'falta /opt/qapaq/secrets/api.env'
[[ -s $GATEWAY_ENV ]] || fail 'falta /opt/qapaq/secrets/gateway.env; ejecutar setup-ingestion.sh primero'
[[ -s $ROOT/pki/ca.pem ]] || fail 'falta la CA interna /opt/qapaq/pki/ca.pem'
[[ ! -L $API_ENV && ! -L $GATEWAY_ENV && ! -L $ROOT/pki/ca.pem ]] || fail 'no se aceptan symlinks para secretos o CA'

read_single_env_value() {
  local file=$1 key=$2 count value
  count=$(awk -F= -v key="$key" '$1 == key { count++ } END { print count + 0 }' "$file")
  [[ $count -le 1 ]] || fail "variable duplicada en archivo de entorno: $key"
  if [[ $count == 0 ]]; then
    printf ''
    return
  fi
  value=$(sed -n "s/^${key}=//p" "$file")
  # These values are generated as lowercase hex or base64. Reject shell syntax,
  # whitespace, quotes and line breaks instead of evaluating environment files.
  [[ $value =~ ^[A-Za-z0-9+/=_-]{32,}$ ]] || fail "valor no válido para $key"
  printf '%s' "$value"
}

gateway_token=$(read_single_env_value "$GATEWAY_ENV" QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN)
[[ -n $gateway_token ]] || fail 'gateway.env no contiene QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN'

if grep -q '^QAPAQ_CORRELATOR_SERVICE_TOKEN_REF=' "$API_ENV"; then
  fail 'QAPAQ_CORRELATOR_SERVICE_TOKEN_REF no es compatible con el secreto local del correlador'
fi
service_token=$(read_single_env_value "$API_ENV" QAPAQ_CORRELATOR_SERVICE_TOKEN)
if [[ -z $service_token ]]; then
  service_token=$(openssl rand -hex 32)
  printf '\nQAPAQ_CORRELATOR_SERVICE_TOKEN=%s\n' "$service_token" >>"$API_ENV"
fi
chown root:root "$API_ENV"
chmod 0600 "$API_ENV"

install -d -o root -g root -m 0700 "$CORRELATOR_SECRETS"
install -d -o root -g root -m 0755 "$(dirname "$CONFIG")"
[[ ! -L $CONFIG ]] || fail 'correlator.env no puede ser un symlink'
if [[ ! -e $CONFIG ]]; then
  printf '%s\n' 'QAPAQ_CORRELATOR_EMIT=false' >"$CONFIG"
  chown root:root "$CONFIG"
  chmod 0644 "$CONFIG"
fi
[[ -f $CONFIG && ! -L $CONFIG ]] || fail 'correlator.env debe ser un archivo regular, no un symlink'
chown root:root "$CONFIG"
chmod 0644 "$CONFIG"

write_secret() {
  local target=$1 value=$2 tmp
  tmp=$(mktemp "$CORRELATOR_SECRETS/.secret.XXXXXX")
  printf '%s\n' "$value" >"$tmp"
  chown "$UID_CORRELATOR:$UID_CORRELATOR" "$tmp"
  chmod 0400 "$tmp"
  mv -f "$tmp" "$target"
}

# Token de lectura API → correlador (/v1/*, proxy de /api/risk/*). api.env es la fuente: si ya
# lo tiene se reutiliza; si no, se reutiliza read.token o se genera y se agrega a api.env.
if grep -q '^QAPAQ_CORRELATOR_READ_TOKEN_REF=' "$API_ENV"; then
  fail 'QAPAQ_CORRELATOR_READ_TOKEN_REF no es compatible con el secreto local del correlador'
fi
read_token=$(read_single_env_value "$API_ENV" QAPAQ_CORRELATOR_READ_TOKEN)
if [[ -z $read_token ]]; then
  if [[ -s $CORRELATOR_SECRETS/read.token ]]; then
    read_token=$(tr -d '\r\n' <"$CORRELATOR_SECRETS/read.token")
    [[ $read_token =~ ^[A-Za-z0-9+/=_-]{32,}$ ]] || fail 'read.token existente no cumple el formato esperado'
  else
    read_token=$(openssl rand -hex 32)
  fi
  printf '\nQAPAQ_CORRELATOR_READ_TOKEN=%s\n' "$read_token" >>"$API_ENV"
fi
# URL interna del correlador (no secreta) en la configuración del API.
API_CONFIG=$ROOT/config/api.env
if [[ -f $API_CONFIG && ! -L $API_CONFIG ]] && ! grep -q '^QAPAQ_CORRELATOR_URL=' "$API_CONFIG"; then
  printf '\nQAPAQ_CORRELATOR_URL=http://correlator:8080\n' >>"$API_CONFIG"
fi
write_secret "$CORRELATOR_SECRETS/gateway.token" "$gateway_token"
write_secret "$CORRELATOR_SECRETS/service.token" "$service_token"
write_secret "$CORRELATOR_SECRETS/read.token" "$read_token"
unset gateway_token service_token read_token
printf '[qapaq-correlator-bootstrap] secretos y CA preparados; emisión configurada según %s\n' "$CONFIG"
