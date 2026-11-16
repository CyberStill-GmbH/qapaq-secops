#!/usr/bin/env bash
# QAPAQ SOC — políticas de agente centralizadas (etc/shared/<grupo>/agent.conf). Idempotente.
#
#   1. Valida cada agent.conf con verify-agent-conf del propio manager antes de instalarlo.
#   2. Crea el grupo si falta (agent_groups -a) e instala el agent.conf solo si cambió.
#   3. Instala además los demás archivos de shared/<grupo>/ (scripts y reglas que el grupo distribuye,
#      p. ej. qapaq-netconn.sh y qapaq-audit-network.rules de linux-servers; docs/18). El manager los empaqueta
#      en merged.mg y el agente los deja en /var/ossec/etc/shared/.
#   4. No asigna agentes: la asignación es del enrolamiento (WAZUH_AGENT_GROUP) o del operador.
#
# El grupo windows-telemetry-extended se crea vacío: asignarlo exige aprobación de privacidad.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"

M="$(qapaq_manager)"
qapaq_log "manager: $M"
changed=0
for dir in "$here"/shared/*/; do
  group="$(basename "$dir")"
  src="$dir/agent.conf"
  stage="$QAPAQ_WORK/$group.conf"
  tr -d '\r' <"$src" >"$stage"
  docker cp "$(qapaq_hp "$stage")" "$M:/tmp/qapaq-$group.conf" >/dev/null
  if ! out="$(qapaq_mexec /var/ossec/bin/verify-agent-conf -f "/tmp/qapaq-$group.conf" 2>&1)" ||
    ! grep -q 'verify-agent-conf: OK' <<<"$out"; then
    qapaq_mexec rm -f "/tmp/qapaq-$group.conf"
    printf '%s\n' "$out" >&2
    qapaq_die "agent.conf inválido para $group"
  fi
  # shellcheck disable=SC2016
  result="$(qapaq_mexec bash -euo pipefail -c '
    g="$1"; S=/var/ossec/etc/shared/$g; new=/tmp/qapaq-$g.conf
    if [ ! -d "$S" ]; then /var/ossec/bin/agent_groups -q -a -g "$g" >/dev/null; fi
    if [ -f "$S/agent.conf" ] && [ "$(sha256sum <"$new")" = "$(sha256sum <"$S/agent.conf")" ]; then echo unchanged
    else install -o wazuh -g wazuh -m 0660 "$new" "$S/agent.conf"; echo updated; fi
    rm -f "$new"' _ "$group")"
  [[ "$result" == updated ]] && changed=$((changed + 1))
  qapaq_log "grupo $group: $result"

  # Archivos adicionales del grupo (todo lo que no es agent.conf), con LF y sin permisos de ejecución.
  for extra in "$dir"*; do
    name="$(basename "$extra")"
    [[ -f "$extra" && "$name" != agent.conf ]] || continue
    tr -d '' <"$extra" >"$QAPAQ_WORK/$group.$name"
    docker cp "$(qapaq_hp "$QAPAQ_WORK/$group.$name")" "$M:/tmp/qapaq-$group.$name" >/dev/null
    # shellcheck disable=SC2016
    r="$(qapaq_mexec bash -euo pipefail -c '
      g="$1"; n="$2"; new=/tmp/qapaq-$g.$n; dst=/var/ossec/etc/shared/$g/$n
      if [ -f "$dst" ] && [ "$(sha256sum <"$new")" = "$(sha256sum <"$dst")" ]; then echo unchanged
      else install -o wazuh -g wazuh -m 0660 "$new" "$dst"; echo updated; fi
      rm -f "$new"' _ "$group" "$name")"
    [[ "$r" == updated ]] && changed=$((changed + 1))
    qapaq_log "grupo $group/$name: $r"
  done
done
qapaq_log "agent.conf actualizados: $changed (los agentes los reciben en su próximo keepalive; sin reinicio del manager)"
