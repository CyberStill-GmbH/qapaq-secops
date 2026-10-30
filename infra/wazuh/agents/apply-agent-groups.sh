#!/usr/bin/env bash
# QAPAQ SecOps — crea los grupos de agentes QAPAQ en el manager e instala su agent.conf.
#
# Idempotente y reversible. Para cada perfil de shared/<grupo>/agent.conf:
#   1. crea el grupo si no existe (agent_groups -a),
#   2. respalda el agent.conf vigente en $WAZUH_HOME/backup/qapaq-groups-<ts>/,
#   3. instala el nuevo y lo valida con verify-agent-conf; si falla, restaura y termina.
# No reinicia el manager: los agentes reciben la configuración compartida al sincronizar.
#
# Uso (root en el manager): apply-agent-groups.sh [grupo ...]   (sin argumentos: todos)
set -Eeuo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly WAZUH_HOME="${QAPAQ_WAZUH_HOME:-/var/ossec}"
[[ "$(id -u)" -eq 0 ]] || { echo 'debe ejecutarse como root.' >&2; exit 1; }
[[ -x "${WAZUH_HOME}/bin/verify-agent-conf" ]] || { echo "no hay manager Wazuh en ${WAZUH_HOME}." >&2; exit 1; }

if [[ $# -gt 0 ]]; then groups=("$@"); else mapfile -t groups < <(ls "${HERE}/shared"); fi
backup="${WAZUH_HOME}/backup/qapaq-groups-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "${backup}" && chmod 700 "${backup}"

for group in "${groups[@]}"; do
  [[ "${group}" =~ ^qapaq-[a-z-]+$ && -f "${HERE}/shared/${group}/agent.conf" ]] || { echo "perfil desconocido: ${group}" >&2; exit 1; }
  target="${WAZUH_HOME}/etc/shared/${group}/agent.conf"
  if [[ ! -d "${WAZUH_HOME}/etc/shared/${group}" ]]; then
    "${WAZUH_HOME}/bin/agent_groups" -q -a -g "${group}" >/dev/null
  fi
  [[ -f "${target}" ]] && cp -p "${target}" "${backup}/${group}.agent.conf"
  install -m 0660 -o wazuh -g wazuh "${HERE}/shared/${group}/agent.conf" "${target}"
  if ! "${WAZUH_HOME}/bin/verify-agent-conf" -f "${target}"; then
    if [[ -f "${backup}/${group}.agent.conf" ]]; then cp -p "${backup}/${group}.agent.conf" "${target}"; fi
    echo "verify-agent-conf rechazó ${group}; se restauró la versión previa." >&2
    exit 1
  fi
  echo "[QAPAQ groups] ${group} instalado."
done
echo "[QAPAQ groups] respaldo en ${backup}. Los agentes aplican el cambio al sincronizar (sin reinicio del manager)."
