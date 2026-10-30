#!/usr/bin/env bash
# Edge QAPAQ en Azure (opcional): nginx con TLS de Let's Encrypt delante del dashboard,
# login QAPAQ por proxy auth, API QAPAQ en el mismo origen y, si el bundle lo declara,
# Ankay en /ankay/* detrás de la sesión QAPAQ y el webhook Wazuh → Ankay.
#
# Lo llama install.sh solo si el bundle trae edge.json (azure-siem-release-bundle.yml lo
# escribe con entradas no secretas). Requisitos: DNS del hostname apuntando a la IP pública
# del Azure Firewall, DNAT 80/443 al SIEM (ingress_http_enabled) y salida a Let's Encrypt.
# Si algo falla, el dashboard sigue como lo dejó el asistente Wazuh y el script sale con error.
set -Eeuo pipefail
umask 022

fail() { printf 'qapaq-edge-azure: ERROR %s\n' "$1" >&2; exit 1; }
info() { printf 'qapaq-edge-azure: %s\n' "$1"; }

[[ "$(id -u)" == 0 ]] || fail 'se requiere root'
HERE="${QAPAQ_RELEASE_DIR:?}"
CONFIG="$HERE/edge.json"
CERT_NAME=qapaq-wazuh-dashboard
SECRETS="${QAPAQ_SECRET_DIR:-/etc/qapaq-secrets}"
[[ -s "$CONFIG" && ! -L "$CONFIG" ]] || fail 'falta edge.json en el bundle'

mapfile -t values < <(python3 - "$CONFIG" <<'PY'
import ipaddress, json, re, sys
cfg = json.load(open(sys.argv[1], encoding="utf-8"))
host_re = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")
allowed = {"schemaVersion", "hostname", "extraHostnames", "ankayUpstream", "ankayWebhookUrl"}
if cfg.get("schemaVersion") != 1 or set(cfg) - allowed:
    raise SystemExit("edge.json tiene un esquema no admitido")
hostname = cfg.get("hostname", "")
extra = cfg.get("extraHostnames", [])
if not host_re.fullmatch(hostname) or not isinstance(extra, list) or not all(isinstance(h, str) and host_re.fullmatch(h) for h in extra):
    raise SystemExit("hostname del edge inválido")
upstream = cfg.get("ankayUpstream", "")
if upstream:
    ip, _, port = upstream.partition(":")
    address = ipaddress.ip_address(ip)
    if address.version != 4 or not address.is_private or port != "3001":
        raise SystemExit("ankayUpstream debe ser <IPv4 privada>:3001")
webhook = cfg.get("ankayWebhookUrl", "")
if webhook and not re.fullmatch(r"http://(10|172|192)\.[0-9.]+:5001/api/v1/hooks/webhook_[0-9a-f-]{36}", webhook):
    raise SystemExit("ankayWebhookUrl inválida")
print(hostname)
print(" ".join(extra))
print(upstream)
print(webhook)
PY
) || fail 'edge.json no pasó validación'
EDGE_HOSTNAME="${values[0]}"
EDGE_EXTRA="${values[1]:-}"
ANKAY_UPSTREAM_VALUE="${values[2]:-}"
ANKAY_WEBHOOK_URL="${values[3]:-}"

packages=(nginx certbot gettext-base python3-yaml)
missing=()
for package in "${packages[@]}"; do
  status="$(dpkg-query --show -f='${db:Status-Status}' "$package" 2>/dev/null || true)"
  [[ "$status" == installed ]] || missing+=("$package")
done
if (( ${#missing[@]} > 0 )); then
  python3 "$HERE/wazuh/azure-release/normalize_ubuntu_apt_sources.py" ||
    fail 'las fuentes apt contienen HTTP fuera del allowlist Ubuntu'
  apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update >/dev/null ||
    fail 'no se pudieron actualizar los índices apt'
  DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 \
    install --no-install-recommends --yes "${missing[@]}" >/dev/null ||
    fail 'no se pudieron instalar nginx/certbot desde Ubuntu'
fi
rm -f /etc/nginx/sites-enabled/default
install -d -m 0755 /var/www/certbot /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/qapaq-reload-nginx
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/qapaq-reload-nginx

# 1 · Certificado: mientras el asistente Wazuh ocupa 443, nginx solo atiende el reto HTTP-01.
if [[ ! -r "/etc/letsencrypt/live/$CERT_NAME/fullchain.pem" ]]; then
  cat > /etc/nginx/conf.d/qapaq-acme.conf <<EOF
server {
  listen 80;
  server_name $EDGE_HOSTNAME $EDGE_EXTRA;
  location /.well-known/acme-challenge/ { root /var/www/certbot; }
  location / { return 404; }
}
EOF
  nginx -t >/dev/null 2>&1 || fail 'nginx -t falló con la configuración ACME'
  systemctl enable --now nginx >/dev/null 2>&1 && systemctl reload nginx || fail 'nginx no arrancó para el reto ACME'
  domains=(-d "$EDGE_HOSTNAME")
  for host in $EDGE_EXTRA; do domains+=(-d "$host"); done
  certbot certonly --non-interactive --agree-tos --register-unsafely-without-email --webroot \
    --webroot-path /var/www/certbot --cert-name "$CERT_NAME" "${domains[@]}" >/dev/null 2>&1 ||
    fail "Let's Encrypt no emitió el certificado (¿el DNS de $EDGE_HOSTNAME apunta al firewall?)"
  rm -f /etc/nginx/conf.d/qapaq-acme.conf
fi

# 2 · Proxy auth QAPAQ en el Security plugin (backup y autoprueba propios).
bash "$HERE/wazuh/indexer/security/apply-security.sh" >/dev/null 2>&1 ||
  fail 'el Security plugin no aceptó el dominio de proxy auth QAPAQ (restaurado por apply-security)'

# 3 · Edge: dashboard a 127.0.0.1:5601, nginx en 443, /api QAPAQ y /ankay/ opcional.
SOC_HOSTNAME="$EDGE_HOSTNAME" SOC_EXTRA_HOSTNAMES="$EDGE_EXTRA" CERT_NAME="$CERT_NAME" \
  QAPAQ_API=http://127.0.0.1:3000 ANKAY_UPSTREAM="$ANKAY_UPSTREAM_VALUE" ANKAY_REQUIRE_READY=false \
  bash "$HERE/wazuh/edge/apply-edge.sh" >/dev/null 2>&1 ||
  fail 'apply-edge.sh no pasó sus pruebas; restauró dashboard y nginx'

# 4 · Webhook Wazuh → Ankay (triage de solo lectura) si el bundle y Key Vault lo traen.
if [[ -n "$ANKAY_WEBHOOK_URL" ]]; then
  token_file="$SECRETS/ankay-wazuh-webhook-token"
  [[ -s "$token_file" && ! -L "$token_file" ]] ||
    fail 'falta el secreto ankay-wazuh-webhook-token en wazuh_secret_names del perfil SIEM'
  python3 "$HERE/wazuh/shuffle/apply_ankay_webhook.py" --wazuh-root /var/ossec \
    --token-file "$token_file" --url "$ANKAY_WEBHOOK_URL" \
    --adapter "$HERE/wazuh/shuffle/custom-qapaq-shuffle" \
    --integration-template "$HERE/wazuh/shuffle/ossec-shuffle-webhook.xml" >/dev/null 2>&1 ||
    fail 'la integración Wazuh → Ankay no pasó validación; ossec.conf restaurado'
fi
info "edge activo en https://$EDGE_HOSTNAME${ANKAY_UPSTREAM_VALUE:+ con /ankay/ detrás de la sesión QAPAQ}"
