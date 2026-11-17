#!/usr/bin/env bash
# QAPAQ SecOps · aplica en auditd las reglas de red que el manager distribuye con el grupo del agente
# (etc/shared/<grupo>/qapaq-audit-network.rules → /var/ossec/etc/shared/qapaq-audit-network.rules).
# Lo dispara qapaq-audit-sync.path cuando el archivo cambia, y qapaq-audit-sync.service al arrancar.
#
# - Carga ADITIVA: borra solo las reglas con clave qapaq_net_* y agrega las nuevas con auditctl; nunca
#   hace `augenrules --load` (vaciaría las reglas whodata que el agente Wazuh agrega para FIM).
# - Persistencia: copia el resultado a /etc/audit/rules.d/60-qapaq-network.rules (reinicios).
# - "## QAPAQ_WATCH <ruta>" se convierte en `-w <ruta> -p x -k qapaq_net_tools` solo si el binario existe.
# - Si auditctl rechaza una regla, se registra en el journal y se sigue con las demás.
set -uo pipefail
src="${1:-/var/ossec/etc/shared/qapaq-audit-network.rules}"
dst=/etc/audit/rules.d/60-qapaq-network.rules
log() { echo "qapaq-audit-sync: $*"; logger -t qapaq-audit-sync -- "$*" 2>/dev/null || true; }

command -v auditctl >/dev/null 2>&1 || { log "auditctl no está instalado"; exit 0; }
[[ -r "$src" ]] || { log "sin $src (el grupo aún no lo distribuyó)"; exit 0; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
{
  echo "## Generado por qapaq-audit-sync desde $src — no editar (se reescribe)."
  while IFS= read -r line; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^##\ QAPAQ_WATCH\ (/[^[:space:]]+)$ ]]; then
      path="${BASH_REMATCH[1]}"
      [[ -e "$path" ]] && echo "-w $path -p x -k qapaq_net_tools"
    elif [[ "$line" =~ ^-[aw]\  ]]; then
      echo "$line"
    fi
  done <"$src"
} >"$tmp"

# Quita las reglas QAPAQ cargadas (formato de auditctl -l, con -a → -d) y carga las nuevas.
removed=0
while IFS= read -r rule; do
  if [[ "$rule" == -w* ]]; then
    # shellcheck disable=SC2086
    auditctl ${rule/#-w /-W } >/dev/null 2>&1 && removed=$((removed + 1))
  else
    # shellcheck disable=SC2086
    auditctl ${rule/#-a /-d } >/dev/null 2>&1 && removed=$((removed + 1))
  fi
done < <(auditctl -l 2>/dev/null | grep -E 'key=qapaq_net_|-k qapaq_net_')

loaded=0 failed=0
while IFS= read -r rule; do
  [[ "$rule" == -* ]] || continue
  # shellcheck disable=SC2086
  if out="$(auditctl $rule 2>&1)"; then loaded=$((loaded + 1)); else failed=$((failed + 1)); log "regla rechazada: $rule ($out)"; fi
done <"$tmp"

install -m 0640 "$tmp" "$dst"
log "reglas qapaq_net_*: quitadas $removed, cargadas $loaded, rechazadas $failed (persistidas en $dst)"
