#!/usr/bin/env bash
# Enrola el propio nodo QAPAQ SOC (el host EC2, no el contenedor del manager) como agente Wazuh:
# FIM, inventario, SCA y logs del sistema que corre todo el SOC. Se conecta al manager por el
# puerto publicado en el host (127.0.0.1:1514/1515), grupo linux-pilot. Idempotente; EN el host.
set -euo pipefail
VERSION=4.14.8-1
NAME=qapaq-soc-dev-node
PASS_FILE=/opt/qapaq/secrets/wazuh-authd.pass
[[ -s $PASS_FILE ]] || { echo "falta $PASS_FILE (setup-wazuh-content.sh)" >&2; exit 1; }

if ! dpkg -s wazuh-agent >/dev/null 2>&1; then
  curl -fsSL https://packages.wazuh.com/key/GPG-KEY-WAZUH | gpg --dearmor -o /usr/share/keyrings/wazuh.gpg
  echo 'deb [signed-by=/usr/share/keyrings/wazuh.gpg] https://packages.wazuh.com/4.x/apt/ stable main' \
    >/etc/apt/sources.list.d/wazuh.list
  apt-get update -qq
  WAZUH_MANAGER=127.0.0.1 WAZUH_AGENT_NAME=$NAME WAZUH_AGENT_GROUP=linux-pilot \
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "wazuh-agent=$VERSION"
  apt-mark hold wazuh-agent >/dev/null
fi
# La contraseña de enrolamiento va en archivo (no en el entorno ni en argumentos).
install -o root -g wazuh -m 0640 "$PASS_FILE" /var/ossec/etc/authd.pass
systemctl enable --now wazuh-agent >/dev/null
systemctl restart wazuh-agent
for _ in $(seq 1 30); do
  grep -q "status='connected'" /var/ossec/var/run/wazuh-agentd.state 2>/dev/null && break
  sleep 2
done
echo "[qapaq-agent] $(grep -o "status='[a-z]*'" /var/ossec/var/run/wazuh-agentd.state)"
