#!/usr/bin/env bash
# QAPAQ SecOps — acceso a Wazuh (Sprint 5 · fase 0 e identidad). Idempotente.
#
# Corre en la instancia Wazuh (all-in-one) por SSM desde el workflow `initialize-wazuh`.
# Deja Wazuh operativo para QAPAQ en una sola pasada:
#
#   1. `qapaq_reader`: usuario interno del Indexer con solo lectura sobre `wazuh-alerts-*`. Lo
#      usa KrakenD para la ingesta (S5-D3). Ningún otro permiso.
#   2. Proxy TLS del Indexer en la IP privada (puerto 9200): el all-in-one escucha solo en
#      127.0.0.1. nginx publica únicamente `/<índice de alertas>/_search` y `/_cluster/health`;
#      todo lo demás responde 403. Certificado propio para la IP privada.
#   3. Usuarios del Dashboard (decisión del dueño del producto): el dueño del grupo de admisión
#      como administrador (`all_access` + rol `administrator` de la API de Wazuh) y la persona
#      analista con solo lectura (`qapaq_wazuh_readonly` + `kibana_user` + rol `readonly`).
#   4. Publica en Secrets Manager la credencial del lector, el certificado del proxy y las
#      credenciales de los usuarios del Dashboard. Nada de eso se imprime.
#   5. Autoprueba: el lector puede buscar alertas por el proxy y no puede leer la configuración
#      de seguridad ni escribir. Si falla, sale con error.
#
# Reejecutarlo no rota contraseñas: reutiliza las publicadas, salvo QAPAQ_ROTATE=true.
#
# Variables:
#   QAPAQ_AWS_REGION, QAPAQ_ADMIN_USERNAME, QAPAQ_ANALYST_USERNAME (obligatorias)
#   QAPAQ_READER_SECRET_ID, QAPAQ_PROXY_CA_SECRET_ID, QAPAQ_ADMIN_USER_SECRET_ID,
#   QAPAQ_ANALYST_USER_SECRET_ID (IDs de Secrets Manager)
#   QAPAQ_ROTATE=true  rota todas las contraseñas gestionadas
# Solo para pruebas locales (nunca en la instancia):
#   QAPAQ_SECRET_DIR=<dir>          secretos en archivos en lugar de Secrets Manager
#   QAPAQ_INDEXER_URL, QAPAQ_WAZUH_API_URL, QAPAQ_INDEXER_CA (o "insecure"),
#   QAPAQ_INDEXER_ADMIN_PASSWORD, QAPAQ_WAZUH_API_PASSWORD, QAPAQ_PRIVATE_IP, QAPAQ_SKIP_PROXY=true,
#   QAPAQ_PROXY_UPSTREAM (host:puerto del Indexer para el proxy)

set -euo pipefail
umask 077

fail() { printf 'qapaq-access: ERROR %s\n' "$1" >&2; exit 1; }
info() { printf 'qapaq-access: %s\n' "$1"; }

: "${QAPAQ_ADMIN_USERNAME:?}" "${QAPAQ_ANALYST_USERNAME:?}"
# Herramientas del host (Ubuntu 24.04): nginx y python3 vienen del bootstrap; jq puede faltar.
if ! command -v jq >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq >/dev/null || fail 'no se pudo instalar jq'
fi
USERNAME_PATTERN='^[A-Za-z0-9._@-]{3,64}$'
[[ "$QAPAQ_ADMIN_USERNAME" =~ $USERNAME_PATTERN ]] || fail 'QAPAQ_ADMIN_USERNAME inválido'
[[ "$QAPAQ_ANALYST_USERNAME" =~ $USERNAME_PATTERN ]] || fail 'QAPAQ_ANALYST_USERNAME inválido'
[[ "$QAPAQ_ADMIN_USERNAME" != "$QAPAQ_ANALYST_USERNAME" ]] || fail 'admin y analista deben ser distintos'

READER_USER='qapaq_reader'
INDEXER_URL="${QAPAQ_INDEXER_URL:-https://127.0.0.1:9200}"
WAZUH_API_URL="${QAPAQ_WAZUH_API_URL:-https://127.0.0.1:55000}"
INDEXER_CA="${QAPAQ_INDEXER_CA:-/etc/wazuh-indexer/certs/root-ca.pem}"
ALERTS_PATTERN='wazuh-alerts-*'
PROXY_UPSTREAM="${QAPAQ_PROXY_UPSTREAM:-127.0.0.1:9200}"
PROXY_DIR=/etc/qapaq/indexer-proxy
PROXY_CONF=/etc/nginx/conf.d/qapaq-indexer-proxy.conf

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# ------------------------------------------------------------------ secretos

secret_get() { # id -> valor por stdout; vacío si no tiene versión
  if [[ -n "${QAPAQ_SECRET_DIR:-}" ]]; then
    cat "$QAPAQ_SECRET_DIR/$(printf '%s' "$1" | tr '/' '_')" 2>/dev/null || true
    return
  fi
  aws secretsmanager get-secret-value --region "$QAPAQ_AWS_REGION" --secret-id "$1" \
    --query SecretString --output text 2>/dev/null || true
}

secret_put() { # id archivo
  if [[ -n "${QAPAQ_SECRET_DIR:-}" ]]; then
    cp "$2" "$QAPAQ_SECRET_DIR/$(printf '%s' "$1" | tr '/' '_')"
    return
  fi
  aws secretsmanager put-secret-value --region "$QAPAQ_AWS_REGION" --secret-id "$1" \
    --secret-string "file://$2" >/dev/null
}

# Contraseña con las cuatro clases que exige la política del Indexer, sin caracteres que
# rompan JSON, curl o nginx.
new_password() {
  local core
  core="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 28)"
  printf 'Qp%s.9z' "$core"
}

# Contraseña publicada de un usuario (JSON {username,password}) o una nueva.
password_for() { # secret_id username
  local current
  current="$(secret_get "$1")"
  if [[ "${QAPAQ_ROTATE:-false}" != true && -n "$current" && "$current" != None ]]; then
    local stored_user
    stored_user="$(jq -r '.username // empty' <<<"$current" 2>/dev/null || true)"
    if [[ "$stored_user" == "$2" ]]; then
      jq -r '.password' <<<"$current"
      return
    fi
  fi
  new_password
}

# ------------------------------------------------------------ credenciales locales

passwords_file="$work/passwords.txt"
if [[ -z "${QAPAQ_INDEXER_ADMIN_PASSWORD:-}" || -z "${QAPAQ_WAZUH_API_PASSWORD:-}" ]]; then
  [[ -r /root/wazuh-install-files.tar ]] || fail 'no se encuentra wazuh-install-files.tar'
  tar -O -xf /root/wazuh-install-files.tar wazuh-install-files/wazuh-passwords.txt >"$passwords_file"
fi

# Lee del archivo de instalación la contraseña de un usuario (`<tipo>_username: '<usuario>'`).
install_password() { # prefijo usuario
  python3 - "$passwords_file" "$1" "$2" <<'PY'
import sys
path, prefix, user = sys.argv[1:4]
lines = [line.strip() for line in open(path, encoding='utf-8')]
for index, line in enumerate(lines):
    key, sep, value = line.partition(':')
    if sep and key.strip().lower() == f'{prefix}_username' and value.strip().strip("'\"") == user:
        for follow in lines[index + 1:index + 4]:
            k, s, v = follow.partition(':')
            if s and k.strip().lower() == f'{prefix}_password':
                print(v.strip().strip("'\""), end='')
                sys.exit(0)
sys.exit(1)
PY
}

INDEXER_ADMIN_PASSWORD="${QAPAQ_INDEXER_ADMIN_PASSWORD:-$(install_password indexer admin)}" \
  || fail 'no se pudo leer la credencial admin del Indexer'
WAZUH_API_PASSWORD="${QAPAQ_WAZUH_API_PASSWORD:-$(install_password api wazuh-wui)}" \
  || fail 'no se pudo leer la credencial wazuh-wui'

# Las credenciales viajan a curl por archivo de configuración, nunca por argumentos visibles
# en `ps`.
indexer_cfg="$work/indexer.curl"
printf 'user = "admin:%s"\n' "$INDEXER_ADMIN_PASSWORD" >"$indexer_cfg"
tls_args=()
if [[ "$INDEXER_CA" == insecure ]]; then tls_args=(-k); else tls_args=(--cacert "$INDEXER_CA"); fi

indexer() { # método ruta [archivo-json]
  local args=(-sS -K "$indexer_cfg" "${tls_args[@]}" -X "$1" -o "$work/response.json" -w '%{http_code}'
    -H 'Content-Type: application/json' "$INDEXER_URL$2")
  [[ $# -ge 3 ]] && args+=(--data-binary "@$3")
  local code
  code="$(curl "${args[@]}")"
  [[ "$code" =~ ^2 ]] || fail "Indexer $1 $2 respondió $code"
}

json_file() { local file; file="$(mktemp -p "$work")"; cat >"$file"; printf '%s' "$file"; }

# ---------------------------------------------------------------- 1. roles

info 'roles del Indexer'
indexer PUT /_plugins/_security/api/roles/qapaq_alerts_read "$(json_file <<JSON
{"description":"QAPAQ: lectura de alertas Wazuh para la ingesta (S5-D3)",
 "cluster_permissions":["cluster_monitor"],
 "index_permissions":[{"index_patterns":["$ALERTS_PATTERN"],"allowed_actions":["read"]}]}
JSON
)"
indexer PUT /_plugins/_security/api/roles/qapaq_wazuh_readonly "$(json_file <<'JSON'
{"description":"QAPAQ: analista con solo lectura en el Dashboard",
 "cluster_permissions":["cluster_composite_ops_ro"],
 "index_permissions":[{"index_patterns":["wazuh-*"],"allowed_actions":["read"]}]}
JSON
)"

# Agrega usuarios a un mapeo de rol sin quitar los que ya tenía (p. ej. `admin` en all_access).
map_users() { # rol usuario...
  local role="$1"; shift
  local current="$work/mapping.json"
  local code
  code="$(curl -sS -K "$indexer_cfg" "${tls_args[@]}" -o "$current" -w '%{http_code}' \
    "$INDEXER_URL/_plugins/_security/api/rolesmapping/$role")"
  if [[ "$code" == 404 ]]; then printf '{"%s":{}}' "$role" >"$current";
  elif [[ ! "$code" =~ ^2 ]]; then fail "Indexer GET mapping $role respondió $code"; fi
  local body
  body="$(jq -n --arg role "$role" --argjson current "$(cat "$current")" '
      ($current[$role] // {}) as $m
      | {backend_roles: ($m.backend_roles // []), hosts: ($m.hosts // []),
         users: ((($m.users // []) + $ARGS.positional) | unique)}' --args "$@")"
  indexer PUT "/_plugins/_security/api/rolesmapping/$role" "$(json_file <<<"$body")"
}

# ------------------------------------------------------------- 2. usuarios

# Reserved built-in roles cannot be assigned through this installation's user API.
# Copy their live permissions into managed roles and map only our own users.
copy_dashboard_role() { # source managed-name
  indexer GET "/_plugins/_security/api/roles/$1"
  local body
  body="$(jq -e --arg role "$1" '
    .[$role] | select(type == "object")
    | {cluster_permissions: (.cluster_permissions // []),
       index_permissions: (.index_permissions // []),
       tenant_permissions: (.tenant_permissions // [])}
  ' "$work/response.json")" || fail "no se pudo leer el rol $1"
  indexer PUT "/_plugins/_security/api/roles/$2" "$(json_file <<<"$body")"
}
copy_dashboard_role all_access qapaq_dashboard_admin
copy_dashboard_role kibana_user qapaq_dashboard_user

upsert_user() { # usuario contraseña descripción
  indexer PUT "/_plugins/_security/api/internalusers/$1" "$(jq -n \
    --arg password "$2" --arg description "$3" \
    '{password: $password, description: $description, backend_roles: []}' | json_file)"
}

info 'usuario de ingesta'
reader_password="$(password_for "${QAPAQ_READER_SECRET_ID:-reader}" "$READER_USER")"
upsert_user "$READER_USER" "$reader_password" 'QAPAQ: lector de alertas para KrakenD (solo lectura)'
map_users qapaq_alerts_read "$READER_USER"

info 'usuarios del Dashboard'
admin_password="$(password_for "${QAPAQ_ADMIN_USER_SECRET_ID:-admin-user}" "$QAPAQ_ADMIN_USERNAME")"
analyst_password="$(password_for "${QAPAQ_ANALYST_USER_SECRET_ID:-analyst-user}" "$QAPAQ_ANALYST_USERNAME")"
upsert_user "$QAPAQ_ADMIN_USERNAME" "$admin_password" 'QAPAQ: dueño del grupo de admisión (administrador)'
upsert_user "$QAPAQ_ANALYST_USERNAME" "$analyst_password" 'QAPAQ: analista (solo lectura)'
map_users qapaq_dashboard_admin "$QAPAQ_ADMIN_USERNAME"
map_users qapaq_dashboard_user "$QAPAQ_ANALYST_USERNAME"
map_users qapaq_wazuh_readonly "$QAPAQ_ANALYST_USERNAME"

# ------------------------------------------------- 3. roles de la API de Wazuh

# El Dashboard consulta la API de Wazuh como `wazuh-wui` con run_as: el rol efectivo sale de
# una regla por nombre de usuario ligada a un rol de la API.
info 'roles de la API de Wazuh'
api_cfg="$work/api.curl"
printf 'user = "wazuh-wui:%s"\n' "$WAZUH_API_PASSWORD" >"$api_cfg"
token="$(curl -sS -k -K "$api_cfg" -X POST "$WAZUH_API_URL/security/user/authenticate?raw=true")"
[[ "$token" =~ ^[A-Za-z0-9._-]{20,}$ ]] || fail 'no se pudo autenticar en la API de Wazuh'
bearer="$work/bearer.curl"
printf 'header = "Authorization: Bearer %s"\n' "$token" >"$bearer"

wazuh_api() { # método ruta [json]
  local args=(-sS -k -K "$bearer" -X "$1" -H 'Content-Type: application/json' "$WAZUH_API_URL$2")
  [[ $# -ge 3 ]] && args+=(--data "$3")
  curl "${args[@]}"
}

role_id() { wazuh_api GET "/security/roles?search=$1&limit=500" \
  | jq -r --arg name "$1" '.data.affected_items[] | select(.name == $name) | .id' | head -1; }

bind_api_role() { # usuario rol-api
  local rule_name="qapaq_user_$(printf '%s' "$1" | tr -c 'A-Za-z0-9_' '_')"
  local rule_id
  rule_id="$(wazuh_api GET "/security/rules?search=$rule_name&limit=500" \
    | jq -r --arg name "$rule_name" '.data.affected_items[] | select(.name == $name) | .id' | head -1)"
  if [[ -z "$rule_id" ]]; then
    rule_id="$(wazuh_api POST /security/rules "$(jq -cn --arg name "$rule_name" --arg user "$1" \
      '{name: $name, rule: {FIND: {user_name: $user}}}')" | jq -r '.data.affected_items[0].id')"
  fi
  [[ "$rule_id" =~ ^[0-9]+$ ]] || fail "no se pudo crear la regla para $1"
  local target
  target="$(role_id "$2")"
  [[ "$target" =~ ^[0-9]+$ ]] || fail "no existe el rol $2 en la API de Wazuh"
  wazuh_api POST "/security/roles/$target/rules?rule_ids=$rule_id" >/dev/null
}

bind_api_role "$QAPAQ_ADMIN_USERNAME" administrator
bind_api_role "$QAPAQ_ANALYST_USERNAME" readonly

# --------------------------------------------------------- 4. proxy privado

private_ip="${QAPAQ_PRIVATE_IP:-}"
if [[ -z "$private_ip" ]]; then
  imds="$(curl -sS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)"
  private_ip="$(curl -sS -H "X-aws-ec2-metadata-token: $imds" http://169.254.169.254/latest/meta-data/local-ipv4)"
fi
[[ "$private_ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || fail 'IP privada inválida'

if [[ "${QAPAQ_SKIP_PROXY:-false}" != true ]]; then
  info 'proxy TLS del Indexer'
  install -d -m 0750 "$PROXY_DIR"
  current_san="$(openssl x509 -in "$PROXY_DIR/cert.pem" -noout -ext subjectAltName 2>/dev/null || true)"
  if [[ "$current_san" != *"IP Address:$private_ip"* || "${QAPAQ_ROTATE:-false}" == true ]]; then
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 825 \
      -subj '/CN=qapaq-indexer-proxy' -addext "subjectAltName=IP:$private_ip" \
      -keyout "$PROXY_DIR/key.pem" -out "$PROXY_DIR/cert.pem" 2>/dev/null
  fi
  chmod 0640 "$PROXY_DIR/key.pem"; chmod 0644 "$PROXY_DIR/cert.pem"
  chgrp www-data "$PROXY_DIR" "$PROXY_DIR/key.pem" 2>/dev/null || true

  # Nombre que el proxy verifica en el certificado del Indexer: el primer DNS del SAN o, si no
  # hay, su IP. Se lee del certificado vivo para no suponer cómo lo generó el instalador.
  upstream_san="$(openssl s_client -connect "$PROXY_UPSTREAM" </dev/null 2>/dev/null     | openssl x509 -noout -ext subjectAltName 2>/dev/null | tr ',' '
' | sed 's/^ *//')"
  ssl_name="$(sed -n 's/^DNS://p' <<<"$upstream_san" | head -1)"
  [[ -n "$ssl_name" ]] || ssl_name="$(sed -n 's/^IP Address://p' <<<"$upstream_san" | head -1)"
  [[ "$ssl_name" =~ ^[A-Za-z0-9.:-]+$ ]] || fail 'no se pudo leer el SAN del certificado del Indexer'

  previous="$work/previous.conf"
  [[ -f "$PROXY_CONF" ]] && cp "$PROXY_CONF" "$previous"
  cat >"$PROXY_CONF" <<NGINX
# QAPAQ SecOps — proxy del Indexer para la ingesta (generado por apply-access.sh).
# Solo búsqueda en alertas y salud del clúster; el resto responde 403.
server {
  listen $private_ip:9200 ssl;
  ssl_certificate     $PROXY_DIR/cert.pem;
  ssl_certificate_key $PROXY_DIR/key.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  access_log off;
  client_max_body_size 64k;

  location ~ ^/wazuh-alerts-[A-Za-z0-9.*-]+/_search\$ {
    limit_except POST { deny all; }
    proxy_pass https://$PROXY_UPSTREAM;
    proxy_ssl_trusted_certificate $INDEXER_CA;
    proxy_ssl_verify on;
    proxy_ssl_name $ssl_name;
    proxy_read_timeout 15s;
  }
  location = /_cluster/health {
    limit_except GET { deny all; }
    proxy_pass https://$PROXY_UPSTREAM;
    proxy_ssl_trusted_certificate $INDEXER_CA;
    proxy_ssl_verify on;
    proxy_ssl_name $ssl_name;
  }
  location / { return 403; }
}
NGINX
  if ! nginx -t >/dev/null 2>&1; then
    if [[ -f "$previous" ]]; then cp "$previous" "$PROXY_CONF"; else rm -f "$PROXY_CONF"; fi
    fail 'configuración nginx inválida; se restauró la anterior'
  fi
  reload_nginx() { systemctl reload nginx 2>/dev/null || nginx -s reload; }
  reload_nginx
fi

restore_proxy() {
  [[ "${QAPAQ_SKIP_PROXY:-false}" == true ]] && return
  if [[ -f "$work/previous.conf" ]]; then cp "$work/previous.conf" "$PROXY_CONF"; else rm -f "$PROXY_CONF"; fi
  reload_nginx || true
}

# ------------------------------------------------------------- 5. publicar

info 'publicación de secretos'
publish_user() { # secret_id usuario contraseña
  local file; file="$(mktemp -p "$work")"
  jq -n --arg username "$2" --arg password "$3" '{username: $username, password: $password}' >"$file"
  secret_put "$1" "$file"
}
reader_file="$(mktemp -p "$work")"
jq -n --arg username "$READER_USER" --arg password "$reader_password" \
  --arg b64 "$(printf '%s:%s' "$READER_USER" "$reader_password" | base64 -w0)" \
  '{username: $username, password: $password, basic_auth_b64: $b64}' >"$reader_file"
secret_put "${QAPAQ_READER_SECRET_ID:-reader}" "$reader_file"
publish_user "${QAPAQ_ADMIN_USER_SECRET_ID:-admin-user}" "$QAPAQ_ADMIN_USERNAME" "$admin_password"
publish_user "${QAPAQ_ANALYST_USER_SECRET_ID:-analyst-user}" "$QAPAQ_ANALYST_USERNAME" "$analyst_password"
if [[ "${QAPAQ_SKIP_PROXY:-false}" != true ]]; then
  secret_put "${QAPAQ_PROXY_CA_SECRET_ID:-proxy-ca}" "$PROXY_DIR/cert.pem"
fi

# ------------------------------------------------------------- 6. autoprueba

info 'autoprueba del lector'
reader_cfg="$work/reader.curl"
printf 'user = "%s:%s"\n' "$READER_USER" "$reader_password" >"$reader_cfg"
if [[ "${QAPAQ_SKIP_PROXY:-false}" == true ]]; then
  probe_url="$INDEXER_URL"; probe_tls=("${tls_args[@]}")
else
  probe_url="https://$private_ip:9200"; probe_tls=(--cacert "$PROXY_DIR/cert.pem")
fi
probe() { curl -sS -o /dev/null -w '%{http_code}' -K "$reader_cfg" "${probe_tls[@]}" "$@"; }
# La primera búsqueda de un usuario recién creado puede tardar (caché de roles en frío): se
# reintenta antes de declarar el fallo.
for attempt in 1 2 3 4 5; do
  search_code="$(probe -X POST -H 'Content-Type: application/json' --data '{"size":0}' \
    "$probe_url/wazuh-alerts-*/_search" || true)"
  [[ "$search_code" == 200 ]] && break
  sleep 3
done
[[ "$search_code" == 200 ]] || { restore_proxy; fail "el lector no puede buscar alertas ($search_code)"; }
security_code="$(probe "$probe_url/_plugins/_security/api/internalusers")"
[[ "$security_code" == 403 ]] || fail "el lector alcanza la API de seguridad ($security_code)"
write_code="$(probe -X POST -H 'Content-Type: application/json' --data '{}' \
  "$probe_url/wazuh-alerts-qapaq-probe/_doc")"
[[ "$write_code" == 403 ]] || fail "el lector puede escribir ($write_code)"

info "completado: lector, proxy y usuarios (admin y analista) operativos"
