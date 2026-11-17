#!/usr/bin/env bash
# Allow one narrowly defined retry after dpkg leaves only wazuh-manager conffiles.
# This check is read-only and runs before the official installer touches the host.
set -Eeuo pipefail

fail() { printf 'qapaq-siem-install: ERROR %s\n' "$1" >&2; exit 1; }

readonly DATA_ROOT="${QAPAQ_DATA_ROOT:-/srv/qapaq-siem}"
readonly CORE_ROOT="${QAPAQ_INSTALL_STATE_CORE_ROOT:-/opt/qapaq-core}"
readonly STATE_FILE="$DATA_ROOT/bootstrap-install-state.json"
readonly MANIFEST="${1:?ruta manifest requerida}"

expected_manager_version="$(python3 - "$MANIFEST" <<'PY'
import json
import pathlib
import sys

try:
    manifest = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    version = manifest["debianPackages"]["wazuh-manager"]
except (KeyError, OSError, json.JSONDecodeError, TypeError):
    raise SystemExit(1)
if not isinstance(version, str) or not version:
    raise SystemExit(1)
print(version)
PY
)" || fail 'el manifiesto no contiene la versión Debian de wazuh-manager'

[[ -d "$DATA_ROOT" && ! -L "$DATA_ROOT" ]] || fail 'no se pudo verificar el disco durable; se preserva el estado existente'
[[ ! -e "$STATE_FILE" && ! -L "$STATE_FILE" ]] || fail 'existe un registro durable; no se ejecuta una instalación inicial'
[[ ! -e "$CORE_ROOT" && ! -L "$CORE_ROOT" ]] || fail 'QAPAQ Core ya existe; se preserva sin cambios'

for name in manager indexer dashboard; do
  path="$DATA_ROOT/$name"
  [[ -d "$path" && ! -L "$path" ]] || fail 'falta una ruta durable esperada; se preserva el estado existente'
  [[ -z "$(find "$path" -mindepth 1 -print -quit)" ]] || fail 'el disco durable contiene datos; no se sobrescribe'
done

shopt -s nullglob dotglob
entries=("$DATA_ROOT"/*)
shopt -u nullglob dotglob
for path in "${entries[@]}"; do
  case "$path" in
    "$DATA_ROOT/manager"|"$DATA_ROOT/indexer"|"$DATA_ROOT/dashboard") ;;
    "$DATA_ROOT/lost+found")
      [[ -d "$path" && ! -L "$path" ]] || fail 'lost+found del disco durable no es un directorio normal'
      [[ -z "$(find "$path" -mindepth 1 -print -quit)" ]] || fail 'lost+found contiene datos; se preserva el disco'
      ;;
    *) fail 'el disco durable contiene archivos no reconocidos; se preserva sin cambios' ;;
  esac
done

config_only_manager=false
for package in wazuh-manager wazuh-indexer wazuh-dashboard filebeat; do
  if metadata="$(dpkg-query --show --showformat='${db:Status-Status}|${Version}' "$package" 2>/dev/null)"; then
    :
  else
    result=$?
    [[ "$result" -eq 1 ]] || fail 'no se pudo verificar el estado dpkg; se preserva el host'
    metadata='|'
  fi
  IFS='|' read -r status version <<< "$metadata"

  if [[ "$package" == wazuh-manager && "$status" == config-files && "$version" == "$expected_manager_version" ]]; then
    config_only_manager=true
  elif [[ "$package" == wazuh-manager && "$status" == config-files ]]; then
    fail 'el residuo config-files de wazuh-manager no corresponde a la versión fijada; se preserva'
  elif [[ -n "$status" && "$status" != not-installed ]]; then
    fail 'hay un paquete Wazuh instalado o parcialmente instalado; se preserva el host'
  fi
done

for service in wazuh-indexer wazuh-manager filebeat wazuh-dashboard qapaq-core-api qapaq-core-worker; do
  if state="$(systemctl show --property=ActiveState --value "$service" 2>/dev/null)"; then
    :
  else
    fail 'no se pudo verificar el estado de los servicios; se preserva el host'
  fi
  [[ -z "$state" || "$state" == inactive ]] || fail 'hay un servicio Wazuh/Core activo o en transición; se preserva el host'
done

if [[ "$config_only_manager" == true ]]; then
  printf '%s\n' 'qapaq-siem-install: se permite reintentar solo por el residuo dpkg config-files de wazuh-manager; no se borrarán datos ni secretos'
else
  printf '%s\n' 'qapaq-siem-install: host limpio verificado para primera instalación'
fi
