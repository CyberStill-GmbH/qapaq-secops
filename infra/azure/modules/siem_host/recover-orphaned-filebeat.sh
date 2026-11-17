#!/usr/bin/env bash
set -euo pipefail

data_root="${QAPAQ_RECOVERY_DATA_ROOT:-/srv/qapaq-siem}"
core_root="${QAPAQ_RECOVERY_CORE_ROOT:-/opt/qapaq-core}"
proc_root="${QAPAQ_RECOVERY_PROC_ROOT:-/proc}"

fail() {
  echo "::error::$1" >&2
  exit 1
}

mounted="$(findmnt --noheadings --output TARGET,FSTYPE --target "$data_root")" ||
  fail 'no se pudo verificar el montaje durable del SIEM'
read -r mount_target filesystem <<< "$mounted"
[[ "$mount_target" == "$data_root" && "$filesystem" == ext4 ]] ||
  fail 'el disco durable no está montado como ext4 en la ruta esperada'
[[ -d "$data_root" && ! -L "$data_root" ]] || fail 'el disco durable no es un directorio normal'
[[ ! -e "$data_root/bootstrap-install-state.json" && ! -L "$data_root/bootstrap-install-state.json" ]] ||
  fail 'hay un registro de instalación; no se toca el estado existente'
[[ ! -e "$core_root" && ! -L "$core_root" ]] || fail 'QAPAQ Core existe; no se toca el estado existente'

for name in manager indexer dashboard; do
  path="$data_root/$name"
  [[ -d "$path" && ! -L "$path" ]] || fail 'faltan directorios de datos esperados; no se recupera automáticamente'
  [[ -z "$(find "$path" -mindepth 1 -print -quit)" ]] || fail 'el disco durable contiene datos; no se recupera automáticamente'
done
for entry in "$data_root"/*; do
  [[ -e "$entry" || -L "$entry" ]] || continue
  case "$(basename "$entry")" in
    manager|indexer|dashboard) ;;
    lost+found)
      [[ -d "$entry" && ! -L "$entry" && -z "$(find "$entry" -mindepth 1 -print -quit)" ]] ||
        fail 'lost+found contiene datos; no se recupera automáticamente'
      ;;
    *) fail 'el disco durable contiene una ruta inesperada; no se recupera automáticamente' ;;
  esac
done

manager_status="$(dpkg-query --show --showformat='${db:Status-Status}|${Version}' wazuh-manager 2>/dev/null || true)"
case "$manager_status" in
  ''|not-installed\|*) ;;
  config-files\|4.14.8-1) ;;
  *) fail 'hay un paquete Manager fuera del residuo conocido; no se recupera automáticamente' ;;
esac
for package in wazuh-indexer wazuh-dashboard filebeat; do
  package_status="$(dpkg-query --show --showformat='${db:Status-Status}' "$package" 2>/dev/null || true)"
  [[ "$package_status" == '' || "$package_status" == not-installed ]] ||
    fail 'hay paquetes Wazuh instalados o parciales; no se recupera automáticamente'
done

for service in wazuh-indexer wazuh-manager wazuh-dashboard qapaq-core-api qapaq-core-worker; do
  active_state="$(systemctl show --property=ActiveState --value "$service" 2>/dev/null || true)"
  [[ "$active_state" == '' || "$active_state" == inactive ]] ||
    fail 'hay otro servicio Wazuh/Core activo; no se recupera automáticamente'
done

filebeat_package="$(dpkg-query --show --showformat='${db:Status-Status}' filebeat 2>/dev/null || true)"
[[ "$filebeat_package" == '' || "$filebeat_package" == not-installed ]] ||
  fail 'Filebeat está instalado; no se recupera automáticamente'
filebeat_state="$(systemctl show --property=ActiveState --value filebeat 2>/dev/null || true)"
if [[ "$filebeat_state" == active ]]; then
  load_state="$(systemctl show --property=LoadState --value filebeat 2>/dev/null || true)"
  fragment_path="$(systemctl show --property=FragmentPath --value filebeat 2>/dev/null || true)"
  main_pid="$(systemctl show --property=MainPID --value filebeat 2>/dev/null || true)"
  [[ "$load_state" == not-found && -z "$fragment_path" && "$main_pid" =~ ^[1-9][0-9]*$ ]] ||
    fail 'Filebeat aún tiene un unit file o un PID no verificable; se conserva sin cambios'
  if [[ -e "$proc_root/$main_pid" ]]; then
    [[ "$proc_root" == /proc ]] || fail 'no se puede validar con seguridad el espacio de procesos; se conserva sin cambios'
    process_name="$(cat "$proc_root/$main_pid/comm" 2>/dev/null || true)"
    process_executable="$(readlink "$proc_root/$main_pid/exe" 2>/dev/null || true)"
    [[ "$process_name" == filebeat && "$process_executable" == '/usr/share/filebeat/bin/filebeat (deleted)' ]] ||
      fail 'el PID registrado no coincide con el binario Filebeat borrado esperado; se conserva sin cambios'
    echo 'Stopping only the orphaned Filebeat process whose package and executable are absent.'
    if ! kill -TERM "$main_pid" 2>/dev/null && [[ -e "$proc_root/$main_pid" ]]; then
      fail 'no se pudo enviar SIGTERM al proceso huérfano verificado; se conserva sin cambios'
    fi
    process_stopped=false
    for attempt in {1..30}; do
      if [[ ! -e "$proc_root/$main_pid" ]]; then
        process_stopped=true
        break
      fi
      sleep 1
    done
    [[ "$process_stopped" == true ]] || fail 'el proceso Filebeat no salió tras SIGTERM; se conserva sin cambios'
  fi
  # LoadState=not-found means there is no unit systemd to stop; the exact
  # orphan process above has exited, so only discard the residual manager state.
  systemctl reset-failed filebeat
  systemctl daemon-reload
  filebeat_state="$(systemctl show --property=ActiveState --value filebeat 2>/dev/null || true)"
  [[ "$filebeat_state" == '' || "$filebeat_state" == inactive ]] ||
    fail 'no se pudo limpiar el estado systemd huérfano de Filebeat'
  echo 'Recovered only the orphaned Filebeat systemd state; no package, data, or install record was changed.'
elif [[ "$filebeat_state" != '' && "$filebeat_state" != inactive ]]; then
  fail 'Filebeat tiene un estado systemd no verificable; se conserva sin cambios'
else
  echo 'No orphaned Filebeat state was present.'
fi
