#!/usr/bin/env bash
# QAPAQ SecOps — instala o actualiza el agente Wazuh 4.14.8 en Linux (deb o rpm) y lo inscribe.
#
# Idempotente. Pasos:
#   1. Verifica el paquete contra package-manifest.json (SHA-256 fijado).
#   2. Instala con WAZUH_MANAGER, WAZUH_REGISTRATION_SERVER, WAZUH_AGENT_GROUP y WAZUH_AGENT_NAME.
#      La contraseña de inscripción nunca va en variables de entorno del instalador ni en argv.
#   3. Bloquea la versión del paquete (el agente no puede ser más nuevo que el manager).
#   4. Si no está inscrito: lee la contraseña de Key Vault con la identidad administrada
#      (Azure VM o Azure Arc) o de un archivo protegido, la escribe en authd.pass (0640
#      root:wazuh), arranca el servicio, espera client.keys y borra authd.pass.
#   5. Opcional: instala las reglas auditd QAPAQ (--audit-rules).
#   6. Verifica servicio y conexión; deja /var/lib/qapaq/wazuh-agent/install-summary.json.
#
# Uso:
#   install-qapaq-wazuh-agent.sh --group qapaq-linux-server --package-dir /srv/wazuh/4.14.8 \
#     --key-vault kv-qapaq-eus2 [--secret-name wazuh-agent-enrollment-password] [--audit-rules]
#   install-qapaq-wazuh-agent.sh --group qapaq-srv-db --secret-file /root/.qapaq-enroll ...
#
# Códigos de salida: 0 correcto · 1 error · 2 inscrito pero sin conexión en el plazo.
set -Eeuo pipefail
umask 077

readonly WAZUH_VERSION='4.14.8'
readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly GROUPS_ALLOWED='qapaq-srv-core qapaq-srv-db qapaq-srv-web qapaq-linux-server'
readonly OSSEC=/var/ossec
readonly STATE_DIR=/var/lib/qapaq/wazuh-agent

group='' manager='app.jappi.net.pe' registration='app.jappi.net.pe'
package_dir="${HERE}/../packages" manifest="${HERE}/../package-manifest.json"
key_vault='' secret_name='wazuh-agent-enrollment-password' secret_file='' client_id=''
audit_rules=false timeout=180

fail() { echo "[QAPAQ wazuh] $*" >&2; exit 1; }
step() { echo "[QAPAQ wazuh] $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --group) group="$2"; shift 2 ;;
    --manager) manager="$2"; shift 2 ;;
    --registration-server) registration="$2"; shift 2 ;;
    --package-dir) package_dir="$2"; shift 2 ;;
    --manifest) manifest="$2"; shift 2 ;;
    --key-vault) key_vault="$2"; shift 2 ;;
    --secret-name) secret_name="$2"; shift 2 ;;
    --secret-file) secret_file="$2"; shift 2 ;;
    --managed-identity-client-id) client_id="$2"; shift 2 ;;
    --audit-rules) audit_rules=true; shift ;;
    --timeout) timeout="$2"; shift 2 ;;
    *) fail "opción desconocida: $1" ;;
  esac
done

[[ " ${GROUPS_ALLOWED} " == *" ${group} "* ]] || fail "--group debe ser uno de: ${GROUPS_ALLOWED}."
[[ "${manager}" =~ ^[A-Za-z0-9.-]+$ && "${registration}" =~ ^[A-Za-z0-9.-]+$ ]] || fail 'manager inválido.'
[[ -z "${key_vault}" || "${key_vault}" =~ ^[A-Za-z0-9-]{3,24}$ ]] || fail '--key-vault inválido.'
[[ "${secret_name}" =~ ^[A-Za-z0-9-]{1,127}$ ]] || fail '--secret-name inválido.'
[[ "${timeout}" =~ ^[0-9]+$ ]] || fail '--timeout debe ser numérico.'
[[ "$(id -u)" -eq 0 ]] || fail 'debe ejecutarse como root.'
command -v python3 >/dev/null || fail 'se requiere python3 para leer el manifiesto.'
command -v curl >/dev/null || fail 'se requiere curl.'

if command -v dpkg >/dev/null && ! command -v rpm >/dev/null || [[ -f /etc/debian_version ]]; then
  kind=deb artifact_id=wazuh-agent-deb-amd64
else
  kind=rpm artifact_id=wazuh-agent-rpm-x86_64
fi
[[ "$(uname -m)" == x86_64 ]] || fail 'solo se fija el paquete x86_64/amd64; agregar el artefacto al manifiesto para otra arquitectura.'

installed_version() {
  if [[ "${kind}" == deb ]]; then
    dpkg-query -W -f='${Status} ${Version}' wazuh-agent 2>/dev/null | awk '/install ok installed/ {print $4}' | cut -d- -f1
  else
    rpm -q --qf '%{VERSION}' wazuh-agent 2>/dev/null || true
  fi
}

enrolled() { [[ -s "${OSSEC}/etc/client.keys" ]]; }
agent_status() { sed -n "s/^status='\{0,1\}\([a-z]*\)'\{0,1\}$/\1/p" "${OSSEC}/var/run/wazuh-agentd.state" 2>/dev/null || true; }

# ---------------------------------------------------------------- 1-3. Paquete
agent_name="$(hostname -f 2>/dev/null || hostname)"
agent_name="${agent_name,,}"
current="$(installed_version)"
step "equipo ${agent_name} · grupo ${group} · versión instalada: ${current:-ninguna}."
if [[ -n "${current}" ]] && [[ "$(printf '%s\n%s\n' "${current}" "${WAZUH_VERSION}" | sort -V | tail -1)" != "${WAZUH_VERSION}" ]]; then
  fail "hay un agente ${current} más nuevo que el manager fijado (${WAZUH_VERSION}); no se degrada automáticamente."
fi

if [[ "${current}" != "${WAZUH_VERSION}" ]]; then
  read -r file sha <<<"$(python3 - "${manifest}" "${artifact_id}" "${WAZUH_VERSION}" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1], encoding="utf-8"))
if manifest["wazuhVersion"] != sys.argv[3]:
    sys.exit("versión del manifiesto distinta")
artifact = next(a for a in manifest["artifacts"] if a["id"] == sys.argv[2])
print(artifact["file"], artifact["sha256"])
PY
)" || fail 'manifiesto ilegible.'
  [[ "${sha}" =~ ^[0-9a-f]{64}$ ]] || fail 'SHA-256 del paquete no fijado (TO_BE_PROVIDED): ejecutar update-linux-manifest.sh.'
  package="${package_dir}/${file}"
  [[ -f "${package}" ]] || fail "no se encontró ${file} en ${package_dir}."
  echo "${sha}  ${package}" | sha256sum --check --status || fail 'SHA-256 del paquete no coincide con el manifiesto.'
  export WAZUH_MANAGER="${manager}" WAZUH_REGISTRATION_SERVER="${registration}"
  export WAZUH_AGENT_GROUP="${group}" WAZUH_AGENT_NAME="${agent_name}"
  if [[ "${kind}" == deb ]]; then
    apt-mark unhold wazuh-agent >/dev/null 2>&1 || true
    dpkg -i "${package}"
    apt-mark hold wazuh-agent >/dev/null
  else
    rpm -Uvh --replacepkgs "${package}"
    if command -v dnf >/dev/null && dnf versionlock --help >/dev/null 2>&1; then dnf versionlock add wazuh-agent >/dev/null; fi
  fi
  unset WAZUH_MANAGER WAZUH_REGISTRATION_SERVER WAZUH_AGENT_GROUP WAZUH_AGENT_NAME
fi

# ---------------------------------------------------------------- endurecimiento local
conf="${OSSEC}/etc/ossec.conf"
cp -p "${conf}" "${conf}.qapaq-$(date -u +%Y%m%dT%H%M%SZ).bak"
python3 - "${conf}" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
# Monitor-only: Active Response deshabilitado en el agente.
if re.search(r"<active-response>\s*<disabled>", text):
    text = re.sub(r"(<active-response>\s*<disabled>)\s*\w+\s*(</disabled>)", r"\1yes\2", text)
else:
    text = text.replace("</ossec_config>", "  <active-response>\n    <disabled>yes</disabled>\n  </active-response>\n</ossec_config>", 1)
if "<authorization_pass_path>" not in text and "<enrollment>" in text:
    text = text.replace("<enrollment>", "<enrollment>\n      <authorization_pass_path>etc/authd.pass</authorization_pass_path>", 1)
open(path, "w", encoding="utf-8").write(text)
PY
internal="${OSSEC}/etc/local_internal_options.conf"
touch "${internal}"
sed -i '/remote_commands/d' "${internal}"
printf '%s\n' 'logcollector.remote_commands=0' 'wazuh_command.remote_commands=0' 'sca.remote_commands=0' >>"${internal}"

if [[ "${audit_rules}" == true ]]; then
  command -v augenrules >/dev/null || fail 'auditd no está instalado (requerido para --audit-rules y whodata).'
  install -m 0640 -o root -g root "${HERE}/audit/qapaq.rules" /etc/audit/rules.d/60-qapaq.rules
  augenrules --load
  step 'reglas auditd QAPAQ cargadas.'
fi

# ---------------------------------------------------------------- 4. Inscripción
pass_file="${OSSEC}/etc/authd.pass"
cleanup() { [[ -f "${pass_file}" ]] && { shred -u "${pass_file}" 2>/dev/null || rm -f "${pass_file}"; }; }
trap cleanup EXIT

read_secret() {
  if [[ -n "${secret_file}" ]]; then
    [[ -f "${secret_file}" ]] || fail '--secret-file no existe.'
    [[ "$(stat -c %a "${secret_file}")" =~ ^[0-7]00$ ]] || fail '--secret-file no debe ser legible por grupo u otros.'
    tr -d '\r\n' <"${secret_file}"
    return
  fi
  [[ -n "${key_vault}" ]] || fail 'sin --key-vault ni --secret-file no hay de dónde leer la contraseña.'
  local token resource='https://vault.azure.net'
  if [[ -n "${IDENTITY_ENDPOINT:-}" && -n "${IMDS_ENDPOINT:-}" ]]; then
    # Azure Arc: el desafío apunta a un archivo .key legible solo por root/himds.
    local uri="${IDENTITY_ENDPOINT}?api-version=2020-06-01&resource=${resource}" realm
    realm="$(curl -s -D - -o /dev/null -H Metadata:true "${uri}" | sed -n 's/^[Ww][Ww][Ww]-[Aa]uthenticate: Basic realm=\(.*\)\r$/\1/p')"
    [[ -n "${realm}" && -f "${realm}" ]] || fail 'Azure Arc no presentó el desafío esperado.'
    token="$(curl -sf -H Metadata:true -H "Authorization: Basic $(cat "${realm}")" "${uri}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')"
  else
    local uri="http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=${resource}"
    [[ -n "${client_id}" ]] && uri+="&client_id=${client_id}"
    token="$(curl -sf --max-time 10 -H Metadata:true "${uri}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')"
  fi
  [[ -n "${token}" ]] || fail 'no se obtuvo token de identidad administrada.'
  # El token viaja por stdin de curl (-K -) para no aparecer en argv.
  printf 'header = "Authorization: Bearer %s"\n' "${token}" |
    curl -sf -K - "https://${key_vault}.vault.azure.net/secrets/${secret_name}?api-version=7.4" |
    python3 -c 'import json,sys; sys.stdout.write(json.load(sys.stdin)["value"])'
}

if ! enrolled; then
  install -m 0640 -o root -g wazuh /dev/null "${pass_file}"
  read_secret >"${pass_file}"
  [[ -s "${pass_file}" ]] || fail 'la contraseña de inscripción está vacía.'
  systemctl daemon-reload
  systemctl enable wazuh-agent >/dev/null
  systemctl restart wazuh-agent
  for ((i = 0; i < timeout; i += 3)); do enrolled && break; sleep 3; done
  enrolled || fail 'el agente no obtuvo client.keys; revisar /var/ossec/logs/ossec.log (1515/TCP, contraseña, grupo).'
  step 'inscripción correcta.'
else
  systemctl enable wazuh-agent >/dev/null
  systemctl restart wazuh-agent
fi
cleanup

# ---------------------------------------------------------------- 6. Verificación
connected=false
for ((i = 0; i < 120; i += 3)); do [[ "$(agent_status)" == connected ]] && { connected=true; break; }; sleep 3; done
mkdir -p "${STATE_DIR}"
python3 - "${STATE_DIR}/install-summary.json" "${agent_name}" "${group}" "$(installed_version)" "${manager}" \
  "$(systemctl is-active wazuh-agent || true)" "$(agent_status)" <<'PY'
import datetime, json, sys
path, name, group, version, manager, service, status = sys.argv[1:8]
summary = {"timestampUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "agentName": name,
           "group": group, "version": version, "manager": manager, "service": service,
           "enrolled": True, "status": status}
open(path, "w", encoding="utf-8").write(json.dumps(summary, indent=2))
print(json.dumps(summary, indent=2))
PY
if [[ "${connected}" != true ]]; then
  echo '[QAPAQ wazuh] inscrito pero sin conexión: revisar 1514/TCP y siem_host.agent_public_cidrs.' >&2
  exit 2
fi
step 'agente conectado. Verificar inventario y SCA desde el manager con tools/verify_agent.py.'
