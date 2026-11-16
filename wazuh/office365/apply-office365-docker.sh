#!/usr/bin/env bash
# QAPAQ SOC — aplica wazuh/office365 (módulo office365 de Wazuh + reglas 100502-100530) en el
# manager Docker (wazuh-docker single-node) y persiste ossec.conf en el montaje del host.
#
#   sudo bash wazuh/office365/apply-office365-docker.sh
#
# Secretos: /opt/qapaq/secrets/collectors/entra-{tenant-id,client-id,client-secret} (0600), creados
# por wazuh/provider-ingestion/install-qapaq-collectors.sh desde services.env (TENANT_ID, CLIENT_ID,
# CLIENT_SECRET). Requiere en la app Entra el permiso de aplicación Office 365 Management APIs
# ActivityFeed.Read con consentimiento de administrador; sin él el módulo arranca pero la API
# responde 401 (AF10001) y no hay eventos. Antes de aplicar se comprueba y se informa.
set -Eeuo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
M="${QAPAQ_WAZUH_CONTAINER:-qapaq-wazuh.manager-1}"
CS="${QAPAQ_SECRETS:-/opt/qapaq/secrets}/collectors"
log() { printf '[qapaq-office365] %s\n' "$*"; }
[[ $(id -u) -eq 0 ]] || { echo 'ejecutar como root' >&2; exit 1; }
for f in entra-tenant-id entra-client-id entra-client-secret; do
  [[ -s $CS/$f ]] || { echo "falta $CS/$f" >&2; exit 1; }
done

# Diagnóstico sin imprimir secretos: roles del token de manage.office.com y estado de la API.
python3 -I "$HERE/check_entra_app.py" --secrets "$CS" || log 'AVISO: la app no tiene ActivityFeed.Read; el módulo quedará configurado pero sin datos hasta concederlo'

stage="$(mktemp -d)"; trap 'rm -rf "$stage"' EXIT
cp -r "$HERE" "$stage/office365"
find "$stage/office365" -type f -exec sed -i 's/\r$//' {} +
tr -d '\r\n' <"$CS/entra-client-secret" >"$stage/client-secret"
docker cp "$stage/office365" "$M:/tmp/qapaq-office365"
docker cp "$stage/client-secret" "$M:/tmp/qapaq-o365-secret"
docker exec -u 0 \
  -e QAPAQ_O365_TENANT_ID="$(tr -d '\r\n' <"$CS/entra-tenant-id")" \
  -e QAPAQ_O365_CLIENT_ID="$(tr -d '\r\n' <"$CS/entra-client-id")" \
  -e QAPAQ_O365_SECRET_SOURCE=file:/tmp/qapaq-o365-secret \
  "$M" bash -c 'chmod 600 /tmp/qapaq-o365-secret
    command -v python3 >/dev/null || ln -sf /var/ossec/framework/python/bin/python3 /usr/local/bin/python3
    rc=0; bash /tmp/qapaq-office365/apply-office365.sh || rc=$?
    rm -rf /tmp/qapaq-office365 /tmp/qapaq-o365-secret; exit $rc'
HOSTCONF="$(docker inspect "$M" --format '{{range .Mounts}}{{if eq .Destination "/wazuh-config-mount/etc/ossec.conf"}}{{.Source}}{{end}}{{end}}')"
if [[ -n $HOSTCONF && -f $HOSTCONF ]]; then
  cp -p "$HOSTCONF" "${HOSTCONF}.qapaq-bak-$(date -u +%Y%m%dT%H%M%SZ)"
  docker cp "$M:/var/ossec/etc/ossec.conf" "$stage/persist.conf"
  cat "$stage/persist.conf" >"$HOSTCONF"
  log 'ossec.conf persistido en el montaje del host'
fi
