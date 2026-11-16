#!/usr/bin/env bash
# Prepara el token del servicio de informes de Qapaqzito (services/qapaq-reports). Ejecutar EN el host
# como root, después de que deploy-host.sh haya generado secrets/api.env. Idempotente: el token se
# genera una sola vez; el mismo valor queda en secrets/reports.env (lo lee el servicio) y en
# secrets/api.env (lo usa el API como QAPAQ_REPORTS_TOKEN). No imprime ni pasa secretos por
# argumentos o logs.
set -euo pipefail
umask 077

ROOT=/opt/qapaq
SECRETS=$ROOT/secrets
API_ENV=$SECRETS/api.env
REPORTS_ENV=$SECRETS/reports.env
API_CONFIG=$ROOT/config/api.env

fail() { printf '[qapaq-reports-bootstrap] %s\n' "$1" >&2; exit 1; }
[[ $EUID == 0 ]] || fail 'debe ejecutarse como root'
[[ -s $API_ENV ]] || fail 'falta /opt/qapaq/secrets/api.env'
[[ ! -L $API_ENV && ! -L $REPORTS_ENV ]] || fail 'no se aceptan symlinks para secretos'

read_single_env_value() {
  local file=$1 key=$2 count value
  [[ -f $file ]] || { printf ''; return; }
  count=$(awk -F= -v key="$key" '$1 == key { count++ } END { print count + 0 }' "$file")
  [[ $count -le 1 ]] || fail "variable duplicada en archivo de entorno: $key"
  if [[ $count == 0 ]]; then
    printf ''
    return
  fi
  value=$(sed -n "s/^${key}=//p" "$file")
  # Valores hex o base64: se rechaza sintaxis de shell, espacios, comillas y saltos de línea.
  [[ $value =~ ^[A-Za-z0-9+/=_-]{32,}$ ]] || fail "valor no válido para $key"
  printf '%s' "$value"
}

# La fuente de verdad es api.env (como el token del correlador); reports.env se reescribe desde ahí.
token=$(read_single_env_value "$API_ENV" QAPAQ_REPORTS_TOKEN)
if [[ -z $token ]]; then
  token=$(read_single_env_value "$REPORTS_ENV" QAPAQ_REPORTS_TOKEN)
fi
if [[ -z $token ]]; then
  token=$(openssl rand -hex 32)
fi

if ! grep -q '^QAPAQ_REPORTS_TOKEN=' "$API_ENV"; then
  printf '\nQAPAQ_REPORTS_TOKEN=%s\n' "$token" >>"$API_ENV"
fi
chown root:root "$API_ENV"
chmod 0600 "$API_ENV"

tmp=$(mktemp "$SECRETS/.reports.env.XXXXXX")
printf 'QAPAQ_REPORTS_TOKEN=%s\n' "$token" >"$tmp"
chown root:root "$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$REPORTS_ENV"
unset token

# URL interna (no secreta) en la configuración del API; deploy-host.sh la regenera desde la plantilla.
if [[ -f $API_CONFIG && ! -L $API_CONFIG ]] && ! grep -q '^QAPAQ_REPORTS_URL=' "$API_CONFIG"; then
  printf '\nQAPAQ_REPORTS_URL=http://reports:8090\n' >>"$API_CONFIG"
fi
printf '[qapaq-reports-bootstrap] token del servicio de informes listo (secrets/reports.env, 0600)\n'
