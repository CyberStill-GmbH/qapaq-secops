#!/usr/bin/env bash
# Crea UNA vez, como administrador QAPAQ, los index patterns que la app de Wazuh necesita y el patrón
# por defecto. Así los analistas (solo lectura en global_tenant, roles.qapaq.yml) no necesitan
# escribir en .kibana y el health check de la app no falla con «no permissions for
# [indices:data/write/index]». Idempotente (409 = ya existe).
#
#   bash infra/local/edge/bootstrap-wazuh-index-patterns.sh
#
# Se ejecuta DENTRO del contenedor del dashboard (IP fija, el único origen de proxy auth que acepta
# el indexer) con la identidad qapaq.platform.admin → all_access (roles_mapping.qapaq.yml).
# Requiere haber aplicado antes infra/local/edge/apply-indexer-security.sh.
set -euo pipefail
c="${DASHBOARD_CONTAINER:-single-node-wazuh.dashboard-1}"
export MSYS_NO_PATHCONV=1

osd() { # método ruta [json]
  docker exec "$c" curl -s -o /dev/null -w '%{http_code}' -X "$1" "http://localhost:5601$2" \
    -H 'osd-xsrf: qapaq-bootstrap' -H 'content-type: application/json' \
    -H 'x-proxy-user: qapaq-bootstrap' -H 'x-proxy-roles: qapaq.platform.admin' \
    -H 'x-forwarded-for: 127.0.0.1' ${3:+-d "$3"}
}

for pattern in wazuh-alerts-* wazuh-monitoring-* wazuh-statistics-*; do
  code="$(osd POST "/api/saved_objects/index-pattern/$pattern" \
    "{\"attributes\":{\"title\":\"$pattern\",\"timeFieldName\":\"timestamp\"}}")"
  case "$code" in
    200) echo "index pattern $pattern creado" ;;
    409) echo "index pattern $pattern ya existía" ;;
    *) echo "index pattern $pattern → HTTP $code" >&2; exit 1 ;;
  esac
done

code="$(osd POST /api/opensearch-dashboards/settings '{"changes":{"defaultIndex":"wazuh-alerts-*"}}')"
[ "$code" = 200 ] || { echo "defaultIndex → HTTP $code" >&2; exit 1; }
echo 'defaultIndex = wazuh-alerts-*'
