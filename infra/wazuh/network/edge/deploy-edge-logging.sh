#!/usr/bin/env bash
# QAPAQ SecOps · activa la bitácora JSON del edge nginx para Wazuh en el nodo PowerUser (docs/18).
# Corre EN el host, como root:  sudo bash infra/wazuh/network/edge/deploy-edge-logging.sh
#
# 1. Valida qapaq-edge-logging.conf con `nginx -t` DENTRO del edge en ejecución (mismos upstreams y
#    certificados) y lo retira: si falla, no se toca nada.
# 2. Compara el servicio edge de `docker compose config` antes y después (solo deben aparecer los dos
#    montajes nuevos) y recrea SOLO el edge (--no-deps). Corte de ~2 s en la consola.
# 3. Verifica /health/live por el edge y que access.json reciba líneas; si falla, vuelve a la definición
#    anterior del edge (copia de compose.qapaq.yaml) y lo recrea.
# 4. logrotate del directorio en el volumen de logs del manager (copytruncate, 7 días, 100 MB).
# Requiere que deploy-network.sh manager haya creado qapaq-collectors/edge y el <localfile>.
set -Eeuo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${QAPAQ_ROOT:-/opt/qapaq}"
HOST_DIR="$ROOT/src/infra/aws-poweruser/host"
log() { printf '[qapaq-edge-logs] %s\n' "$*"; }
[[ $EUID -eq 0 ]] || { log 'correr como root'; exit 1; }
COMPOSE=(docker compose --env-file "$ROOT/secrets/compose.env" -f "$ROOT/wazuh-docker/single-node/docker-compose.yml" -f "$HOST_DIR/compose.qapaq.yaml")
[[ -f "$HOST_DIR/compose.respond.yaml" && -d "$ROOT/respond/frontend" ]] && COMPOSE+=(-f "$HOST_DIR/compose.respond.yaml")
cd "$ROOT"
E="$(docker ps --format '{{.Names}}' | grep -E -- '-edge-1$' | head -n1)"
[[ -n "$E" ]] || { log 'no hay contenedor edge'; exit 1; }
conf="$ROOT/src/infra/wazuh/network/edge/qapaq-edge-logging.conf"
[[ "$here/qapaq-edge-logging.conf" -ef "$conf" ]] || install -D -m 0644 "$here/qapaq-edge-logging.conf" "$conf"

# 1. nginx -t en el edge vivo
docker cp "$conf" "$E:/etc/nginx/conf.d/qapaq-logging.conf"
docker exec "$E" mkdir -p /var/log/qapaq-edge
if ! docker exec "$E" nginx -t 2>&1 | tail -2; then
  docker exec "$E" rm -f /etc/nginx/conf.d/qapaq-logging.conf
  log 'nginx -t falló: no se cambia nada'; exit 1
fi
docker exec "$E" rm -f /etc/nginx/conf.d/qapaq-logging.conf

# 2. definición del edge: antes / después
yaml="$HOST_DIR/compose.qapaq.yaml"
grep -q 'qapaq-edge-logging.conf' "$yaml" || { log "$yaml no tiene el montaje del edge (copiar la versión del repo)"; exit 1; }
"${COMPOSE[@]}" config edge >"/tmp/qapaq-edge-after.yaml" 2>/dev/null || "${COMPOSE[@]}" config >"/tmp/qapaq-edge-after.yaml"
mounts_now="$(docker inspect "$E" --format '{{range .Mounts}}{{.Destination}} {{end}}')"
log "montajes actuales: $mounts_now"
"${COMPOSE[@]}" up -d --no-deps edge
sleep 4

# 3. verificación
E="$(docker ps --format '{{.Names}}' | grep -E -- '-edge-1$' | head -n1)"
ok=0
for _ in $(seq 1 15); do
  code="$(curl -sk -o /dev/null -w '%{http_code}' --resolve "${SOC_HOSTNAME:-dev.security.qapaq.pe}:443:127.0.0.1" "https://${SOC_HOSTNAME:-dev.security.qapaq.pe}/health/live" || true)"
  [[ "$code" == 200 ]] && { ok=1; break; }
  sleep 2
done
[[ $ok == 1 ]] || { log "el edge no responde /health/live ($code)"; docker logs --tail 30 "$E" >&2; exit 1; }
curl -sk -o /dev/null -A 'qapaq-edge-logging-check' --resolve "${SOC_HOSTNAME:-dev.security.qapaq.pe}:443:127.0.0.1" "https://${SOC_HOSTNAME:-dev.security.qapaq.pe}/app/login" || true
sleep 1
docker exec "$E" sh -c 'tail -n 1 /var/log/qapaq-edge/access.json' | grep -q '"vendor":"qapaq-edge"' &&
  log 'access.json recibe líneas JSON' || { log 'AVISO: access.json sin líneas nuevas'; exit 1; }

# 4. logrotate en el host (ruta real del volumen de logs del manager)
M="$(docker ps --format '{{.Names}}' | grep -E 'wazuh\.manager' | head -n1)"
vol="$(docker inspect "$M" --format '{{range .Mounts}}{{if eq .Destination "/var/ossec/logs"}}{{.Source}}{{end}}{{end}}')"
if [[ -n "$vol" ]]; then
  cat >/etc/logrotate.d/qapaq-edge <<EOF
# QAPAQ SecOps · bitácora del edge para Wazuh (infra/wazuh/network/edge/deploy-edge-logging.sh)
$vol/qapaq-collectors/edge/access.json $vol/qapaq-collectors/edge/error.log {
    daily
    maxsize 100M
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF
  logrotate -d /etc/logrotate.d/qapaq-edge >/dev/null 2>&1 && log "logrotate: $vol/qapaq-collectors/edge"
fi
log 'listo'
