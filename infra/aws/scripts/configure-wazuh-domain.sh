#!/usr/bin/env bash
set -Eeuo pipefail

dashboard_hostname="${1:?dashboard hostname required}"
expected_ip="${2:?Elastic IP required}"
api_origin="${3:?ALB upstream hostname required}"
api_tls_server_name="${4:?API certificate hostname required}"
certificate_name="${5:?TLS certificate name required}"
legacy_dashboard_hostname="${6:-}"
[[ "$dashboard_hostname" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]]
[[ "$expected_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$api_origin" =~ ^[a-zA-Z0-9.-]+$ ]]
[[ "$api_tls_server_name" =~ ^[a-zA-Z0-9.-]+$ ]]
[[ "$certificate_name" =~ ^[a-zA-Z0-9-]+$ ]]
if [[ -n "$legacy_dashboard_hostname" ]]; then
  [[ "$legacy_dashboard_hostname" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]]
  [[ "$legacy_dashboard_hostname" != "$dashboard_hostname" ]]
fi

dashboard_server_names="$dashboard_hostname"
dashboard_hosts=("$dashboard_hostname")
certbot_args=(certonly --non-interactive --agree-tos --register-unsafely-without-email
  --webroot --webroot-path /var/www/certbot
  --cert-name "$certificate_name" --keep-until-expiring --reuse-key -d "$dashboard_hostname")
if [[ -n "$legacy_dashboard_hostname" ]]; then
  dashboard_server_names+=" $legacy_dashboard_hostname"
  dashboard_hosts+=("$legacy_dashboard_hostname")
  certbot_args+=(-d "$legacy_dashboard_hostname")
fi

command -v certbot >/dev/null
mkdir -p /var/cache/nginx/qapaq_auth /var/www/certbot/.well-known/acme-challenge
nginx -t

dns_ready=false
for attempt in $(seq 1 180); do
  if getent ahostsv4 "$dashboard_hostname" | awk '{print $1}' | grep -Fxq "$expected_ip"; then
    dns_ready=true
    break
  fi
  sleep 5
done
if [[ "$dns_ready" != true ]]; then
  echo 'Dashboard DNS has not resolved to the managed Elastic IP.' >&2
  exit 1
fi

certbot "${certbot_args[@]}"
systemctl enable --now snap.certbot.renew.timer
systemctl is-active --quiet snap.certbot.renew.timer

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
proxy_cache_path /var/cache/nginx/qapaq_auth levels=1 keys_zone=qapaq_auth:10m max_size=50m inactive=60s;
log_format qapaq_wazuh_domain '\$time_iso8601 \$request_id "\$request_method \$uri \$server_protocol" \$status \$body_bytes_sent \$request_time';

map \$http_accept \$qapaq_wants_html {
  default 0;
  "~*text/html" 1;
}

server {
  listen 80;
  server_name $dashboard_server_names;
  location /.well-known/acme-challenge/ { root /var/www/certbot; }
  location / { return 301 https://\$host\$request_uri; }
}

server {
  listen 443 ssl;
  server_name $dashboard_server_names;
  ssl_certificate /etc/letsencrypt/live/$certificate_name/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/$certificate_name/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  server_tokens off;
  client_max_body_size 50m;
  access_log /var/log/nginx/qapaq-wazuh-dashboard-access.log qapaq_wazuh_domain;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;

  location ^~ /qapaq-api/ {
    rewrite ^/qapaq-api/(.*)$ /\$1 break;
    proxy_pass https://$api_origin;
    # El backend ve /api/*, pero el navegador usa el prefijo externo /qapaq-api/.
    # Sin este ajuste, el navegador no enviaría el binding cookie al callback OIDC.
    proxy_cookie_path /api/auth/callback /qapaq-api/api/auth/callback;
    proxy_ssl_server_name on;
    proxy_ssl_name $api_tls_server_name;
    proxy_ssl_verify on;
    proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
    proxy_ssl_verify_depth 3;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header Sec-Fetch-Site \$http_sec_fetch_site;
    proxy_set_header x-proxy-user "";
    proxy_set_header x-proxy-roles "";
    proxy_buffering off;
    proxy_read_timeout 65s;
  }

  location = /_qapaq/introspect {
    internal;
    proxy_pass https://$api_origin/api/auth/introspect;
    proxy_ssl_server_name on;
    proxy_ssl_name $api_tls_server_name;
    proxy_ssl_verify on;
    proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
    proxy_ssl_verify_depth 3;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Host \$host;
    proxy_set_header Cookie \$http_cookie;
    proxy_set_header Accept "application/json";
    proxy_set_header Origin https://\$host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header x-proxy-user "";
    proxy_set_header x-proxy-roles "";
    proxy_cache qapaq_auth;
    proxy_cache_key \$cookie_qapaq_session;
    proxy_cache_valid 204 5s;
    proxy_cache_valid 401 403 0;
    proxy_ignore_headers Cache-Control Expires Set-Cookie;
  }

  location ^~ /qapaq/ {
    proxy_pass https://127.0.0.1:5601;
    proxy_http_version 1.1;
    proxy_ssl_verify off;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header x-proxy-user "";
    proxy_set_header x-proxy-roles "";
  }

  location ^~ /ui/ {
    proxy_pass https://127.0.0.1:5601;
    proxy_http_version 1.1;
    proxy_ssl_verify off;
    proxy_set_header Host \$host;
    proxy_set_header x-proxy-user "";
    proxy_set_header x-proxy-roles "";
  }

  location = /app/login { return 302 /qapaq/login\$is_args\$args; }

  location / {
    auth_request /_qapaq/introspect;
    auth_request_set \$qapaq_user  \$upstream_http_x_qapaq_user;
    auth_request_set \$qapaq_roles \$upstream_http_x_qapaq_roles;
    error_page 401 = @qapaq_sign_in;
    error_page 403 = @qapaq_forbidden;
    proxy_pass https://127.0.0.1:5601;
    proxy_http_version 1.1;
    proxy_ssl_verify off;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header x-proxy-user  \$qapaq_user;
    proxy_set_header x-proxy-roles \$qapaq_roles;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
  }

  location @qapaq_sign_in {
    if (\$qapaq_wants_html) { return 302 /qapaq/login?nextUrl=\$request_uri; }
    default_type application/json;
    return 401 '{"code":"AUTH_REQUIRED"}';
  }

  location @qapaq_forbidden {
    if (\$qapaq_wants_html) { return 302 /qapaq/login?authError=NETWORK_NOT_ALLOWED; }
    default_type application/json;
    return 403 '{"code":"NETWORK_NOT_ALLOWED"}';
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
  https_ready=true
  for hostname in "${dashboard_hosts[@]}"; do
    if ! curl --noproxy '*' --fail --silent --show-error --max-time 5 \
      --resolve "$hostname:443:127.0.0.1" "https://$hostname/" -o /dev/null; then
      https_ready=false
      break
    fi
  done
  [[ "$https_ready" == true ]] && break
  sleep 2
done
if [[ "$https_ready" != true ]]; then
  echo 'Dashboard HTTPS did not become ready after the Nginx reload.' >&2
  exit 1
fi
certbot certificates --cert-name "$certificate_name" | grep -Fq "Domains: ${dashboard_hosts[*]}"
echo "Wazuh dashboard HTTPS ready: https://$dashboard_hostname/ (rollback alias: ${legacy_dashboard_hostname:-none})"
