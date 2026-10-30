#!/usr/bin/env bash
# QAPAQ SecOps — edge unificado y dashboard con proxy auth (docs/04, docs/08). Idempotente.
#
# Corre en la instancia Wazuh (all-in-one) por SSM. Orden y compuertas:
#   1. Exige el dashboard del fork con el plugin qapaq_ops instalado: sin él, /qapaq/login no
#      existe y el edge dejaría a todos sin entrada. No instala el paquete (lo hace el release
#      del fork).
#   2. Exige que la API responda por la red privada (QAPAQ_API) en /api/auth/introspect con 401
#      sin cookie. Si responde otra cosa, se detiene antes de cambiar nada.
#   3. Escribe el bloque QAPAQ:dashboard en opensearch_dashboards.yml. Las claves que el bloque
#      redefine se comentan fuera de él para no duplicarlas. Reinicia el dashboard.
#   4. Renderiza wazuh/edge/qapaq-edge.conf en el archivo del dominio (reemplaza el proxy simple
#      de configure-wazuh-domain.sh). Si `nginx -t` o el reload fallan, restaura todo.
#   5. Smoke: sin sesión, `/` → 302 /qapaq/login y /api/alerts → 401; /qapaq/login → 200.
#
# Requiere que el Security plugin ya tenga el dominio de proxy auth
# (wazuh/indexer/security/apply-security.sh). Si no, el dashboard no reconoce a nadie.
#
# Variables: SOC_HOSTNAME (dominio público; p. ej. wazuh.jappi.net.pe)
#            QAPAQ_API    (salida `qapaq_edge_api_origin` de Terraform; p. ej. http://api.demo.qapaq.internal:3000)
#            ANKAY_UPSTREAM (opcional; host:puerto privado del frontend Ankay)
#            CERT_NAME    (opcional; certificado de Let's Encrypt, por defecto qapaq-wazuh-dashboard)
#            SOC_EXTRA_HOSTNAMES (opcional; p. ej. "app.jappi.net.pe": hostnames adicionales del mismo SIEM.
#                         Expande el certificado con certbot (HTTP-01; el DNS ya debe apuntar a este host).
set -euo pipefail
umask 022
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { printf 'qapaq-edge: ERROR %s\n' "$1" >&2; exit 1; }
info() { printf 'qapaq-edge: %s\n' "$1"; }

: "${SOC_HOSTNAME:?}" "${QAPAQ_API:?}"
export SOC_HOSTNAME QAPAQ_API CERT_NAME="${CERT_NAME:-qapaq-wazuh-dashboard}"
export SOC_SERVER_NAMES="$SOC_HOSTNAME ${SOC_EXTRA_HOSTNAMES:-}"
for host in ${SOC_EXTRA_HOSTNAMES:-}; do
  [[ "$host" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]] || fail "hostname extra inválido: $host"
done
[[ "$SOC_HOSTNAME" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]] || fail 'SOC_HOSTNAME inválido'
[[ "$QAPAQ_API" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || fail 'QAPAQ_API debe ser scheme://host[:puerto], sin ruta'
ANKAY_LOCATION=""
if [[ -n "${ANKAY_UPSTREAM:-}" ]]; then
  [[ "$ANKAY_UPSTREAM" =~ ^[A-Za-z0-9.-]+:[0-9]{1,5}$ ]] || fail 'ANKAY_UPSTREAM debe ser host:puerto privado, sin esquema ni ruta'
  ankay_host="${ANKAY_UPSTREAM%:*}"
  ankay_port="${ANKAY_UPSTREAM##*:}"
  (( 10#$ankay_port >= 1 && 10#$ankay_port <= 65535 )) || fail 'puerto ANKAY_UPSTREAM fuera de rango'
  if [[ "$ankay_host" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
    IFS=. read -r a b c d <<<"$ankay_host"
    for octet in "$a" "$b" "$c" "$d"; do
      [[ "$octet" =~ ^[0-9]{1,3}$ ]] && (( 10#$octet <= 255 )) || fail 'IPv4 ANKAY_UPSTREAM inválida'
    done
    if ! (( a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) )); then
      fail 'ANKAY_UPSTREAM IPv4 debe estar en una red RFC1918'
    fi
  else
    [[ "$ankay_host" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.internal$ ]] ||
      fail 'ANKAY_UPSTREAM DNS debe usar el sufijo privado .internal'
  fi
  # En Azure el SIEM se instala antes que el host Ankay: ANKAY_REQUIRE_READY=false deja la ruta
  # configurada (responde 502 tras el login hasta que Ankay esté sano) sin exigirlo ahora.
  if [[ "${ANKAY_REQUIRE_READY:-true}" != false ]]; then
    ankay_code="$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://$ANKAY_UPSTREAM/" || true)"
    [[ "$ankay_code" == 200 ]] || fail "Ankay privado no responde HTTP 200 en $ANKAY_UPSTREAM/ (HTTP $ankay_code); edge sin cambios"
  fi
  ANKAY_LOCATION="$(envsubst '${ANKAY_UPSTREAM}' <"$here/qapaq-ankay.location.conf")"
fi
export ANKAY_LOCATION
[[ -r "/etc/letsencrypt/live/$CERT_NAME/fullchain.pem" ]] || fail "no existe el certificado $CERT_NAME"
if [[ -n "${SOC_EXTRA_HOSTNAMES:-}" ]]; then
  domains=(-d "$SOC_HOSTNAME"); for host in $SOC_EXTRA_HOSTNAMES; do domains+=(-d "$host"); done
  certbot certonly --non-interactive --agree-tos --register-unsafely-without-email --webroot     --webroot-path /var/www/certbot --cert-name "$CERT_NAME" --expand --keep-until-expiring "${domains[@]}"     || fail "certbot no pudo expandir $CERT_NAME a: $SOC_EXTRA_HOSTNAMES (¿el DNS ya apunta a este host?)"
fi

DASHBOARD_YML=/etc/wazuh-dashboard/opensearch_dashboards.yml
PLUGIN_BIN=/usr/share/wazuh-dashboard/bin/opensearch-dashboards-plugin
NGINX_CONF=/etc/nginx/conf.d/qapaq-wazuh-dashboard.conf
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 1 · plugin del fork
plugin_list="$("$PLUGIN_BIN" list --allow-root 2>/dev/null)" ||
  fail 'no se pudo listar los plugins del dashboard'
if ! grep -qi 'qapaq' <<<"$plugin_list"; then
  fail 'el dashboard no tiene el plugin qapaq_ops (instalar antes el build del fork qapaq_ops-dashboard)'
fi

# 2 · API por la red privada
code="$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 5 "$QAPAQ_API/api/auth/introspect" || true)"
[[ "$code" == 401 ]] || fail "la API no responde 401 en $QAPAQ_API/api/auth/introspect (HTTP $code): revisar security groups y Cloud Map"
info 'API privada alcanzable'

# 3 · bloque del dashboard
cp "$DASHBOARD_YML" "$work/dashboard.previous"
cp "$NGINX_CONF" "$work/nginx.previous" 2>/dev/null || true
restore() {
  cp "$work/dashboard.previous" "$DASHBOARD_YML"
  if [[ -f "$work/nginx.previous" ]]; then cp "$work/nginx.previous" "$NGINX_CONF"; else rm -f "$NGINX_CONF"; fi
  systemctl restart wazuh-dashboard || true
  nginx -t && systemctl reload nginx || true
}
python3 - "$DASHBOARD_YML" "$here/../dashboard/opensearch_dashboards.qapaq.yml" <<'PY'
import re, sys
target, block_file = sys.argv[1:3]
block = open(block_file, encoding='utf-8').read().strip('\n')
text = open(target, encoding='utf-8').read()
text = re.sub(r'\n?# QAPAQ:dashboard:begin.*?# QAPAQ:dashboard:end\n?', '\n', text, flags=re.S)
keys = {m.group(1) for m in re.finditer(r'^([A-Za-z_][\w.]*):', block, re.M)}
out = []
for line in text.splitlines():
    m = re.match(r'^([A-Za-z_][\w.]*):', line)
    out.append(f'# QAPAQ (redefinido abajo): {line}' if m and m.group(1) in keys else line)
open(target, 'w', encoding='utf-8').write(
    '\n'.join(out).rstrip('\n') + '\n\n# QAPAQ:dashboard:begin\n' + block + '\n# QAPAQ:dashboard:end\n')
PY
systemctl restart wazuh-dashboard
login_code=000
for _ in $(seq 1 60); do
  login_code="$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:5601/qapaq/login || true)"
  [[ "$login_code" == 200 ]] && break
  sleep 5
done
[[ "$login_code" == 200 ]] || { restore; fail "el dashboard no sirve /qapaq/login (HTTP $login_code); restaurado"; }
info 'dashboard en 127.0.0.1:5601 con login QAPAQ'

# 4 · edge nginx
envsubst '${SOC_SERVER_NAMES} ${QAPAQ_API} ${CERT_NAME} ${ANKAY_LOCATION}' <"$here/qapaq-edge.conf" >"$work/edge.conf"
mkdir -p /var/cache/nginx/qapaq_auth
install -m 0644 "$work/edge.conf" "$NGINX_CONF"
if ! nginx -t; then restore; fail 'nginx -t falló; restaurado'; fi
systemctl reload nginx || { restore; fail 'reload de nginx falló; restaurado'; }

# 5 · smoke sin sesión
probe() { curl --noproxy '*' -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 \
  --resolve "$SOC_HOSTNAME:443:127.0.0.1" -H "accept: $2" "https://$SOC_HOSTNAME$1"; }
sleep 2
root="$(probe / text/html)"
api="$(probe /api/alerts application/json)"
login="$(probe /qapaq/login text/html)"
[[ "$root" == "302 https://$SOC_HOSTNAME/qapaq/login?nextUrl=/" ]] || { restore; fail "/ sin sesión → '$root' (esperado 302 al login); restaurado"; }
[[ "$api" == 401* ]] || { restore; fail "/api/alerts sin sesión → '$api' (esperado 401); restaurado"; }
[[ "$login" == 200* ]] || { restore; fail "/qapaq/login → '$login' (esperado 200); restaurado"; }
if [[ -n "${ANKAY_UPSTREAM:-}" ]]; then
  ankay="$(probe /ankay/ text/html)"
  [[ "$ankay" == "302 https://$SOC_HOSTNAME/qapaq/login?nextUrl=/ankay/" ]] || { restore; fail "/ankay/ anónimo → '$ankay' (esperado login QAPAQ); restaurado"; }
fi
info "edge activo en https://$SOC_HOSTNAME (login QAPAQ, proxy auth, API privada${ANKAY_UPSTREAM:+, Ankay con sesión y rol})"
