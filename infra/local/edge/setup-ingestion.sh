#!/usr/bin/env bash
# Ingesta de Wazuh sin Entra en LOCAL (docs/04 «Ingesta de Wazuh sin Entra», commit d30bd3d).
# Equivalente local de infra/aws-poweruser/scripts/setup-ingestion.sh. Idempotente.
#
#   bash infra/local/edge/setup-ingestion.sh
#
#   1. Rol qapaq_alerts_read (read sobre wazuh-alerts-* + cluster_monitor) y usuario interno
#      qapaq_reader, como wazuh/access/apply-access.sh. Nada más.
#   2. Token estático del gateway, Basic del lector y certificado TLS del gateway para
#      127.0.0.1 en infra/local/edge/gateway/ (gitignored). No se imprime ningún secreto.
#   3. Variables de ingesta del API en api.local.env (el token por _REF, no en claro en la línea
#      de comandos).
# El gateway (platform/gateway/static-token) lo levanta compose.qapaq-engine.yaml en
# 127.0.0.1:18443; el API corre en el host y llega por loopback.
set -euo pipefail
umask 077
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dir="$here/gateway"
idx_c="${INDEXER_CONTAINER:-single-node-wazuh.indexer-1}"
admin_pw="${INDEXER_ADMIN_PASSWORD:-SecretPassword}"
export MSYS_NO_PATHCONV=1
mkdir -p "$dir"
rand() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('base64url'))"; }

if [[ ! -s $dir/gateway.env ]]; then
  reader_pw="QAPAQr-$(rand 24)"
  {
    echo "QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN=$(rand 48)"
    echo "QAPAQ_READER_PASSWORD=$reader_pw"
    echo "WAZUH_INDEXER_BASIC_AUTH_B64=$(printf 'qapaq_reader:%s' "$reader_pw" | base64 -w0)"
    echo 'WAZUH_INDEXER_UPSTREAM=wazuh.indexer:9200'
    echo 'WAZUH_INDEXER_TLS_NAME=wazuh.indexer'
  } >"$dir/gateway.env"
  echo 'secretos del gateway generados'
fi
set -a; . "$dir/gateway.env"; set +a

idx() { # método ruta [json por stdin]
  docker exec -i "$idx_c" curl -sk -o /dev/null -w '%{http_code}' -u "admin:$admin_pw" -X "$1" \
    -H 'content-type: application/json' "https://127.0.0.1:9200$2" ${3:+--data-binary @-}
}
expect() { [[ $1 =~ ^20[01]$ ]] || { echo "$2 → HTTP $1" >&2; exit 1; }; echo "$2 OK"; }
expect "$(printf '%s' '{"description":"QAPAQ: lectura de alertas Wazuh para la ingesta (S5-D3)","cluster_permissions":["cluster_monitor"],"index_permissions":[{"index_patterns":["wazuh-alerts-*"],"allowed_actions":["read"]}]}' |
  idx PUT /_plugins/_security/api/roles/qapaq_alerts_read body)" 'rol qapaq_alerts_read'
expect "$(node -e 'process.stdout.write(JSON.stringify({password:process.env.QAPAQ_READER_PASSWORD,description:"QAPAQ: lector de alertas del gateway (solo lectura)"}))' |
  idx PUT /_plugins/_security/api/internalusers/qapaq_reader body)" 'usuario qapaq_reader'
expect "$(printf '%s' '{"users":["qapaq_reader"]}' | idx PUT /_plugins/_security/api/rolesmapping/qapaq_alerts_read body)" 'mapeo qapaq_alerts_read'

if [[ ! -s $dir/cert.pem ]]; then
  # Rutas relativas: el openssl de Git for Windows no traduce /c/... con MSYS_NO_PATHCONV=1.
  (cd "$dir" && openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj '/CN=qapaq-local-gateway' \
    -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost' -keyout key.pem -out cert.pem 2>/dev/null)
  echo 'certificado del gateway generado'
fi
cp -f "$here/../../../../qapaq-secops/.local/wazuh-docker/single-node/config/wazuh_indexer_ssl_certs/root-ca.pem" "$dir/indexer-ca.pem" 2>/dev/null ||
  docker cp "$idx_c:/usr/share/wazuh-indexer/config/certs/root-ca.pem" "$(cygpath -w "$dir" 2>/dev/null || echo "$dir")/indexer-ca.pem"
chmod 644 "$dir/cert.pem" "$dir/indexer-ca.pem"

api_env="$here/api.local.env"
sed -i '/^# --- ingesta/,$d' "$api_env"
cat >>"$api_env" <<EOF
# --- ingesta de Wazuh sin Entra (setup-ingestion.sh; token en gateway/gateway.env) ---
QAPAQ_INGESTION_SOURCE=wazuh
QAPAQ_WAZUH_GATEWAY_AUTH=static-token
QAPAQ_WAZUH_GATEWAY_BASE_URL=https://127.0.0.1:18443
QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN_REF=secret://environment/QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN
EOF
echo 'api.local.env: ingesta static-token configurada (arrancar el API con gateway/gateway.env y NODE_EXTRA_CA_CERTS=gateway/cert.pem)'
