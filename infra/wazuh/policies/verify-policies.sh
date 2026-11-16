#!/usr/bin/env bash
# QAPAQ SecOps — verificación de políticas: imprime PASS/FAIL/WARN por política (docs/16-politicas.md).
# Solo lectura: no cambia nada en el manager ni en el indexer. Sale 1 si hay algún FAIL.
#
#   bash infra/wazuh/policies/verify-policies.sh
#
# Variables: las de wazuh/manager/policy/lib.sh, más QAPAQ_AR_AUTO_BLOCK (0) y
# QAPAQ_LOG_ALERT_LEVEL (3) con los valores ESPERADOS.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../wazuh/manager/policy/lib.sh
source "$here/../../../wazuh/manager/policy/lib.sh"
POL="$QAPAQ_REPO_ROOT/wazuh/manager/policy"
M="$(qapaq_manager)"
expect_ar="${QAPAQ_AR_AUTO_BLOCK:-0}"
expect_level="${QAPAQ_LOG_ALERT_LEVEL:-3}"
printf 'QAPAQ · verificación de políticas · manager=%s indexer=%s · %s\n\n' \
  "$M" "$(qapaq_indexer_container)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ---------------------------------------------------------------- manager
st="$(qapaq_mexec /var/ossec/bin/wazuh-control status 2>&1 || true)"
for d in wazuh-analysisd wazuh-modulesd wazuh-remoted wazuh-syscheckd; do
  grep -q "$d is running" <<<"$st" && qapaq_check PASS "manager.$d" 'en ejecución' ||
    qapaq_check FAIL "manager.$d" 'detenido'
done

conf="$QAPAQ_WORK/ossec.conf"
docker cp "$M:/var/ossec/etc/ossec.conf" "$(qapaq_hp "$conf")" >/dev/null
# Vista de ossec.conf sin comentarios para no contar configuración comentada.
qapaq_python - "$conf" "$QAPAQ_WORK/active.conf" <<'PY'
import re, sys
t = open(sys.argv[1], encoding="utf-8").read()
open(sys.argv[2], "w", encoding="utf-8").write(re.sub(r"<!--.*?-->", "", t, flags=re.S))
PY
active="$QAPAQ_WORK/active.conf"
blk() { sed -n "/<$1>/,/<\/$1>/p" "$active"; }

if qapaq_python "$POL/render_ossec_policy.py" "$conf" "$POL/../ossec.qapaq-policy.xml.tmpl" --check >/dev/null; then
  qapaq_check PASS manager.ossec_policy 'ossec.conf coincide con la plantilla QAPAQ (bloque QAPAQ:policy)'
else
  qapaq_check FAIL manager.ossec_policy 'ossec.conf difiere de la política: correr apply-manager-policy.sh'
fi
vd="$(blk vulnerability-detection)"
if grep -q '<enabled>yes</enabled>' <<<"$vd" && grep -q '<index-status>yes</index-status>' <<<"$vd"; then
  qapaq_check PASS manager.vulnerability_detection "habilitada ($(grep -o '<feed-update-interval>[^<]*' <<<"$vd" | cut -d'>' -f2) de feed, index-status)"
else
  qapaq_check FAIL manager.vulnerability_detection 'deshabilitada o sin index-status'
fi
grep -q '<enabled>yes</enabled>' <<<"$(blk indexer)" && qapaq_check PASS manager.indexer_connector 'conector <indexer> habilitado' ||
  qapaq_check FAIL manager.indexer_connector '<indexer> deshabilitado'
grep -q '<enabled>yes</enabled>' <<<"$(blk sca)" && qapaq_check PASS manager.sca 'SCA del propio manager habilitado' ||
  qapaq_check FAIL manager.sca 'SCA del manager deshabilitado'
lvl="$(blk alerts | grep -o '<log_alert_level>[0-9]*' | head -1 | cut -d'>' -f2)"
[[ "$lvl" == "$expect_level" ]] && qapaq_check PASS manager.log_alert_level "$lvl" ||
  qapaq_check FAIL manager.log_alert_level "es '$lvl', se espera $expect_level"
grep -q '<email_notification>yes' "$active" && qapaq_check FAIL manager.email_off 'email_notification=yes' ||
  qapaq_check PASS manager.email_off 'correo de Wazuh apagado (avisos por el notificador QAPAQ)'

ar_blocks="$(grep -c '<active-response>' "$active" || true)"
if [[ "$expect_ar" == 1 ]]; then
  if [[ "$ar_blocks" == 1 ]] && blk active-response | grep -q '<command>firewall-drop</command>' &&
    blk active-response | grep -q '<timeout>'; then
    qapaq_check PASS manager.active_response 'auto-block ENCENDIDO por flag: firewall-drop temporal, reglas 5712/5763'
  else
    qapaq_check FAIL manager.active_response "se esperaba solo el auto-block QAPAQ (bloques activos: $ar_blocks)"
  fi
else
  [[ "$ar_blocks" == 0 ]] && qapaq_check PASS manager.active_response_off 'ninguna respuesta automática activa (default; aprobación vía Ankay)' ||
    qapaq_check FAIL manager.active_response_off "$ar_blocks bloque(s) <active-response> activos sin QAPAQ_AR_AUTO_BLOCK=1"
fi
grep -q '<list>etc/lists/qapaq-break-glass</list>' "$active" && qapaq_check PASS manager.ruleset_lists 'lista qapaq-break-glass declarada' ||
  qapaq_check FAIL manager.ruleset_lists 'falta <list>etc/lists/qapaq-break-glass</list>'

# --- grupos de agentes ---
groups="$(qapaq_mexec /var/ossec/bin/agent_groups -l 2>/dev/null || true)"
for dir in "$POL"/shared/*/; do
  g="$(basename "$dir")"
  if ! grep -qE "^\s*$g \(" <<<"$groups"; then qapaq_check FAIL "agent_group.$g" 'no existe'; continue; fi
  want="$(tr -d '\r' <"$dir/agent.conf" | sha256sum | cut -c1-64)"
  have="$(qapaq_mexec sh -c "sha256sum < /var/ossec/etc/shared/$g/agent.conf" 2>/dev/null | cut -c1-64)"
  n="$(grep -oE "^\s*$g \([0-9]+\)" <<<"$groups" | grep -oE '[0-9]+')"
  if [[ "$want" != "$have" ]]; then qapaq_check FAIL "agent_group.$g" 'agent.conf distinto del repo'; continue; fi
  if ! qapaq_mexec /var/ossec/bin/verify-agent-conf -f "/var/ossec/etc/shared/$g/agent.conf" 2>&1 | grep -q 'verify-agent-conf: OK'; then
    qapaq_check FAIL "agent_group.$g" 'verify-agent-conf falla'; continue
  fi
  qapaq_check PASS "agent_group.$g" "existe, agent.conf = repo y válido ($n agentes)"
done
# Contenido mínimo de cada perfil (FIM, SCA, rootcheck, inventario).
for g in linux-servers windows-servers windows-workstations; do
  f="$POL/shared/$g/agent.conf"
  miss=()
  grep -q '<syscheck>' "$f" && grep -q '<disabled>no</disabled>' "$f" || miss+=(fim)
  sed -n '/<sca>/,/<\/sca>/p' "$f" | grep -q '<enabled>yes</enabled>' || miss+=(sca)
  sed -n '/<rootcheck>/,/<\/rootcheck>/p' "$f" | grep -q '<disabled>no</disabled>' || miss+=(rootcheck)
  sed -n '/<wodle name="syscollector">/,/<\/wodle>/p' "$f" | grep -q '<packages>yes</packages>' || miss+=(syscollector)
  grep -q '<localfile>' "$f" || miss+=(logs)
  [[ ${#miss[@]} == 0 ]] && qapaq_check PASS "policy.$g" 'FIM + SCA (CIS) + rootcheck + syscollector(paquetes) + logs' ||
    qapaq_check FAIL "policy.$g" "falta: ${miss[*]}"
done
if [[ -z "$(grep -oE '^\s*windows-telemetry-extended \(([1-9][0-9]*)\)' <<<"$groups")" ]]; then
  qapaq_check PASS policy.telemetry_extended_gate 'grupo opt-in sin agentes (gate de privacidad Sysmon/PowerShell)'
else
  qapaq_check WARN policy.telemetry_extended_gate 'hay agentes asignados: confirmar aprobación de privacidad registrada'
fi

# --- reglas ---
mapfile -t rule_files < <(ls "$QAPAQ_REPO_ROOT"/wazuh/office365/rules/*.xml "$QAPAQ_REPO_ROOT"/infra/wazuh/*/rules/*.xml)
drift=()
for f in "${rule_files[@]}"; do
  n="$(basename "$f")"
  want="$(tr -d '\r' <"$f" | sha256sum | cut -c1-64)"
  have="$(qapaq_mexec sh -c "sha256sum < /var/ossec/etc/rules/$n" 2>/dev/null | cut -c1-64)"
  [[ "$want" == "$have" ]] || drift+=("$n")
done
[[ ${#drift[@]} == 0 ]] && qapaq_check PASS rules.installed "${#rule_files[@]} archivos QAPAQ instalados = repo" ||
  qapaq_check FAIL rules.installed "distintos o ausentes: ${drift[*]}"
if qapaq_python "$POL/check_rule_ids.py" "${rule_files[@]}" >"$QAPAQ_WORK/ids.txt"; then
  qapaq_check PASS rules.id_collisions "$(tail -1 "$QAPAQ_WORK/ids.txt")"
else
  qapaq_check FAIL rules.id_collisions "$(grep -v reglas "$QAPAQ_WORK/ids.txt" | tr '\n' ';')"
fi
qapaq_mexec /var/ossec/bin/wazuh-analysisd -t >/dev/null 2>&1 && qapaq_check PASS rules.load 'wazuh-analysisd -t carga el ruleset completo' ||
  qapaq_check FAIL rules.load 'wazuh-analysisd -t falla'
# Humo con wazuh-logtest: un evento sintético del contrato qapaq-provider debe disparar 101201.
smoke='{"integration":"qapaq-provider","qapaq_vendor":"sophos","qapaq_event_type":"threat_detected","qapaq_severity":"critical","qapaq_status":"active","qapaq_endpoint_id":"endpoint-lab-01","qapaq_source_record_id":"verify-smoke-001"}'
out="$(printf '%s\n' "$smoke" | docker exec -i "$M" /var/ossec/bin/wazuh-logtest 2>&1 || true)"
grep -q "id: '101201'" <<<"$out" && qapaq_check PASS rules.logtest_smoke 'wazuh-logtest: evento sintético → regla QAPAQ 101201' ||
  qapaq_check FAIL rules.logtest_smoke 'wazuh-logtest no disparó 101201'

# ---------------------------------------------------------------- indexer
qapaq_indexer GET /_cluster/health
if [[ "$INDEXER_STATUS" != 200 ]]; then
  qapaq_check FAIL indexer.reachable "HTTP $INDEXER_STATUS"
else
  h="$(qapaq_json "$INDEXER_BODY" 'd["status"]')"
  [[ "$h" == green ]] && qapaq_check PASS indexer.health green || qapaq_check WARN indexer.health "$h"
fi
declare -A pol_pat=(
  [qapaq-wazuh-alerts-90d]='wazuh-alerts-*'
  [qapaq-wazuh-monitoring-15d]='wazuh-monitoring-*,wazuh-statistics-*'
  [qapaq-wazuh-archives-7d]='wazuh-archives-*'
)
for id in qapaq-wazuh-alerts-90d qapaq-wazuh-monitoring-15d qapaq-wazuh-archives-7d; do
  qapaq_indexer GET "/_plugins/_ism/policies/$id"
  if [[ "$INDEXER_STATUS" != 200 ]]; then qapaq_check FAIL "ism.policy.$id" 'no existe'; continue; fi
  ages="$(qapaq_json "$INDEXER_BODY" '",".join(t["conditions"]["min_index_age"] for s in d["policy"]["states"] for t in s.get("transitions", []))')"
  qapaq_check PASS "ism.policy.$id" "existe (borrado a $ages, template ${pol_pat[$id]})"
  IFS=',' read -ra pats <<<"${pol_pat[$id]}"
  for pat in "${pats[@]}"; do
    qapaq_indexer GET "/_plugins/_ism/explain/$pat"
    res="$(qapaq_python - "$INDEXER_BODY" "$id" <<'PY'
import json, sys
d, want = json.load(open(sys.argv[1], encoding="utf-8")), sys.argv[2]
K = ("index.plugins.index_state_management.policy_id", "index.opendistro.index_state_management.policy_id")
idx = {k: v for k, v in d.items() if isinstance(v, dict) and any(x in v for x in K)}
pid = lambda v: v.get(K[0]) or v.get(K[1])
bad = [k for k, v in idx.items() if pid(v) != want]
print(f"{len(idx)} {len(bad)} {' '.join(sorted(bad)[:5])}")
PY
)"
    read -r total nbad rest <<<"$res"
    if [[ "${total:-0}" == 0 ]]; then
      qapaq_check PASS "ism.attached.$pat" 'sin índices aún (el ism_template los cubrirá al crearse)'
    elif [[ "$nbad" == 0 ]]; then
      qapaq_check PASS "ism.attached.$pat" "$total/$total índices gestionados por $id"
    else
      qapaq_check FAIL "ism.attached.$pat" "$nbad/$total sin $id: $rest"
    fi
  done
done
qapaq_indexer GET /_snapshot
repos="$(qapaq_json "$INDEXER_BODY" '",".join(sorted(d)) if isinstance(d, dict) else ""')"
[[ -n "$repos" ]] && qapaq_check PASS indexer.snapshot_repo "$repos" ||
  qapaq_check WARN indexer.snapshot_repo 'sin repositorio (sin IAM/S3): respaldo = snapshot EBS del volumen (docs/16)'

# --- seguridad (roles QAPAQ = repo, mínimo privilegio) ---
qapaq_indexer GET /_plugins/_security/api/roles
cp "$INDEXER_BODY" "$QAPAQ_WORK/roles.json"
qapaq_indexer GET /_plugins/_security/api/rolesmapping
cp "$INDEXER_BODY" "$QAPAQ_WORK/mapping.json"
qapaq_python - "$QAPAQ_REPO_ROOT/wazuh/indexer/security/roles.qapaq.yml" "$QAPAQ_REPO_ROOT/wazuh/indexer/security/roles_mapping.qapaq.yml" \
  "$QAPAQ_WORK/roles.json" "$QAPAQ_WORK/mapping.json" <<'PY' >"$QAPAQ_WORK/sec.txt"
import json, sys
try:
    import yaml
except ImportError:
    print("FAIL|security.parse|falta PyYAML en el host (apt-get install python3-yaml)"); sys.exit()
want_roles = {k: v for k, v in yaml.safe_load(open(sys.argv[1], encoding="utf-8")).items() if k != "_meta"}
want_map = {k: v for k, v in yaml.safe_load(open(sys.argv[2], encoding="utf-8")).items() if k != "_meta"}
roles = json.load(open(sys.argv[3], encoding="utf-8"))
mapping = json.load(open(sys.argv[4], encoding="utf-8"))
WRITE = ("write", "delete", "manage", "crud", "create_index", "indices:data/write", "indices:admin/create",
         "indices:admin/delete", "cluster_all", "indices_all", "*")
def norm_idx(perms):
    return sorted((tuple(sorted(p.get("index_patterns", []))), tuple(sorted(p.get("allowed_actions", [])))) for p in perms or [])
for name, w in want_roles.items():
    live = roles.get(name)
    if live is None:
        print(f"FAIL|security.role.{name}|no existe en el indexer"); continue
    same = (norm_idx(w.get("index_permissions")) == norm_idx(live.get("index_permissions"))
            and sorted(w.get("cluster_permissions", [])) == sorted(live.get("cluster_permissions", [])))
    acts = [a for p in live.get("index_permissions", []) for a in p.get("allowed_actions", [])]
    acts += live.get("cluster_permissions", [])
    risky = [a for a in acts if any(x == a or (x.endswith("/") and a.startswith(x)) or a.startswith(x + "/") or a == x for x in WRITE)]
    pats = [i for p in live.get("index_permissions", []) for i in p.get("index_patterns", [])]
    if not same:
        print(f"FAIL|security.role.{name}|difiere de roles.qapaq.yml")
    elif risky or "*" in pats:
        print(f"FAIL|security.role.{name}|acciones de escritura/administración: {risky or pats}")
    else:
        print(f"PASS|security.role.{name}|= repo, solo lectura sobre {', '.join(sorted(set(pats)))}")
# Separación: analista y auditor no leen la telemetría cruda.
for name in ("qapaq_soc_analyst", "qapaq_auditor", "qapaq_reader_role"):
    pats = [i for p in roles.get(name, {}).get("index_permissions", []) for i in p.get("index_patterns", [])]
    bad = [p for p in pats if p.startswith("wazuh-archives") or p in ("*", "wazuh-*")]
    print(("FAIL" if bad else "PASS") + f"|security.no_raw.{name}|" + (f"lee {bad}" if bad else "sin acceso a wazuh-archives-*"))
for name, w in want_map.items():
    live = mapping.get(name)
    if live is None:
        print(f"FAIL|security.mapping.{name}|no existe"); continue
    miss = [r for r in w.get("backend_roles", []) if r not in live.get("backend_roles", [])]
    miss += [u for u in w.get("users", []) if u not in live.get("users", [])]
    extra = [r for r in live.get("backend_roles", []) if r not in w.get("backend_roles", [])]
    if miss:
        print(f"FAIL|security.mapping.{name}|faltan {miss}")
    elif extra and name == "all_access":
        print(f"WARN|security.mapping.{name}|backend_roles extra {extra} (default de wazuh-docker; el edge borra x-proxy-roles del cliente)")
    elif extra:
        print(f"WARN|security.mapping.{name}|backend_roles extra {extra}")
    else:
        print(f"PASS|security.mapping.{name}|{w.get('backend_roles', []) + w.get('users', [])}")
PY
while IFS='|' read -r s id detail; do [[ -n "$s" ]] && qapaq_check "$s" "$id" "$detail"; done <"$QAPAQ_WORK/sec.txt"

printf '\nResumen: %d PASS · %d FAIL · %d WARN\n' "$QAPAQ_PASS" "$QAPAQ_FAIL" "$QAPAQ_WARN"
[[ "$QAPAQ_FAIL" == 0 ]]
