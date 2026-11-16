#!/usr/bin/env bash
# Ingesta Wazuh → QAPAQ sin Entra en el nodo PowerUser (QAPAQ_WAZUH_GATEWAY_AUTH=static-token, ver
# docs/04 «Ingesta de Wazuh sin Entra»). Idempotente; EN el host como root, con el indexer arriba.
#   1. Rol qapaq_alerts_read y usuario interno qapaq_reader (como wazuh/access/apply-access.sh).
#   2. Token estático del gateway, credencial Basic del lector y certificado TLS del gateway
#      (nombre wazuh-gateway, firmado por la CA interna que el API ya confía).
#   3. Autoprueba del lector: puede buscar en wazuh-alerts-* y NO puede escribir.
# Los secretos quedan en /opt/qapaq/secrets (0600): gateway.env y la parte del API en api.env.
set -euo pipefail
umask 022
: "${INDEXER_ADMIN_PASSWORD:?}"
ROOT=/opt/qapaq
SECRETS=$ROOT/secrets
PKI=$ROOT/pki
CERTS=$ROOT/wazuh-docker/single-node/config/wazuh_indexer_ssl_certs
log() { printf '[qapaq-ingestion] %s\n' "$*"; }

idx() { # método ruta [json]
  local args=(-sk -o /dev/null -w '%{http_code}' -u "admin:$INDEXER_ADMIN_PASSWORD" -X "$1"
    -H 'Content-Type: application/json' "https://127.0.0.1:9200$2")
  [[ $# -ge 3 ]] && args+=(--data-binary @-)
  if [[ $# -ge 3 ]]; then printf '%s' "$3" | curl "${args[@]}"; else curl "${args[@]}"; fi
}
expect() { [[ $1 =~ ^(200|201)$ ]] || { echo "$2 → HTTP $1" >&2; exit 1; }; }

# --- 1. secretos ---------------------------------------------------------------
if [[ ! -s $SECRETS/gateway.env ]]; then
  log 'generando token del gateway y contraseña de qapaq_reader'
  reader_pw="$(openssl rand -hex 24)Aa9."
  token="$(openssl rand -base64 48 | tr -d '\n')"
  {
    echo "QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN=$token"
    echo "WAZUH_INDEXER_BASIC_AUTH_B64=$(printf 'qapaq_reader:%s' "$reader_pw" | base64 -w0)"
    echo "QAPAQ_READER_PASSWORD=$reader_pw"
  } >"$SECRETS/gateway.env"
  chmod 600 "$SECRETS/gateway.env"
fi
set -a; . "$SECRETS/gateway.env"; set +a
if ! grep -q '^QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN=' "$SECRETS/api.env"; then
  echo "QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN=$QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN" >>"$SECRETS/api.env"
  chmod 600 "$SECRETS/api.env"
fi

# --- 2. rol y usuario del lector -------------------------------------------------
log 'rol qapaq_alerts_read y usuario qapaq_reader'
expect "$(idx PUT /_plugins/_security/api/roles/qapaq_alerts_read \
  '{"description":"QAPAQ: lectura de alertas Wazuh para la ingesta (S5-D3)","cluster_permissions":["cluster_monitor"],"index_permissions":[{"index_patterns":["wazuh-alerts-*"],"allowed_actions":["read"]}]}')" 'rol qapaq_alerts_read'
expect "$(python3 -c 'import json,os;print(json.dumps({"password":os.environ["QAPAQ_READER_PASSWORD"],"description":"QAPAQ: lector de alertas del gateway (solo lectura)"}))' \
  | curl -sk -o /dev/null -w '%{http_code}' -u "admin:$INDEXER_ADMIN_PASSWORD" -X PUT -H 'Content-Type: application/json' \
    --data-binary @- https://127.0.0.1:9200/_plugins/_security/api/internalusers/qapaq_reader)" 'usuario qapaq_reader'
expect "$(idx PUT /_plugins/_security/api/rolesmapping/qapaq_alerts_read '{"users":["qapaq_reader"]}')" 'mapeo qapaq_alerts_read'

# --- 3. TLS del gateway -----------------------------------------------------------
install -d -m 0755 "$PKI/gateway"
if [[ ! -s $PKI/gateway/cert.pem ]]; then
  log 'certificado del gateway (wazuh-gateway)'
  openssl req -new -nodes -newkey rsa:2048 -subj '/CN=wazuh-gateway' \
    -keyout "$PKI/gateway/key.pem" -out /tmp/gw.csr 2>/dev/null
  openssl x509 -req -in /tmp/gw.csr -CA "$PKI/ca.pem" -CAkey "$SECRETS/ca.key" -CAcreateserial -days 825 -sha256 \
    -extfile <(printf 'subjectAltName=DNS:wazuh-gateway\nextendedKeyUsage=serverAuth\n') -out "$PKI/gateway/cert.pem" 2>/dev/null
  rm -f /tmp/gw.csr
  chmod 0644 "$PKI/gateway/cert.pem"; chmod 0600 "$PKI/gateway/key.pem"
fi
install -m 0644 "$CERTS/root-ca.pem" "$PKI/gateway/indexer-ca.pem"

# --- 4. autoprueba del lector -------------------------------------------------------
r="$(curl -sk -o /dev/null -w '%{http_code}' -u "qapaq_reader:$QAPAQ_READER_PASSWORD" -H 'Content-Type: application/json' \
  --data '{"size":0}' 'https://127.0.0.1:9200/wazuh-alerts-*/_search')"
w="$(curl -sk -o /dev/null -w '%{http_code}' -u "qapaq_reader:$QAPAQ_READER_PASSWORD" -H 'Content-Type: application/json' \
  -X POST --data '{"x":1}' 'https://127.0.0.1:9200/wazuh-alerts-4.x-selftest/_doc')"
[[ $r == 200 && $w == 403 ]] || { echo "autoprueba del lector: search $r, write $w" >&2; exit 1; }
log "autoprueba: qapaq_reader search $r, write $w"
