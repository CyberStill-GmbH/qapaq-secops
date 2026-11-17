#!/usr/bin/env bash
# QAPAQ SecOps — rollback del agente Wazuh en Linux.
#
# Conserva ossec.conf y ossec.log en /var/lib/qapaq/wazuh-agent/rollback-<fecha> y desinstala el
# paquete. --remove-audit-rules retira también /etc/audit/rules.d/60-qapaq.rules. El registro
# en el manager se elimina desde el manager (docs/security/agents/05-operacion.md §4).
set -Eeuo pipefail

remove_audit=false
[[ "${1:-}" == --remove-audit-rules ]] && remove_audit=true
[[ "$(id -u)" -eq 0 ]] || { echo 'debe ejecutarse como root.' >&2; exit 1; }

evidence="/var/lib/qapaq/wazuh-agent/rollback-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "${evidence}"
for file in /var/ossec/etc/ossec.conf /var/ossec/logs/ossec.log /var/ossec/var/run/wazuh-agentd.state; do
  [[ -f "${file}" ]] && cp -p "${file}" "${evidence}/"
done

systemctl stop wazuh-agent 2>/dev/null || true
if command -v dpkg >/dev/null && dpkg -s wazuh-agent >/dev/null 2>&1; then
  apt-mark unhold wazuh-agent >/dev/null 2>&1 || true
  dpkg --purge wazuh-agent
elif command -v rpm >/dev/null && rpm -q wazuh-agent >/dev/null 2>&1; then
  if command -v dnf >/dev/null; then dnf versionlock delete wazuh-agent >/dev/null 2>&1 || true; fi
  rpm -e wazuh-agent
else
  echo '[QAPAQ wazuh] no hay agente Wazuh instalado.'
fi

if [[ "${remove_audit}" == true && -f /etc/audit/rules.d/60-qapaq.rules ]]; then
  rm -f /etc/audit/rules.d/60-qapaq.rules
  augenrules --load
fi
echo "[QAPAQ wazuh] rollback completo; evidencia en ${evidence}."
