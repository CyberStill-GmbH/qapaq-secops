#!/usr/bin/env bash
# Ankay en el nodo PowerUser: Shuffle v2.3.0 (backend, orborus, opensearch) y el frontend
# rebrandeado de ankay/. Se ejecuta EN el host como root, después de deploy-host.sh, con el
# fuente del frontend ya generado por `ankay/build.sh` en /opt/qapaq/respond/frontend-source.tar.gz.
# Con SOC_HOSTNAME, vuelve a renderizar /opt/qapaq/config/edge.conf desde edge.conf.template (rutas del SSO).
set -euo pipefail
umask 022
ROOT=/opt/qapaq
R=$ROOT/respond
SECRETS=$ROOT/secrets
WD=$ROOT/wazuh-docker/single-node
HOST_DIR=$ROOT/src/infra/aws-poweruser/host
log() { printf '[ankay] %s\n' "$*"; }

# This override includes compose.qapaq.yaml, whose Manager mounts the host CA bundle.
EDGE_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
[[ -s $EDGE_CA_BUNDLE && -r $EDGE_CA_BUNDLE ]] || {
  echo "host CA bundle missing or unreadable: $EDGE_CA_BUNDLE" >&2
  exit 1
}

[[ -s $R/frontend-source.tar.gz ]] || { echo "falta $R/frontend-source.tar.gz" >&2; exit 1; }

if ! grep -q '^SHUFFLE_OPENSEARCH_PASSWORD=' "$SECRETS/compose.env"; then
  log 'generando secretos de Ankay'
  {
    # OpenSearch exige mayúscula, minúscula, dígito y símbolo.
    echo "SHUFFLE_OPENSEARCH_PASSWORD=$(openssl rand -hex 16)Aa9!"
    echo "SHUFFLE_ADMIN_USERNAME=admin@qapaq.pe"
    echo "SHUFFLE_ADMIN_PASSWORD=$(openssl rand -hex 12)Aa9."
    echo "SHUFFLE_ENCRYPTION_MODIFIER=$(openssl rand -hex 32)"
  } >>"$SECRETS/compose.env"
  chmod 600 "$SECRETS/compose.env"
fi

install -d -m 0755 "$R" "$R/apps" "$R/files"
install -d -m 0755 -o 1000 -g 1000 "$R/db"
cp "$HOST_DIR/shuffle.env" "$R/shuffle.env"
rm -rf "$R/frontend" "$R/src.tmp" && mkdir -p "$R/src.tmp"
tar -C "$R/src.tmp" -xzf "$R/frontend-source.tar.gz"
mv "$R/src.tmp/frontend" "$R/frontend" && rm -rf "$R/src.tmp"
# Si el fuente se generó en Windows (core.autocrlf), los scripts y plantillas traen CRLF y el
# entrypoint de nginx falla con `env: 'sh\r'`.
find "$R/frontend" -maxdepth 3 -type f \( -name '*.sh' -o -name '*.tpl' -o -name '*.conf' -o -name '*.tmpl' \) \
  -exec sed -i 's/\r$//' {} +

COMPOSE=(docker compose --env-file "$SECRETS/compose.env" -f "$WD/docker-compose.yml"
  -f "$HOST_DIR/compose.qapaq.yaml" -f "$HOST_DIR/compose.respond.yaml")
log 'construyendo el frontend de Ankay'
"${COMPOSE[@]}" build ankay-qapaq-frontend
log 'arrancando Ankay'
"${COMPOSE[@]}" up -d shuffle-opensearch shuffle-backend shuffle-orborus ankay-qapaq-frontend

# SSO QAPAQ → Ankay (decisión B11): imagen del puente, secretos (token edge↔puente y API key
# de la cuenta de servicio admin de Shuffle) y edge con las rutas /ankay/sso.
log 'puente SSO de Ankay'
"${COMPOSE[@]}" build ankay-sso
install -d -m 0700 -o 1000 -g 1000 "$SECRETS/respond-sso"
# Credenciales del admin inicial de Shuffle solo para este proceso (no se imprimen).
set -a; . "$SECRETS/compose.env"; set +a
for attempt in $(seq 1 20); do
  if "${COMPOSE[@]}" run --rm --no-deps -v "$SECRETS/respond-sso:/out" -e SHUFFLE_ADMIN_USERNAME -e SHUFFLE_ADMIN_PASSWORD ankay-sso node bootstrap.mjs; then
    break
  fi
  [[ $attempt -lt 20 ]] || { echo 'bootstrap del SSO fallido' >&2; exit 1; }
  sleep 15
done
"${COMPOSE[@]}" up -d --no-deps --force-recreate ankay-sso
if [[ -n ${SOC_HOSTNAME:-} ]]; then
  SOC_HOSTNAME="$SOC_HOSTNAME" envsubst '${SOC_HOSTNAME}' <"$HOST_DIR/edge.conf.template" >"$ROOT/config/edge.conf.new"
  # nginx -t en un contenedor desechable en la misma red: si falla, el edge vivo no se toca.
  net="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' qapaq-edge-1 | awk '{print $1}')"
  docker run --rm --network "$net" -v "$ROOT/config/edge.conf.new:/etc/nginx/conf.d/default.conf:ro"     -v /etc/letsencrypt:/etc/letsencrypt:ro -v "$SECRETS/respond-sso:/etc/nginx/ankay-sso:ro"     nginx:1.29.3 nginx -t
  install -m 0644 "$ROOT/config/edge.conf.new" "$ROOT/config/edge.conf" && rm -f "$ROOT/config/edge.conf.new"
fi
"${COMPOSE[@]}" up -d --no-deps --force-recreate edge
"${COMPOSE[@]}" ps --format 'table {{.Name}}\t{{.Status}}'
log 'listo'
