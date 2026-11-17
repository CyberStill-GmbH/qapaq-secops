#!/usr/bin/env bash
# Versión LOCAL de wazuh/indexer/security/apply-security.sh para wazuh-docker single-node:
# activa el dominio de proxy auth QAPAQ (x-proxy-user / x-proxy-roles) en el indexer, crea los
# roles QAPAQ y fusiona sus mapeos. Idempotente.
#
#   bash infra/local/edge/apply-indexer-security.sh
#
# Diferencia con producción: el que afirma identidad ante el indexer es el contenedor del
# dashboard, con IP fija 172.30.89.10 (compose.wazuh-dashboard-qapaq.yaml), no 127.0.0.1. Copia de seguridad en
# infra/local/edge/.security-backup/<fecha> (se restaura con: securityadmin -cd <dir>).
# Variables: INDEXER_CONTAINER (single-node-wazuh.indexer-1), INDEXER_ADMIN_PASSWORD (SecretPassword).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
sec="$repo/wazuh/indexer/security"
c="${INDEXER_CONTAINER:-single-node-wazuh.indexer-1}"
pw="${INDEXER_ADMIN_PASSWORD:-SecretPassword}"
PY="$(command -v python || command -v python3)"
export MSYS_NO_PATHCONV=1

secadmin() {
  docker exec -e JAVA_HOME=/usr/share/wazuh-indexer/jdk "$c" bash /usr/share/wazuh-indexer/plugins/opensearch-security/tools/securityadmin.sh \
    "$@" -icl -nhnv -h 127.0.0.1 \
    -cacert /usr/share/wazuh-indexer/config/certs/root-ca.pem \
    -cert /usr/share/wazuh-indexer/config/certs/admin.pem \
    -key /usr/share/wazuh-indexer/config/certs/admin-key.pem
}

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$here/.security-backup/$stamp"
mkdir -p "$backup"
host_backup="$(cygpath -w "$backup" 2>/dev/null || echo "$backup")"
docker exec "$c" rm -rf /tmp/qapaq-sec
docker exec "$c" mkdir -p /tmp/qapaq-sec/backup
secadmin -backup /tmp/qapaq-sec/backup >/dev/null
docker cp "$c:/tmp/qapaq-sec/backup/." "$host_backup"
[ -s "$backup/config.yml" ] || { echo "backup sin config.yml" >&2; exit 1; }
echo "backup en $backup"

host_sec="$(cygpath -w "$sec" 2>/dev/null || echo "$sec")"
"$PY" - "$host_backup" "$host_sec" <<'PY'
import sys, yaml
backup, sec = sys.argv[1:3]
live = yaml.safe_load(open(f'{backup}/config.yml', encoding='utf-8'))
ours = yaml.safe_load(open(f'{sec}/config.qapaq.yml', encoding='utf-8'))
dyn = live.setdefault('config', {}).setdefault('dynamic', {})
http = dict(ours['config']['dynamic']['http'])
http['xff'] = dict(http['xff'])
# Local: solo el contenedor del dashboard (IP fija en el override de compose).
http['xff']['internalProxies'] = r'172\.30\.89\.10'
dyn.setdefault('http', {}).update(http)
authc = dyn.setdefault('authc', {})
authc['qapaq_proxy_auth_domain'] = ours['config']['dynamic']['authc']['qapaq_proxy_auth_domain']
if 'basic_internal_auth_domain' in authc:
    authc['basic_internal_auth_domain']['order'] = max(1, authc['basic_internal_auth_domain'].get('order', 1))
yaml.safe_dump(live, open(f'{backup}/config.merged.yml', 'w', encoding='utf-8'), sort_keys=False)

rm = yaml.safe_load(open(f'{backup}/roles_mapping.yml', encoding='utf-8')) or {}
add = yaml.safe_load(open(f'{sec}/roles_mapping.qapaq.yml', encoding='utf-8')) or {}
for name, inc in add.items():
    if name == '_meta':
        continue
    cur = rm.setdefault(name, {})
    for key in ('backend_roles', 'users', 'hosts'):
        cur[key] = sorted(set((cur.get(key) or []) + (inc.get(key) or [])))
    if inc.get('description'):
        cur['description'] = inc['description']
yaml.safe_dump(rm, open(f'{backup}/roles_mapping.merged.yml', 'w', encoding='utf-8'), sort_keys=False)

roles = yaml.safe_load(open(f'{backup}/roles.yml', encoding='utf-8')) or {}
for name, body in (yaml.safe_load(open(f'{sec}/roles.qapaq.yml', encoding='utf-8')) or {}).items():
    if name != '_meta':
        roles[name] = body
yaml.safe_dump(roles, open(f'{backup}/roles.merged.yml', 'w', encoding='utf-8'), sort_keys=False)
PY

for f in config roles roles_mapping; do docker cp "$host_backup/$f.merged.yml" "$c:/tmp/qapaq-sec/$f.yml"; done
docker exec -u 0 "$c" chmod -R a+r /tmp/qapaq-sec
# Orden: roles antes que los mapeos que los referencian.
secadmin -f /tmp/qapaq-sec/roles.yml -t roles >/dev/null
secadmin -f /tmp/qapaq-sec/roles_mapping.yml -t rolesmapping >/dev/null
secadmin -f /tmp/qapaq-sec/config.yml -t config >/dev/null
echo 'config, roles y rolesmapping QAPAQ cargados'

# Autoprueba desde la red Docker (como el dashboard): admin por basic y proxy auth.
docker exec "$c" curl -sk -o /dev/null -w 'basic admin → %{http_code}\n' -u "admin:$pw" https://127.0.0.1:9200/_plugins/_security/authinfo
docker exec single-node-wazuh.dashboard-1 curl -sk -u "kibanaserver:kibanaserver" -o /dev/null -w 'kibanaserver → %{http_code}\n' https://wazuh.indexer:9200/_plugins/_security/authinfo
docker exec single-node-wazuh.dashboard-1 curl -sk -H 'x-proxy-user: qapaq-selftest' -H 'x-proxy-roles: qapaq.platform.admin' \
  -H 'x-forwarded-for: 10.9.9.9' https://wazuh.indexer:9200/_plugins/_security/authinfo
echo
