#!/usr/bin/env bash
# QAPAQ SecOps — pruebas de las políticas y del contenido de detección en un manager DESECHABLE
# (wazuh/wazuh-manager de wazuh/VERSION). No toca el manager real. docs/16-politicas.md.
#
#   bash infra/wazuh/policies/tests/run-policy-tests.sh
#
#   1. Unit: render_ossec_policy.py (idempotencia, AR apagado/encendido) y check_rule_ids.py.
#   2. Manager desechable: apply-agent-groups.sh y apply-manager-policy.sh con
#      QAPAQ_AR_AUTO_BLOCK=1 (la variante encendida también debe validar y arrancar) y luego =0.
#   3. wazuh-logtest de cada módulo con reglas (office365, active-directory, launch-detections)
#      más los validadores Python de endpoint, catálogo de lanzamiento y perfil AD.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
export MSYS_NO_PATHCONV=1 PYTHONIOENCODING=utf-8
version="$(tr -d '\r\n ' <"$root/wazuh/VERSION" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
version="${version:-4.14.8}"
name="qapaq-policy-test-$$"
py="$(for p in python3 python; do "$p" -c 'import sys' >/dev/null 2>&1 && { echo "$p"; break; }; done)"
hp() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
pass=0; fail=0
ok() { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
ko() { fail=$((fail + 1)); printf 'FAIL  %s\n' "$1"; }
run() { local label="$1"; shift; if "$@" >"$tmp/log" 2>&1; then ok "$label"; else ko "$label"; sed 's/^/      /' "$tmp/log" | tail -25; fi; }
tmp="$(mktemp -d)"
cleanup() { docker rm -f "$name" >/dev/null 2>&1; rm -rf "$tmp"; }
trap cleanup EXIT

# --- 1. unit ---------------------------------------------------------------------
pol="$root/wazuh/manager/policy"
unit_render() {
  local c="$tmp/ossec.conf"
  cat >"$c" <<'XML'
<ossec_config>
  <global><email_notification>yes</email_notification></global>
  <alerts><log_alert_level>1</log_alert_level></alerts>
  <vulnerability-detection><enabled>no</enabled></vulnerability-detection>
  <indexer><enabled>no</enabled></indexer>
  <!-- <active-response><command>x</command></active-response> -->
  <ruleset><rule_dir>etc/rules</rule_dir></ruleset>
</ossec_config>
XML
  "$py" "$(hp "$pol/render_ossec_policy.py")" "$(hp "$c")" "$(hp "$pol/../ossec.qapaq-policy.xml.tmpl")" | grep -qx changed || return 1
  "$py" "$(hp "$pol/render_ossec_policy.py")" "$(hp "$c")" "$(hp "$pol/../ossec.qapaq-policy.xml.tmpl")" | grep -qx unchanged || return 2
  "$py" "$(hp "$pol/render_ossec_policy.py")" "$(hp "$c")" "$(hp "$pol/../ossec.qapaq-policy.xml.tmpl")" --check || return 3
  grep -q '<email_notification>no' "$c" && grep -q '<log_alert_level>3' "$c" || return 4
  grep -q '<index-status>yes' "$c" && grep -A1 '<indexer>' "$c" | grep -q 'yes' || return 5
  grep -q '<list>etc/lists/qapaq-break-glass</list>' "$c" || return 6
  # AR: apagado = sin bloque activo; encendido = exactamente uno.
  [[ "$("$py" -c 'import re,sys;t=open(sys.argv[1]).read();print(len(re.findall(r"<active-response>",re.sub(r"<!--.*?-->","",t,flags=re.S))))' "$(hp "$c")")" == 0 ]] || return 7
  QAPAQ_AR_AUTO_BLOCK=1 "$py" "$(hp "$pol/render_ossec_policy.py")" "$(hp "$c")" "$(hp "$pol/../ossec.qapaq-policy.xml.tmpl")" >/dev/null
  [[ "$("$py" -c 'import re,sys;t=open(sys.argv[1]).read();print(len(re.findall(r"<active-response>",re.sub(r"<!--.*?-->","",t,flags=re.S))))' "$(hp "$c")")" == 1 ]] || return 8
  ! QAPAQ_AR_WHITELIST='no-es-ip' "$py" "$(hp "$pol/render_ossec_policy.py")" "$(hp "$c")" "$(hp "$pol/../ossec.qapaq-policy.xml.tmpl")" >/dev/null 2>&1 || return 9
}
run 'unit: render_ossec_policy (idempotente, VD, correo, umbral, AR opt-in, validación)' unit_render
unit_ids() {
  local d="$tmp/ids"; mkdir -p "$d"
  printf '<group name="a,"><rule id="100900" level="3"><match>x</match></rule></group>\n' >"$d/a.xml"
  printf '<group name="b,"><rule id="100900" level="3"><match>y</match></rule></group>\n' >"$d/b.xml"
  printf '<group name="c,"><rule id="5712" level="3"><match>y</match></rule></group>\n' >"$d/c.xml"
  ! "$py" "$(hp "$pol/check_rule_ids.py")" "$(hp "$d/a.xml")" "$(hp "$d/b.xml")" >/dev/null || return 1
  ! "$py" "$(hp "$pol/check_rule_ids.py")" "$(hp "$d/c.xml")" >/dev/null || return 2
  "$py" "$(hp "$pol/check_rule_ids.py")" "$(hp "$d/a.xml")" >/dev/null || return 3
}
run 'unit: check_rule_ids detecta duplicados y IDs fuera de rango' unit_ids
mapfile -t rule_files < <(ls "$root"/wazuh/office365/rules/*.xml "$root"/infra/wazuh/*/rules/*.xml)
hp_rules=(); for f in "${rule_files[@]}"; do hp_rules+=("$(hp "$f")"); done
run "reglas QAPAQ del repo sin colisiones (${#rule_files[@]} archivos)" "$py" "$(hp "$pol/check_rule_ids.py")" "${hp_rules[@]}"

# --- 2. manager desechable -----------------------------------------------------------
echo "... arrancando wazuh/wazuh-manager:$version desechable ($name)"
docker run -d --name "$name" "wazuh/wazuh-manager:$version" >/dev/null || { ko 'docker run'; exit 1; }
for _ in $(seq 1 90); do
  docker exec "$name" /var/ossec/bin/wazuh-control status 2>/dev/null | grep -q 'wazuh-analysisd is running' && break
  sleep 2
done
run 'manager desechable en ejecución' sh -c "docker exec $name /var/ossec/bin/wazuh-control status | grep -q 'wazuh-analysisd is running'"
export QAPAQ_MANAGER_CONTAINER="$name" QAPAQ_PERSIST_MOUNT=0
run 'apply-agent-groups.sh (5 grupos, verify-agent-conf)' bash "$pol/apply-agent-groups.sh"
run 'apply-agent-groups.sh idempotente' sh -c "bash '$pol/apply-agent-groups.sh' | grep -q 'actualizados: 0'"
run 'apply-manager-policy.sh con QAPAQ_AR_AUTO_BLOCK=1 (valida y arranca)' env QAPAQ_AR_AUTO_BLOCK=1 bash "$pol/apply-manager-policy.sh"
run 'ossec.conf con auto-block: exactamente un <active-response> activo' sh -c \
  "docker exec $name cat /var/ossec/etc/ossec.conf | sed 's/<!--.*-->//' | grep -q '<!-- QAPAQ:ar-auto-block:enabled'"
run 'apply-manager-policy.sh con QAPAQ_AR_AUTO_BLOCK=0 (default)' bash "$pol/apply-manager-policy.sh"
run 'apply-manager-policy.sh idempotente (sin reinicio)' sh -c "bash '$pol/apply-manager-policy.sh' | grep -q 'sin cambios ni reinicio'"

# --- 3. logtest por módulo -----------------------------------------------------------
# La prueba de Office 365 usa la lista break-glass de ejemplo (identidades ficticias).
docker cp "$(hp "$root/wazuh/office365/lists/qapaq-break-glass.example")" "$name:/var/ossec/etc/lists/qapaq-break-glass" >/dev/null
docker exec -u 0 "$name" sh -c 'chown wazuh:wazuh /var/ossec/etc/lists/qapaq-break-glass; /var/ossec/bin/wazuh-control restart >/dev/null 2>&1; sleep 8'
run 'logtest office365 (wazuh/office365/tests)' bash "$root/wazuh/office365/tests/run-logtest.sh" "$name"
run 'logtest active-directory (infra/wazuh/active-directory/tests)' bash "$root/infra/wazuh/active-directory/tests/run-logtest.sh" "$name"
run 'logtest launch-detections (infra/wazuh/launch-detections/tests)' bash "$root/infra/wazuh/launch-detections/tests/run-logtest.sh" "$name"
run 'endpoint: validate-fixtures.py' "$py" "$(hp "$root/infra/wazuh/endpoint/tests/validate-fixtures.py")"
run 'launch-detections: validate_catalog.py' "$py" "$(hp "$root/infra/wazuh/launch-detections/validate_catalog.py")"
run 'active-directory: test_profile_catalog.py' "$py" -m unittest discover -s "$(hp "$root/infra/wazuh/active-directory/tests")" -p 'test_profile_catalog.py'

printf '\nResumen pruebas: %d PASS · %d FAIL\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
