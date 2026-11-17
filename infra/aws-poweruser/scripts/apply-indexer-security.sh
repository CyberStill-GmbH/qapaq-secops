#!/usr/bin/env bash
# Proxy auth QAPAQ en el indexer del nodo PowerUser (equivalente de wazuh/indexer/security/apply-security.sh
# para wazuh-docker): fusiona qapaq_proxy_auth_domain y xff de config.qapaq.yml en la config viva, crea
# los roles QAPAQ y fusiona sus mapeos. xff.internalProxies = SOLO la IP fija del contenedor del
# dashboard (172.30.89.10): ningún otro contenedor de la red puede afirmar identidad.
# Idempotente; backup previo en /opt/qapaq/backups/indexer-security/<fecha> (restaurar con securityadmin -cd).
# Se ejecuta EN el host como root. Requiere INDEXER_ADMIN_PASSWORD.
set -euo pipefail
: "${INDEXER_ADMIN_PASSWORD:?}"
SEC=/opt/qapaq/src/wazuh/indexer/security
C=qapaq-wazuh.indexer-1
DASHBOARD_IP='172\.30\.89\.10'

secadmin() {
  docker exec -e JAVA_HOME=/usr/share/wazuh-indexer/jdk "$C" bash \
    /usr/share/wazuh-indexer/plugins/opensearch-security/tools/securityadmin.sh "$@" -icl -nhnv -h 127.0.0.1 \
    -cacert /usr/share/wazuh-indexer/config/certs/root-ca.pem \
    -cert /usr/share/wazuh-indexer/config/certs/admin.pem \
    -key /usr/share/wazuh-indexer/config/certs/admin-key.pem
}

backup="/opt/qapaq/backups/indexer-security/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$backup"
docker exec "$C" rm -rf /tmp/qapaq-sec
docker exec "$C" mkdir -p /tmp/qapaq-sec/backup
secadmin -backup /tmp/qapaq-sec/backup >/dev/null
docker cp "$C:/tmp/qapaq-sec/backup/." "$backup"
[[ -s $backup/config.yml ]] || { echo 'backup sin config.yml' >&2; exit 1; }

DASHBOARD_IP="$DASHBOARD_IP" python3 - "$backup" "$SEC" <<'PY'
import os, sys, yaml
backup, sec = sys.argv[1:3]
live = yaml.safe_load(open(f'{backup}/config.yml'))
ours = yaml.safe_load(open(f'{sec}/config.qapaq.yml'))
dyn = live.setdefault('config', {}).setdefault('dynamic', {})
http = dict(ours['config']['dynamic']['http'])
http['xff'] = dict(http['xff'])
http['xff']['internalProxies'] = os.environ['DASHBOARD_IP']
dyn.setdefault('http', {}).update(http)
dyn.setdefault('kibana', {}).update(ours['config']['dynamic']['kibana'])
authc = dyn.setdefault('authc', {})
authc['qapaq_proxy_auth_domain'] = ours['config']['dynamic']['authc']['qapaq_proxy_auth_domain']
if 'basic_internal_auth_domain' in authc:
    authc['basic_internal_auth_domain']['order'] = max(1, authc['basic_internal_auth_domain'].get('order', 1))
yaml.safe_dump(live, open(f'{backup}/config.merged.yml', 'w'), sort_keys=False)

rm = yaml.safe_load(open(f'{backup}/roles_mapping.yml')) or {}
for name, inc in (yaml.safe_load(open(f'{sec}/roles_mapping.qapaq.yml')) or {}).items():
    if name == '_meta':
        continue
    cur = rm.setdefault(name, {})
    for key in ('backend_roles', 'users', 'hosts'):
        cur[key] = sorted(set((cur.get(key) or []) + (inc.get(key) or [])))
    if inc.get('description'):
        cur['description'] = inc['description']
yaml.safe_dump(rm, open(f'{backup}/roles_mapping.merged.yml', 'w'), sort_keys=False)

roles = yaml.safe_load(open(f'{backup}/roles.yml')) or {}
for name, body in (yaml.safe_load(open(f'{sec}/roles.qapaq.yml')) or {}).items():
    if name != '_meta':
        roles[name] = body
yaml.safe_dump(roles, open(f'{backup}/roles.merged.yml', 'w'), sort_keys=False)
PY

for f in config roles roles_mapping; do docker cp "$backup/$f.merged.yml" "$C:/tmp/qapaq-sec/$f.yml"; done
docker exec -u 0 "$C" chmod -R a+r /tmp/qapaq-sec
secadmin -f /tmp/qapaq-sec/roles.yml -t roles >/dev/null
secadmin -f /tmp/qapaq-sec/roles_mapping.yml -t rolesmapping >/dev/null
secadmin -f /tmp/qapaq-sec/config.yml -t config >/dev/null
docker exec "$C" rm -rf /tmp/qapaq-sec
echo 'config, roles y rolesmapping QAPAQ cargados'

# Autoprueba: admin por basic sigue entrando; x-proxy-user desde otra IP NO autentica.
code="$(docker exec "$C" curl -sk -o /dev/null -w '%{http_code}' -u "admin:$INDEXER_ADMIN_PASSWORD" \
  https://127.0.0.1:9200/_plugins/_security/authinfo)"
[[ $code == 200 ]] || { echo "basic admin → $code: restaurar con securityadmin -cd $backup" >&2; exit 1; }
spoof="$(docker run --rm --network qapaq_default curlimages/curl:8.17.0 -sk -o /dev/null -w '%{http_code}' \
  -H 'x-proxy-user: spoof' -H 'x-proxy-roles: qapaq.platform.admin' https://wazuh.indexer:9200/_plugins/_security/authinfo)"
[[ $spoof == 401 ]] || { echo "proxy auth aceptado desde una IP no confiable ($spoof)" >&2; exit 1; }
echo "autoprueba: basic admin 200, x-proxy-user desde otra IP $spoof"
