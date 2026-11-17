#!/usr/bin/env bash
# QAPAQ SecOps · prepara un host Linux con agente Wazuh para la visibilidad de red (docs/18).
# Se corre UNA vez por host, como root, desde una copia del repo:
#   sudo bash infra/wazuh/network/agent/install-linux-network-visibility.sh [--docker]
#
# 1. auditd (+ log_format ENRICHED, que pone la IP legible en SOCKADDR) y qapaq-audit-sync (.path +
#    .service): aplica las reglas qapaq_net_* que el manager distribuye con el grupo, sin vaciar las reglas
#    who-data que agrega el agente para FIM.
# 2. logcollector.remote_commands=1 en local_internal_options.conf: permite los <localfile> de comando
#    del agent.conf del grupo (qapaq-netconn.sh). Riesgo: quien controle el manager puede ejecutar comandos
#    como root en el agente vía logcollector; en QAPAQ el manager es parte del mismo perímetro del SOC.
#    wazuh_command.remote_commands sigue en 0 (el wodle command remoto queda prohibido).
# 3. --docker: módulo Python `docker` para el wodle docker-listener (grupo linux-docker-hosts).
# Reinicia el agente solo si algo cambió y verifica que vuelva a conectarse.
set -Eeuo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
with_docker=0
[[ "${1:-}" == "--docker" ]] && with_docker=1
log() { printf '[qapaq-netvis-agent] %s\n' "$*"; }
[[ $EUID -eq 0 ]] || { log 'correr como root'; exit 1; }
[[ -x /var/ossec/bin/wazuh-control ]] || { log 'no hay agente Wazuh en /var/ossec'; exit 1; }
restart=0

pkg_install() {
  if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q "$@" >/dev/null
  else log "sin apt ni dnf: instalar a mano $*"; return 1; fi
}

# 1. auditd
if ! command -v auditctl >/dev/null 2>&1; then
  log 'instalando auditd'
  command -v apt-get >/dev/null 2>&1 && apt-get update -qq >/dev/null
  pkg_install auditd || pkg_install audit
  restart=1 # el agente detecta auditd (who-data) al arrancar
fi
conf=/etc/audit/auditd.conf
if [[ -f $conf ]] && ! grep -qE '^\s*log_format\s*=\s*ENRICHED' "$conf"; then
  cp -p "$conf" "$conf.qapaq-orig" 2>/dev/null || true
  if grep -qE '^\s*log_format' "$conf"; then sed -i -E 's/^\s*log_format\s*=.*/log_format = ENRICHED/' "$conf"; else echo 'log_format = ENRICHED' >>"$conf"; fi
  log 'auditd: log_format = ENRICHED'
fi
systemctl enable --now auditd >/dev/null 2>&1 || true
# auditd no admite restart por systemd en algunas distros: service lo hace bien.
service auditd restart >/dev/null 2>&1 || systemctl restart auditd || true

install -m 0755 "$here/qapaq-audit-sync.sh" /usr/local/sbin/qapaq-audit-sync
install -m 0644 "$here/qapaq-audit-sync.path" /etc/systemd/system/qapaq-audit-sync.path
install -m 0644 "$here/qapaq-audit-sync.service" /etc/systemd/system/qapaq-audit-sync.service
systemctl daemon-reload
systemctl enable --now qapaq-audit-sync.path >/dev/null
systemctl enable qapaq-audit-sync.service >/dev/null

# 2. comandos remotos de logcollector
lio=/var/ossec/etc/local_internal_options.conf
touch "$lio"
if ! grep -qE '^logcollector\.remote_commands=1' "$lio"; then
  sed -i '/^logcollector\.remote_commands=/d' "$lio"
  printf '# QAPAQ SecOps (docs/18): <localfile> de comando del agent.conf del grupo (qapaq-netconn.sh).\nlogcollector.remote_commands=1\n' >>"$lio"
  log 'logcollector.remote_commands=1'
  restart=1
fi

# 3. Docker listener
if [[ $with_docker == 1 ]]; then
  if ! python3 -c 'import docker' >/dev/null 2>&1; then
    log 'instalando el módulo Python docker'
    pkg_install python3-docker || pip3 install --break-system-packages 'docker>=7,<8'
    restart=1
  fi
fi

if [[ $restart == 1 ]]; then
  log 'reiniciando el agente'
  systemctl restart wazuh-agent
  for _ in $(seq 1 30); do
    grep -q "status='connected'" /var/ossec/var/run/wazuh-agentd.state 2>/dev/null && break
    sleep 2
  done
fi
grep -q "status='connected'" /var/ossec/var/run/wazuh-agentd.state && log 'agente conectado' || { log 'AVISO: el agente no reporta connected'; exit 1; }
# Primera carga de reglas (si el grupo ya distribuyó el archivo).
systemctl start qapaq-audit-sync.service || true
log 'listo'
