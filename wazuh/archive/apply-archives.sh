#!/usr/bin/env bash
# Habilita la captura e indexación de eventos crudos Wazuh con retención ISM de siete días.
# Hace backup de las dos configuraciones, valida ambas, aplica ISM antes de encender la captura
# y restaura los archivos si una validación o reinicio falla.
set -Eeuo pipefail
umask 077

readonly MODE="${QAPAQ_ARCHIVES_MODE:-apply}"
readonly WAZUH_HOME="${QAPAQ_WAZUH_HOME:-/var/ossec}"
readonly FILEBEAT_CONFIG="${QAPAQ_FILEBEAT_CONFIG:-/etc/filebeat/filebeat.yml}"
readonly MANAGER_CONFIG="${WAZUH_HOME}/etc/ossec.conf"
readonly INDEXER_ADMIN="${QAPAQ_INDEXER_ADMIN_HELPER:-/opt/qapaq/indexer-admin.sh}"
readonly POLICY_SOURCE="${QAPAQ_ARCHIVES_POLICY:-/opt/qapaq/qapaq-wazuh-archives-7d.json}"
readonly POLICY_ID='qapaq-wazuh-archives-7d'

fail() { printf 'qapaq-archives: ERROR %s\n' "$1" >&2; exit 1; }
info() { printf 'qapaq-archives: %s\n' "$1"; }

[[ "$MODE" == audit || "$MODE" == apply ]] || fail 'QAPAQ_ARCHIVES_MODE debe ser audit o apply.'
[[ -r "$MANAGER_CONFIG" ]] || fail 'no se puede leer ossec.conf.'
[[ -r "$FILEBEAT_CONFIG" ]] || fail 'no se puede leer filebeat.yml.'
[[ -r "$POLICY_SOURCE" ]] || fail 'no se encuentra la política ISM versionada.'
command -v python3 >/dev/null || fail 'python3 es necesario para editar YAML/XML preservando el resto del archivo.'
command -v jq >/dev/null || fail 'jq es obligatorio.'

python3 - "$MANAGER_CONFIG" "$FILEBEAT_CONFIG" <<'PY'
import re, sys

manager = open(sys.argv[1], encoding="utf-8").read()
masked = re.sub(r"<!--.*?-->", lambda m: re.sub(r"[^\n]", " ", m.group(0)), manager, flags=re.S)
global_blocks = re.findall(r"<global\b[^>]*>(.*?)</global\s*>", masked, re.S | re.I)
if not global_blocks:
    sys.exit("ossec.conf no contiene bloques <global> activos.")
if sum(len(re.findall(r"<logall_json\b", block, re.I)) for block in global_blocks) > 1:
    sys.exit("los bloques <global> contienen logall_json duplicado.")

lines = open(sys.argv[2], encoding="utf-8").read().splitlines(keepends=True)
modules = [i for i, line in enumerate(lines) if re.match(r"^\s*-\s*module:\s*wazuh\s*(?:#.*)?$", line.rstrip("\r\n"))]
if len(modules) != 1:
    sys.exit("filebeat.yml debe declarar exactamente un módulo wazuh.")
start = modules[0]
module_indent = len(lines[start]) - len(lines[start].lstrip())
end = len(lines)
for i in range(start + 1, len(lines)):
    current = lines[i]
    if current.strip() and not current.lstrip().startswith("#"):
        indent = len(current) - len(current.lstrip())
        if indent <= module_indent and re.match(r"^\s*-\s*module:", current):
            end = i
            break
block = lines[start:end]
archives = [i for i, line in enumerate(block) if re.match(r"^\s*archives:\s*(?:#.*)?$", line.rstrip("\r\n"))]
if len(archives) != 1:
    sys.exit("el módulo wazuh debe contener exactamente una sección archives.")
archive_indent = len(block[archives[0]]) - len(block[archives[0]].lstrip())
enabled = []
for i in range(archives[0] + 1, len(block)):
    line = block[i]
    if line.strip() and not line.lstrip().startswith("#"):
        indent = len(line) - len(line.lstrip())
        if indent <= archive_indent:
            break
        if re.match(r"^\s*enabled:\s*(?:true|false)\s*(?:#.*)?$", line.rstrip("\r\n"), re.I):
            enabled.append(i)
if len(enabled) != 1:
    sys.exit("la sección archives debe contener exactamente una opción enabled booleana.")
PY
jq -e --arg id "$POLICY_ID" '.policy.ism_template | any(.index_patterns | index("wazuh-archives-*") != null)' "$POLICY_SOURCE" >/dev/null ||
  fail 'la política no contiene un ISM template para wazuh-archives-*.'

if [[ "$MODE" == audit ]]; then
  python3 - "$MANAGER_CONFIG" "$FILEBEAT_CONFIG" <<'PY'
import re, sys
manager = open(sys.argv[1], encoding="utf-8").read()
masked = re.sub(r"<!--.*?-->", lambda m: re.sub(r"[^\n]", " ", m.group(0)), manager, flags=re.S)
matches = list(re.finditer(r"<global\b[^>]*>(.*?)</global\s*>", masked, re.S | re.I))
if not matches:
    sys.exit("ossec.conf no contiene bloques <global> activos.")
values = []
for section in matches:
    values.extend(re.findall(r"<logall_json>\s*(yes|no)\s*</logall_json>", section.group(1), re.I))
if len(values) > 1:
    sys.exit("los bloques <global> contienen logall_json duplicado.")
print("logall_json=" + (values[0].lower() if values else "default-no"))
lines = open(sys.argv[2], encoding="utf-8").read().splitlines()
module = next(i for i, line in enumerate(lines) if re.match(r"^\s*-\s*module:\s*wazuh\s*$", line))
archive = next(i for i in range(module + 1, len(lines)) if re.match(r"^\s*archives:\s*$", lines[i]))
enabled = next(line for line in lines[archive + 1:] if re.match(r"^\s*enabled:\s*(true|false)\s*$", line))
print("filebeat_archives=" + enabled.strip().split(":", 1)[1].strip().lower())
PY
  [[ -r "$INDEXER_ADMIN" ]] || fail 'falta el helper de administración Indexer para revisar ISM.'
  # El modo audit solo comprueba el estado actual; no registra ni modifica recursos.
  source "$INDEXER_ADMIN"
  indexer GET "/_plugins/_ism/policies/${POLICY_ID}"
  case "$INDEXER_STATUS" in
    200) info "política ${POLICY_ID} ya existe" ;;
    404) info "política ${POLICY_ID} aún no está registrada" ;;
    *) fail "consulta de política ISM → HTTP $INDEXER_STATUS" ;;
  esac
  exit 0
fi

[[ "$(id -u)" -eq 0 ]] || fail 'apply debe ejecutarse como root.'
[[ -r "$INDEXER_ADMIN" ]] || fail 'falta el helper de administración Indexer.'
[[ -x "$WAZUH_HOME/bin/wazuh-analysisd" ]] || fail 'no hay Wazuh Manager instalado.'
command -v filebeat >/dev/null || fail 'Filebeat no está instalado.'
command -v systemctl >/dev/null || fail 'systemd es obligatorio.'
source "$INDEXER_ADMIN"
free_kb="$(df -Pk /var/lib/wazuh-indexer | awk 'NR == 2 {print $4}')"
[[ "$free_kb" =~ ^[0-9]+$ ]] || fail 'no se pudo calcular el espacio libre del Indexer.'
(( free_kb >= 10485760 )) || fail 'menos de 10 GiB libres en el Indexer; no se activa el archivo crudo.'

work="$(mktemp -d /dev/shm/qapaq-archives.XXXXXX 2>/dev/null || mktemp -d)"
backup="/root/qapaq-archives-backup-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$backup"
cp -p "$MANAGER_CONFIG" "$backup/ossec.conf"
cp -p "$FILEBEAT_CONFIG" "$backup/filebeat.yml"
changed=0
rollback() {
  local code=$?
  if [[ "$changed" == 1 ]]; then
    info 'la validación falló; restaurando las configuraciones respaldadas.' >&2
    cp -p "$backup/ossec.conf" "$MANAGER_CONFIG"
    cp -p "$backup/filebeat.yml" "$FILEBEAT_CONFIG"
    systemctl restart wazuh-manager >/dev/null 2>&1 || true
    systemctl restart filebeat >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
  [[ -z "${_qapaq_work:-}" ]] || rm -rf "$_qapaq_work"
  exit "$code"
}
trap rollback EXIT

# El Indexer recibe el template ISM antes de que Filebeat pueda crear el primer índice archive.
jq -e . "$POLICY_SOURCE" >/dev/null || fail 'JSON de política ISM inválido.'
indexer GET "/_plugins/_ism/policies/${POLICY_ID}"
if [[ "$INDEXER_STATUS" == 200 ]]; then
  seq="$(jq -r '._seq_no' "$INDEXER_BODY")"
  term="$(jq -r '._primary_term' "$INDEXER_BODY")"
  indexer PUT "/_plugins/_ism/policies/${POLICY_ID}?if_seq_no=${seq}&if_primary_term=${term}" "$POLICY_SOURCE"
else
  [[ "$INDEXER_STATUS" == 404 ]] || fail "leer política ISM → HTTP $INDEXER_STATUS"
  indexer PUT "/_plugins/_ism/policies/${POLICY_ID}" "$POLICY_SOURCE"
fi
[[ "$INDEXER_STATUS" =~ ^20[01]$ ]] || fail "aplicar política ISM → HTTP $INDEXER_STATUS"
indexer GET "/_plugins/_ism/policies/${POLICY_ID}"
[[ "$INDEXER_STATUS" == 200 ]] || fail "verificar política ISM → HTTP $INDEXER_STATUS"
jq -e '.policy.ism_template | any(.index_patterns | index("wazuh-archives-*") != null)' "$INDEXER_BODY" >/dev/null ||
  fail 'la política aplicada no devuelve el patrón wazuh-archives-*.'
info "política ${POLICY_ID} configurada; aplica solo a wazuh-archives-*"

# Una plantilla solo administra índices nuevos. Si hubiera archivos históricos de una activación
# anterior, se asigna esta política por nombre exacto (nunca con un wildcard global).
indexer GET '/_cat/indices/wazuh-archives-*?format=json&h=index'
[[ "$INDEXER_STATUS" == 200 ]] || fail "inventariar índices archive → HTTP $INDEXER_STATUS"
printf '{"policy_id":"%s"}\n' "$POLICY_ID" >"$_qapaq_work/archive-policy.json"
archive_indices="$(jq -r '.[].index // empty' "$INDEXER_BODY")"
while IFS= read -r archive_index; do
  [[ -n "$archive_index" ]] || continue
  indexer POST "/_plugins/_ism/add/${archive_index}" "$_qapaq_work/archive-policy.json"
  if [[ "$INDEXER_STATUS" =~ ^20[01]$ ]] && jq -e '.failures == false' "$INDEXER_BODY" >/dev/null; then
    info "política ${POLICY_ID} asignada a ${archive_index}"
    continue
  fi
  # Si ya tenía una política (por ejemplo la política genérica de 90 días), migra solo el índice
  # archive existente a la retención demo autorizada.
  indexer POST "/_plugins/_ism/change_policy/${archive_index}" "$_qapaq_work/archive-policy.json"
  [[ "$INDEXER_STATUS" =~ ^20[01]$ ]] && jq -e '.failures == false' "$INDEXER_BODY" >/dev/null ||
    fail "no se pudo asignar la política de siete días a ${archive_index}"
  info "política ${POLICY_ID} programada para ${archive_index}"
done <<<"$archive_indices"

changed=1
python3 - "$MANAGER_CONFIG" "$FILEBEAT_CONFIG" <<'PY'
import re, sys
manager_path, filebeat_path = sys.argv[1:3]
manager = open(manager_path, encoding="utf-8").read()
masked = re.sub(r"<!--.*?-->", lambda m: re.sub(r"[^\n]", " ", m.group(0)), manager, flags=re.S)
pattern = re.compile(r"(<global\b[^>]*>)(.*?)(</global\s*>)", re.S | re.I)
matches = list(pattern.finditer(masked))
if not matches:
    sys.exit("ossec.conf no contiene bloques <global> activos.")
tag = re.compile(r"<logall_json\b[^>]*>.*?</logall_json\s*>", re.S | re.I)
tag_locations = []
for section in matches:
    body_start, body_end = section.start(2), section.end(2)
    original_body = manager[body_start:body_end]
    masked_body = re.sub(r"<!--.*?-->", lambda m: re.sub(r"[^\n]", " ", m.group(0)), original_body, flags=re.S)
    tag_locations.extend((section, original_body, match) for match in tag.finditer(masked_body))
if len(tag_locations) > 1:
    sys.exit("los bloques <global> contienen logall_json duplicado.")
if tag_locations:
    section, original_body, match = tag_locations[0]
    body_start, body_end = section.start(2), section.end(2)
    body = original_body[:match.start()] + "<logall_json>yes</logall_json>" + original_body[match.end():]
    manager = manager[:body_start] + body + manager[body_end:]
else:
    section = matches[0]
    body_start, body_end = section.start(2), section.end(2)
    original_body = manager[body_start:body_end]
    body = original_body.rstrip() + "\n    <logall_json>yes</logall_json>\n  "
    manager = manager[:body_start] + body + manager[body_end:]
open(manager_path, "w", encoding="utf-8").write(manager)

lines = open(filebeat_path, encoding="utf-8").read().splitlines(keepends=True)
modules = [i for i, line in enumerate(lines) if re.match(r"^\s*-\s*module:\s*wazuh\s*(?:#.*)?$", line.rstrip("\r\n"))]
if len(modules) != 1:
    sys.exit("filebeat.yml debe declarar exactamente un módulo wazuh.")
start = modules[0]
module_indent = len(lines[start]) - len(lines[start].lstrip())
end = len(lines)
for i in range(start + 1, len(lines)):
    current = lines[i]
    if current.strip() and not current.lstrip().startswith("#"):
        indent = len(current) - len(current.lstrip())
        if indent <= module_indent and re.match(r"^\s*-\s*module:", current):
            end = i
            break
block = lines[start:end]
archives = [i for i, line in enumerate(block) if re.match(r"^\s*archives:\s*(?:#.*)?$", line.rstrip("\r\n"))]
if len(archives) != 1:
    sys.exit("el módulo wazuh debe contener exactamente una sección archives.")
archive_indent = len(block[archives[0]]) - len(block[archives[0]].lstrip())
enabled = []
for i in range(archives[0] + 1, len(block)):
    line = block[i]
    if line.strip() and not line.lstrip().startswith("#"):
        indent = len(line) - len(line.lstrip())
        if indent <= archive_indent:
            break
        if re.match(r"^\s*enabled:\s*(?:true|false)\s*(?:#.*)?$", line.rstrip("\r\n"), re.I):
            enabled.append(i)
if len(enabled) != 1:
    sys.exit("la sección archives debe contener exactamente una opción enabled booleana.")
line = block[enabled[0]]
block[enabled[0]] = re.sub(r"(enabled:\s*)(?:true|false)", r"\1true", line, count=1, flags=re.I)
lines[start:end] = block
open(filebeat_path, "w", encoding="utf-8").writelines(lines)
PY

"$WAZUH_HOME/bin/wazuh-analysisd" -t >"$work/analysisd.log" 2>&1 || {
  grep -iE 'error|critical' "$work/analysisd.log" | tail -n 20 >&2 || true
  fail 'wazuh-analysisd rechazó ossec.conf.'
}
filebeat test config -c "$FILEBEAT_CONFIG" -e >"$work/filebeat-config.log" 2>&1 || {
  tail -n 30 "$work/filebeat-config.log" >&2 || true
  fail 'Filebeat rechazó filebeat.yml.'
}
filebeat test output -c "$FILEBEAT_CONFIG" -e >"$work/filebeat-output.log" 2>&1 || {
  tail -n 30 "$work/filebeat-output.log" >&2 || true
  fail 'Filebeat no alcanza el Indexer con la configuración actual.'
}
systemctl restart wazuh-manager || fail 'no se pudo reiniciar Wazuh Manager.'
systemctl is-active --quiet wazuh-manager || fail 'Wazuh Manager no quedó activo.'
systemctl restart filebeat || fail 'no se pudo reiniciar Filebeat.'
systemctl is-active --quiet filebeat || fail 'Filebeat no quedó activo.'

sleep 5
grep -q '<logall_json>yes</logall_json>' "$MANAGER_CONFIG" || fail 'logall_json no quedó activo.'
python3 - "$FILEBEAT_CONFIG" <<'PY' || fail 'archives de Filebeat no quedó activo.'
import re, sys
lines = open(sys.argv[1], encoding="utf-8").read().splitlines()
module = next(i for i, line in enumerate(lines) if re.match(r"^\s*-\s*module:\s*wazuh\s*$", line))
archive = next(i for i in range(module + 1, len(lines)) if re.match(r"^\s*archives:\s*$", lines[i]))
if not any(re.match(r"^\s*enabled:\s*true\s*$", line, re.I) for line in lines[archive + 1:]):
    sys.exit(1)
PY
[[ -s "$WAZUH_HOME/logs/archives/archives.json" ]] && info 'archivo local archives.json presente' ||
  info 'esperando el primer evento para crear archives.json; captura activada'
info 'Wazuh Manager y Filebeat activos con archivo crudo habilitado.'
info "backup local de configuración: $backup"
changed=0
rm -rf "$work"
trap - EXIT
