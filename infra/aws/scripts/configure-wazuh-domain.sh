#!/usr/bin/env bash
set -Eeuo pipefail

dashboard_hostname="${1:?dashboard hostname required}"
expected_ip="${2:?Elastic IP required}"
legacy_hostname="${3:-}"
redirect_hostname="${4:-}"
[[ "$dashboard_hostname" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]]
[[ "$expected_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
if [[ -n "$legacy_hostname" ]]; then
  [[ "$legacy_hostname" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]]
  [[ "$legacy_hostname" != "$dashboard_hostname" ]]
fi
if [[ -n "$redirect_hostname" ]]; then
  [[ "$redirect_hostname" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]]
  [[ "$redirect_hostname" != "$dashboard_hostname" && "$redirect_hostname" != "$legacy_hostname" ]]
fi

command -v certbot >/dev/null
nginx -t
mkdir -p /var/www/certbot/.well-known/acme-challenge

dns_ready=false
for attempt in $(seq 1 180); do
  if getent ahostsv4 "$dashboard_hostname" | awk '{print $1}' | grep -Fxq "$expected_ip"; then
    if { [[ -z "$legacy_hostname" ]] || getent ahostsv4 "$legacy_hostname" | awk '{print $1}' | grep -Fxq "$expected_ip"; } \
      && { [[ -z "$redirect_hostname" ]] || getent ahostsv4 "$redirect_hostname" | awk '{print $1}' | grep -Fxq "$expected_ip"; }; then
      dns_ready=true
      break
    fi
  fi
  sleep 5
done
if [[ "$dns_ready" != true ]]; then
  echo 'Dashboard, rollback, and branded redirect DNS have not resolved to the managed Elastic IP.' >&2
  exit 1
fi

domains=(-d "$dashboard_hostname")
if [[ -n "$legacy_hostname" ]]; then domains+=(-d "$legacy_hostname"); fi
if [[ -n "$redirect_hostname" ]]; then domains+=(-d "$redirect_hostname"); fi
certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
  --webroot --webroot-path /var/www/certbot --expand \
  --cert-name qapaq-wazuh-dashboard --keep-until-expiring "${domains[@]}"

# Un edge QAPAQ ya desplegado conserva su configuración y solo recarga el certificado
# expandido. No lo reemplazamos con el proxy simple de bootstrap.
if grep -qs 'QAPAQ edge' /etc/nginx/conf.d/qapaq-wazuh-dashboard.conf; then
  nginx -t
  systemctl reload nginx
  echo 'Edge QAPAQ activo: certificado ampliado y Nginx recargado sin cambiar la configuración.'
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
configuration=/etc/nginx/conf.d/qapaq-wazuh-dashboard.conf
if [[ -f "$configuration" ]]; then cp "$configuration" "$work/previous"; fi
restore_configuration() {
  if [[ -f "$work/previous" ]]; then
    cp "$work/previous" "$configuration"
  else
    rm -f "$configuration"
  fi
}

cat >"$work/next" <<NGINX
log_format qapaq_wazuh_domain '\$remote_addr \$request_method \$uri \$server_protocol \$status';
server {
  listen 443 ssl;
  server_name $dashboard_hostname ${legacy_hostname:-} ${redirect_hostname:-};
  ssl_certificate /etc/letsencrypt/live/qapaq-wazuh-dashboard/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/qapaq-wazuh-dashboard/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  client_max_body_size 50m;
  access_log /var/log/nginx/qapaq-wazuh-dashboard-access.log qapaq_wazuh_domain;
  location / {
    proxy_pass https://127.0.0.1:5601;
    proxy_http_version 1.1;
    proxy_ssl_verify off;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
  }
}
NGINX
install -m 0644 "$work/next" "$configuration"
if ! nginx -t; then restore_configuration; exit 1; fi
if ! systemctl reload nginx; then restore_configuration; exit 1; fi

# Reload is asynchronous: old workers can briefly serve the previous IP
# certificate. Bypass proxy environment variables for this local SNI probe.
https_ready=false
for attempt in $(seq 1 30); do
  if curl --noproxy '*' --fail --silent --show-error --max-time 5 \
    --resolve "$dashboard_hostname:443:127.0.0.1" "https://$dashboard_hostname/" -o /dev/null; then
    https_ready=true
    break
  fi
  sleep 2
done
if [[ "$https_ready" != true ]]; then
  echo 'Dashboard HTTPS did not become ready after the Nginx reload.' >&2
  exit 1
fi
echo "Wazuh dashboard HTTPS ready: https://$dashboard_hostname/"
