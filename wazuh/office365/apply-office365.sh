#!/usr/bin/env bash
# QAPAQ SecOps — aplica la integración Microsoft 365 → Wazuh en un manager 4.14.x.
#
# Qué hace, en este orden y de forma idempotente:
#   1. Valida entradas (GUIDs, tipo de API, fuentes de secretos).
#   2. Respalda ossec.conf, reglas y lista previas en $WAZUH_HOME/backup/qapaq-<ts>/.
#   3. Escribe el client secret en $WAZUH_HOME/etc/office365/client_secret (0640 root:wazuh).
#   4. Reemplaza el bloque <office365> entre marcadores QAPAQ (o lo agrega una sola vez).
#   5. Instala las reglas locales y la lista CDB de cuentas break-glass, y registra la lista.
#   6. Valida con wazuh-analysisd -t. Si falla, restaura el respaldo y termina con error.
#   7. Reinicia el manager y muestra las líneas del módulo office365 posteriores al reinicio.
#
# Nunca imprime secretos. Ejecutarlo dos veces con las mismas entradas deja el mismo estado.
#
# Entradas (variables de entorno):
#   QAPAQ_O365_TENANT_ID       GUID del tenant (obligatorio)
#   QAPAQ_O365_CLIENT_ID       GUID de la app con ActivityFeed.Read (obligatorio)
#   QAPAQ_O365_SECRET_SOURCE   file:<ruta> (obligatorio en apply; el host lo materializa desde Key Vault)
#   QAPAQ_BREAK_GLASS_SOURCE   file:<ruta> (opcional; lista UPN separada por comas o líneas)
#   QAPAQ_O365_API_TYPE        commercial | gcc | gcc-high (por defecto commercial)
#   QAPAQ_O365_ENABLE_DLP      true | false (por defecto false; requiere ActivityFeed.ReadDlp)
#   QAPAQ_WAZUH_HOME           por defecto /var/ossec
#   QAPAQ_APPLY_MODE           apply | render (render solo valida y muestra el bloque, sin tocar nada)
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly WAZUH_HOME="${QAPAQ_WAZUH_HOME:-/var/ossec}"
readonly MODE="${QAPAQ_APPLY_MODE:-apply}"
readonly API_TYPE="${QAPAQ_O365_API_TYPE:-commercial}"
readonly ENABLE_DLP="${QAPAQ_O365_ENABLE_DLP:-false}"
readonly RULES_NAME='qapaq_office365_rules.xml'
readonly LIST_NAME='qapaq-break-glass'
readonly GUID_PATTERN='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

phase='validate'
fail() {
  echo "QAPAQ office365: falló en la fase '${phase}': $*" >&2
  exit 1
}

# ---------------------------------------------------------------- 1. Entradas
[[ "${MODE}" == apply || "${MODE}" == render ]] || fail 'QAPAQ_APPLY_MODE debe ser apply o render.'
[[ "${QAPAQ_O365_TENANT_ID:-}" =~ ${GUID_PATTERN} ]] || fail 'QAPAQ_O365_TENANT_ID no es un GUID.'
[[ "${QAPAQ_O365_CLIENT_ID:-}" =~ ${GUID_PATTERN} ]] || fail 'QAPAQ_O365_CLIENT_ID no es un GUID.'
case "${API_TYPE}" in commercial | gcc | gcc-high) ;; *) fail 'QAPAQ_O365_API_TYPE inválido.' ;; esac
case "${ENABLE_DLP}" in true | false) ;; *) fail 'QAPAQ_O365_ENABLE_DLP debe ser true o false.' ;; esac
[[ -f "${SCRIPT_DIR}/rules/${RULES_NAME}" ]] || fail 'no se encontró el archivo de reglas junto al script.'

# Lee un secreto de la fuente declarada y lo escribe en $2 sin pasar por stdout ni argv.
# Solo archivos: en Azure el bootstrap del SIEM los escribe desde Key Vault con la identidad de
# la VM, y el bundle no debe llevar rutas hacia otros proveedores de nube.
read_secret_to() {
  local source="$1" target="$2"
  case "${source}" in
    file:*)
      local path="${source#file:}"
      [[ -f "${path}" ]] || return 1
      cat -- "${path}" >"${target}"
      ;;
    *) return 1 ;;
  esac
  # Un salto de línea final rompería la autenticación; Wazuh lee el archivo tal cual.
  local value
  value="$(<"${target}")"
  printf '%s' "${value}" >"${target}"
  [[ -s "${target}" ]]
}

render_block() {
  local dlp=''
  if [[ "${ENABLE_DLP}" == true ]]; then
    dlp='    <subscription>DLP.All</subscription>\n'
  fi
  sed -e "s/__TENANT_ID__/${QAPAQ_O365_TENANT_ID,,}/" \
    -e "s/__CLIENT_ID__/${QAPAQ_O365_CLIENT_ID,,}/" \
    -e "s/__API_TYPE__/${API_TYPE}/" \
    -e "s#__DLP_SUBSCRIPTION__#${dlp}#" \
    "${SCRIPT_DIR}/ossec-office365.xml.tmpl"
}

if [[ "${MODE}" == render ]]; then
  render_block
  echo 'QAPAQ office365: render correcto; no se modificó nada.'
  exit 0
fi

[[ -n "${QAPAQ_O365_SECRET_SOURCE:-}" ]] || fail 'QAPAQ_O365_SECRET_SOURCE es obligatorio.'
[[ "$(id -u)" -eq 0 ]] || fail 'debe ejecutarse como root.'
[[ -x "${WAZUH_HOME}/bin/wazuh-analysisd" ]] || fail "no hay un manager Wazuh en ${WAZUH_HOME}."
command -v python3 >/dev/null || fail 'python3 es necesario para editar ossec.conf de forma segura.'

work="$(mktemp -d /dev/shm/qapaq-o365.XXXXXX 2>/dev/null || mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# ---------------------------------------------------------------- 2. Respaldo
phase='backup'
readonly CONF="${WAZUH_HOME}/etc/ossec.conf"
readonly RULES_TARGET="${WAZUH_HOME}/etc/rules/${RULES_NAME}"
readonly LIST_TARGET="${WAZUH_HOME}/etc/lists/${LIST_NAME}"
readonly SECRET_DIR="${WAZUH_HOME}/etc/office365"
readonly SECRET_TARGET="${SECRET_DIR}/client_secret"
backup="${WAZUH_HOME}/backup/qapaq-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "${backup}"
cp -p "${CONF}" "${backup}/ossec.conf"
[[ -f "${RULES_TARGET}" ]] && cp -p "${RULES_TARGET}" "${backup}/${RULES_NAME}"
[[ -f "${LIST_TARGET}" ]] && cp -p "${LIST_TARGET}" "${backup}/${LIST_NAME}"
[[ -f "${SECRET_TARGET}" ]] && cp -p "${SECRET_TARGET}" "${backup}/client_secret"
chmod 700 "${backup}"

restore() {
  echo 'QAPAQ office365: restaurando el estado previo.' >&2
  cp -p "${backup}/ossec.conf" "${CONF}"
  if [[ -f "${backup}/${RULES_NAME}" ]]; then cp -p "${backup}/${RULES_NAME}" "${RULES_TARGET}"; else rm -f "${RULES_TARGET}"; fi
  if [[ -f "${backup}/${LIST_NAME}" ]]; then cp -p "${backup}/${LIST_NAME}" "${LIST_TARGET}"; else rm -f "${LIST_TARGET}" "${LIST_TARGET}.cdb"; fi
  if [[ -f "${backup}/client_secret" ]]; then cp -p "${backup}/client_secret" "${SECRET_TARGET}"; else rm -f "${SECRET_TARGET}"; fi
}

# ---------------------------------------------------------------- 3. Secreto
phase='secret'
read_secret_to "${QAPAQ_O365_SECRET_SOURCE}" "${work}/client_secret" ||
  fail 'no se pudo leer el client secret de la fuente declarada.'
install -d -m 0750 -o root -g wazuh "${SECRET_DIR}"
install -m 0640 -o root -g wazuh "${work}/client_secret" "${SECRET_TARGET}"

# ---------------------------------------------------------- 4. Bloque office365
phase='ossec-conf'
render_block >"${work}/office365.xml"
python3 - "${CONF}" "${work}/office365.xml" "etc/lists/${LIST_NAME}" <<'PY' || { restore; fail 'no se pudo editar ossec.conf.'; }
import re, sys

conf_path, block_path, list_path = sys.argv[1:4]
conf = open(conf_path, encoding='utf-8').read()
block = open(block_path, encoding='utf-8').read().rstrip('\n')

begin, end = '<!-- QAPAQ:office365:begin', '<!-- QAPAQ:office365:end -->'
pattern = re.compile(re.escape(begin) + r'.*?' + re.escape(end), re.S)
if pattern.search(conf):
    conf = pattern.sub(lambda _: block, conf, count=1)
else:
    # Un bloque <office365> previo sin marcadores se deshabilita para no duplicar el módulo.
    conf = re.sub(r'<office365>(?:(?!</office365>).)*<enabled>yes</enabled>',
                  lambda m: m.group(0).replace('<enabled>yes</enabled>', '<enabled>no</enabled>'),
                  conf, flags=re.S)
    index = conf.rfind('</ossec_config>')
    if index < 0:
        sys.exit('ossec.conf sin </ossec_config>')
    conf = conf[:index] + '  ' + block + '\n' + conf[index:]

# Registrar la lista CDB una sola vez dentro del primer <ruleset>.
entry = f'<list>{list_path}</list>'
if entry not in conf:
    ruleset_end = conf.find('</ruleset>')
    if ruleset_end < 0:
        sys.exit('ossec.conf sin <ruleset>')
    conf = conf[:ruleset_end] + f'  {entry}\n  ' + conf[ruleset_end:]

open(conf_path, 'w', encoding='utf-8').write(conf)
PY

# ------------------------------------------------------- 5. Reglas y lista CDB
phase='rules'
install -m 0660 -o root -g wazuh "${SCRIPT_DIR}/rules/${RULES_NAME}" "${RULES_TARGET}"

phase='break-glass-list'
: >"${work}/break_glass"
if [[ -n "${QAPAQ_BREAK_GLASS_SOURCE:-}" ]]; then
  read_secret_to "${QAPAQ_BREAK_GLASS_SOURCE}" "${work}/break_glass_raw" ||
    { restore; fail 'no se pudo leer la lista break-glass.'; }
  # Una entrada por línea con formato CDB `clave:valor`. Se aceptan UPN sueltos o líneas que ya
  # traen `:valor` (como `lists/qapaq-break-glass.example`), separados por comas o saltos de
  # línea. Un UPN no contiene `:`, así que todo lo posterior al primero se descarta.
  tr ',;' '\n\n' <"${work}/break_glass_raw" | sed -e 's/^[[:space:]]*//' -e 's/:.*$//' -e 's/[[:space:]]*$//' |
    grep -E '^[^[:space:]:]+@[^[:space:]:]+$' | sort -u | sed 's/$/:break-glass/' >"${work}/break_glass" || true
fi
if [[ ! -s "${work}/break_glass" ]]; then
  echo 'QAPAQ office365: AVISO — lista break-glass vacía; la regla 100530 no se activará.' >&2
fi
install -m 0660 -o root -g wazuh "${work}/break_glass" "${LIST_TARGET}"

# -------------------------------------------------------------- 6. Validación
phase='analysisd-test'
if ! "${WAZUH_HOME}/bin/wazuh-analysisd" -t >"${work}/analysisd-test.log" 2>&1; then
  grep -iE 'error|critical' "${work}/analysisd-test.log" | tail -n 20 >&2 || true
  restore
  fail 'wazuh-analysisd rechazó la configuración; se restauró el estado previo.'
fi

# -------------------------------------------------------------- 7. Reinicio
phase='restart'
restart_marker="$(date -u '+%Y/%m/%d %H:%M:%S')"
if command -v systemctl >/dev/null && systemctl list-unit-files wazuh-manager.service >/dev/null 2>&1; then
  systemctl restart wazuh-manager || { restore; fail 'wazuh-manager no reinició.'; }
else
  "${WAZUH_HOME}/bin/wazuh-control" restart >/dev/null 2>&1 || { restore; fail 'wazuh-control no reinició.'; }
fi

phase='verify'
sleep 20
echo "QAPAQ office365: aplicado. Respaldo en ${backup}."
echo "QAPAQ office365: líneas del módulo desde ${restart_marker} UTC:"
awk -v since="${restart_marker}" '$0 >= since' "${WAZUH_HOME}/logs/ossec.log" |
  grep -i 'office365' | sed -E 's/(client_secret|secret)[^ ]*/\1=[REDACTED]/Ig' | tail -n 20 || true
echo 'QAPAQ office365: la evidencia de recolección exige actividad real del tenant autorizado (ADR-024).'
