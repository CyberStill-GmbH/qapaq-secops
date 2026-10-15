#!/usr/bin/env bash
# QAPAQ SecOps — Security plugin del Indexer: proxy auth y roles QAPAQ (docs/04). Idempotente.
#
#   1. Backup completo de la configuración de seguridad viva (securityadmin -backup) en
#      /var/backups/qapaq-security/<fecha>. Es la vuelta atrás.
#   2. config: FUSIONA (no reemplaza) en el config.yml vivo el dominio qapaq_proxy_auth_domain y
#      el bloque xff de config.qapaq.yml; conserva el resto (basic interno, kibana, etc.) y lo
#      sube con securityadmin -t config.
#   3. roles: crea o actualiza por REST cada rol de roles.qapaq.yml (no toca los demás roles).
#   4. rolesmapping: fusiona backend_roles/users/hosts QAPAQ con el backup vivo y carga el YAML
#      completo con securityadmin. Esto conserva todos los mapeos y permite actualizar recursos
#      reservados como all_access, que la REST API rechaza.
#   5. Autoprueba: admin por basic sigue entrando y el proxy auth desde 127.0.0.1 resuelve
#      qapaq.soc.analyst. Si algo falla, restaura el backup y sale con error.
#
# Variables (solo pruebas locales): QAPAQ_INDEXER_URL, QAPAQ_INDEXER_CA, QAPAQ_INDEXER_ADMIN_PASSWORD.
set -euo pipefail
umask 077
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { printf 'qapaq-security: ERROR %s\n' "$1" >&2; exit 1; }
info() { printf 'qapaq-security: %s\n' "$1"; }
# shellcheck source=../../scripts/indexer-admin.sh
source "$here/../../scripts/indexer-admin.sh"

python3 -c 'import yaml' 2>/dev/null ||
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-yaml >/dev/null ||
  fail 'falta python3-yaml'

TOOLS=/usr/share/wazuh-indexer/plugins/opensearch-security/tools
CERTS=/etc/wazuh-indexer/certs
export JAVA_HOME=/usr/share/wazuh-indexer/jdk
secadmin() {
  bash "$TOOLS/securityadmin.sh" "$@" -icl -nhnv -h 127.0.0.1 \
    -cacert "$CERTS/root-ca.pem" -cert "$CERTS/admin.pem" -key "$CERTS/admin-key.pem" >"$_qapaq_work/secadmin.log" 2>&1
}

# 1 · backup
backup="/var/backups/qapaq-security/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup"
secadmin -backup "$backup" || fail "backup falló (ver $_qapaq_work/secadmin.log)"
[[ -s "$backup/config.yml" ]] || fail 'backup sin config.yml'
info "backup en $backup"
restore() {
  info 'restaurando backup…'
  secadmin -cd "$backup" || printf 'qapaq-security: ERROR la restauración falló; backup en %s\n' "$backup" >&2
}

# 2 · config fusionado
python3 - "$backup/config.yml" "$here/config.qapaq.yml" "$_qapaq_work/config.yml" <<'PY'
import sys, yaml
live_path, ours_path, out_path = sys.argv[1:4]
live = yaml.safe_load(open(live_path, encoding='utf-8'))
ours = yaml.safe_load(open(ours_path, encoding='utf-8'))
dyn = live.setdefault('config', {}).setdefault('dynamic', {})
dyn.setdefault('http', {}).update(ours['config']['dynamic']['http'])
authc = dyn.setdefault('authc', {})
authc['qapaq_proxy_auth_domain'] = ours['config']['dynamic']['authc']['qapaq_proxy_auth_domain']
# El basic interno sigue (servicios y break-glass) pero detrás del proxy auth.
if 'basic_internal_auth_domain' in authc:
    authc['basic_internal_auth_domain']['order'] = max(1, authc['basic_internal_auth_domain'].get('order', 1))
yaml.safe_dump(live, open(out_path, 'w', encoding='utf-8'), sort_keys=False)
PY
secadmin -f "$_qapaq_work/config.yml" -t config || { restore; fail 'subida de config falló'; }
info 'config: dominio de proxy auth activo (solo desde 127.0.0.1)'

# 3 y 4 · roles y mapeos por REST
python3 - "$here/roles.qapaq.yml" "$_qapaq_work" <<'PY'
import json, sys, yaml
roles_path, work = sys.argv[1:3]
doc = yaml.safe_load(open(roles_path, encoding='utf-8'))
for name, body in doc.items():
    if name == '_meta':
        continue
    body = {k: v for k, v in body.items() if k not in ('reserved', 'hidden', 'static')}
    json.dump(body, open(f'{work}/roles__{name}.json', 'w', encoding='utf-8'))
PY
for file in "$_qapaq_work"/roles__*.json; do
  name="$(basename "$file" .json)"; name="${name#roles__}"
  indexer PUT "/_plugins/_security/api/roles/$name" "$file"
  [[ "$INDEXER_STATUS" =~ ^20[01]$ ]] || { restore; fail "rol $name → HTTP $INDEXER_STATUS"; }
done
info 'roles QAPAQ aplicados'
[[ -s "$backup/roles_mapping.yml" ]] || { restore; fail 'backup sin roles_mapping.yml'; }
python3 - "$backup/roles_mapping.yml" "$here/roles_mapping.qapaq.yml" "$_qapaq_work/roles_mapping.yml" <<'PY'
import sys, yaml
live_path, ours_path, out_path = sys.argv[1:4]
live = yaml.safe_load(open(live_path, encoding='utf-8')) or {}
ours = yaml.safe_load(open(ours_path, encoding='utf-8')) or {}
if not isinstance(live, dict) or not isinstance(ours, dict):
    raise SystemExit('roles_mapping.yml debe contener un objeto YAML')
live.setdefault('_meta', ours.get('_meta', {}))
for name, incoming in ours.items():
    if name == '_meta':
        continue
    if not isinstance(incoming, dict):
        raise SystemExit(f'mapeo QAPAQ inválido: {name}')
    current = live.setdefault(name, {})
    if not isinstance(current, dict):
        raise SystemExit(f'mapeo vivo inválido: {name}')
    # Conserva flags y campos propios del mapeo vivo, incluidos reserved/hidden.
    for key in ('backend_roles', 'users', 'hosts'):
        before = current.get(key, []) or []
        add = incoming.get(key, []) or []
        if not isinstance(before, list) or not isinstance(add, list):
            raise SystemExit(f'{name}.{key} debe ser una lista')
        current[key] = sorted(set(before + add))
    if incoming.get('description'):
        current['description'] = incoming['description']
yaml.safe_dump(live, open(out_path, 'w', encoding='utf-8'), sort_keys=False)
PY
secadmin -f "$_qapaq_work/roles_mapping.yml" -t rolesmapping || { restore; fail 'subida de rolesmapping fusionados falló'; }
info 'mapeos QAPAQ unidos al backup vivo con securityadmin'

# 5 · autoprueba
indexer GET /_plugins/_security/authinfo
[[ "$INDEXER_STATUS" == 200 ]] || { restore; fail "admin por basic dejó de entrar (HTTP $INDEXER_STATUS)"; }
proxy_roles="$(curl -sS "${_qapaq_tls[@]}" -H 'x-proxy-user: qapaq-selftest' -H 'x-proxy-roles: qapaq.soc.analyst' \
  -H 'x-forwarded-for: 127.0.0.1' "$INDEXER_URL/_plugins/_security/authinfo" | jq -r '.roles // [] | join(",")' || true)"
[[ "$proxy_roles" == *qapaq_soc_analyst* ]] || { restore; fail "proxy auth no resolvió qapaq_soc_analyst (roles: '$proxy_roles')"; }
info "proxy auth OK (qapaq.soc.analyst → $proxy_roles)"
