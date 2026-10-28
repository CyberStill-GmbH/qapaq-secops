#!/usr/bin/env bash
# QAPAQ SecOps — instala las reglas de prioridad y sus listas CDB en un manager Wazuh 4.14.x.
#
# Qué hace, en este orden y de forma idempotente:
#   1. Valida las cuatro listas de contexto (formato clave:valor y valores admitidos).
#   2. Normaliza cada lista: agrega variantes en minúsculas y mayúsculas de cada clave,
#      porque `match_key` distingue mayúsculas y Windows/Linux no son consistentes.
#   3. Respalda ossec.conf, reglas y listas previas en $WAZUH_HOME/backup/qapaq-priority-<ts>/.
#   4. Instala reglas y listas (0640 root:wazuh) y registra las listas en <ruleset>.
#   5. Valida con wazuh-analysisd -t. Si falla, restaura el respaldo y termina con error.
#   6. Reinicia el manager solo si QAPAQ_PRIORITY_RESTART=true.
#
# Requiere que ya estén instalados los paquetes de los que dependen las reglas: AD, endpoint,
# launch-detections y office365 (ver rules/qapaq_priority_rules.xml).
#
# Entradas (variables de entorno):
#   QAPAQ_PRIORITY_LISTS_DIR    directorio con qapaq-critical-assets, qapaq-privileged-identities,
#                               qapaq-sensitive-workstations y qapaq-internet-facing (obligatorio).
#                               Se provisiona por ambiente fuera del repositorio.
#   QAPAQ_PRIORITY_ALLOW_EXAMPLE true solo en pruebas: admite claves .example (por defecto false)
#   QAPAQ_PRIORITY_RESTART      true | false (por defecto false)
#   QAPAQ_WAZUH_HOME            por defecto /var/ossec
#   QAPAQ_APPLY_MODE            apply | render (render valida y escribe las listas normalizadas
#                               en QAPAQ_PRIORITY_RENDER_DIR, sin tocar el manager)
#   QAPAQ_PRIORITY_RENDER_DIR   destino de render (obligatorio en render)
set -Eeuo pipefail
umask 027

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly WAZUH_HOME="${QAPAQ_WAZUH_HOME:-/var/ossec}"
readonly MODE="${QAPAQ_APPLY_MODE:-apply}"
readonly RESTART="${QAPAQ_PRIORITY_RESTART:-false}"
readonly ALLOW_EXAMPLE="${QAPAQ_PRIORITY_ALLOW_EXAMPLE:-false}"
readonly RULES_NAME='qapaq_priority_rules.xml'
readonly LISTS=(qapaq-critical-assets qapaq-privileged-identities qapaq-sensitive-workstations qapaq-internet-facing)

phase='validate'
fail() {
  echo "QAPAQ priority: falló en la fase '${phase}': $*" >&2
  exit 1
}

[[ "${MODE}" == apply || "${MODE}" == render ]] || fail 'QAPAQ_APPLY_MODE debe ser apply o render.'
case "${RESTART}" in true | false) ;; *) fail 'QAPAQ_PRIORITY_RESTART debe ser true o false.' ;; esac
case "${ALLOW_EXAMPLE}" in true | false) ;; *) fail 'QAPAQ_PRIORITY_ALLOW_EXAMPLE debe ser true o false.' ;; esac
[[ -f "${SCRIPT_DIR}/rules/${RULES_NAME}" ]] || fail 'no se encontró el archivo de reglas junto al script.'
[[ -d "${QAPAQ_PRIORITY_LISTS_DIR:-}" ]] || fail 'QAPAQ_PRIORITY_LISTS_DIR debe apuntar a un directorio.'
python_bin="$(command -v python3 || command -v python)" || fail 'se requiere Python 3.'

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# ---------------------------------------------------------------- 1-2. Validar y normalizar
"${python_bin}" - "${QAPAQ_PRIORITY_LISTS_DIR}" "${work}" "${ALLOW_EXAMPLE}" <<'PY' || fail 'listas de contexto inválidas.'
import pathlib
import re
import sys

source, target, allow_example = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3] == "true"
ALLOWED = {
    "qapaq-critical-assets": {"dc", "core", "db", "pago", "paw", "backup", "infra", "web"},
    "qapaq-privileged-identities": {"tier0", "tier1", "cloud-admin", "payment-approver", "service"},
    "qapaq-sensitive-workstations": {"tesoreria", "operaciones", "creditos", "ti-priv", "riesgos", "contabilidad"},
    "qapaq-internet-facing": {"web", "vpn", "mail", "api", "dns", "sftp"},
}
KEY = re.compile(r"^[^\s:#\"']{1,255}$")
errors = []
for name, allowed in ALLOWED.items():
    path = source / name
    if not path.is_file() or path.is_symlink():
        errors.append(f"{name}: no existe como archivo regular")
        continue
    entries = {}
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.rpartition(":")
        if not sep or not KEY.match(key) or value not in allowed:
            errors.append(f"{name}:{number}: se espera clave:valor con valor en {sorted(allowed)}")
            continue
        if not allow_example and key.lower().endswith(".example"):
            errors.append(f"{name}:{number}: clave sintética .example en una lista real")
            continue
        for variant in (key, key.lower(), key.upper()):
            previous = entries.setdefault(variant, value)
            if previous != value:
                errors.append(f"{name}:{number}: {key} aparece con valores distintos")
    if len(entries) > 15000:
        errors.append(f"{name}: demasiadas entradas; no es un inventario")
    (target / name).write_text("".join(f"{k}:{v}\n" for k, v in sorted(entries.items())), encoding="utf-8")
if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
PY

if [[ "${MODE}" == render ]]; then
  [[ -n "${QAPAQ_PRIORITY_RENDER_DIR:-}" ]] || fail 'QAPAQ_PRIORITY_RENDER_DIR es obligatorio en render.'
  mkdir -p "${QAPAQ_PRIORITY_RENDER_DIR}"
  for list in "${LISTS[@]}"; do cp "${work}/${list}" "${QAPAQ_PRIORITY_RENDER_DIR}/${list}"; done
  echo 'QAPAQ priority: render correcto; no se modificó el manager.'
  exit 0
fi

[[ "$(id -u)" -eq 0 ]] || fail 'debe ejecutarse como root.'
[[ -x "${WAZUH_HOME}/bin/wazuh-analysisd" ]] || fail "no hay un manager Wazuh en ${WAZUH_HOME}."

# ---------------------------------------------------------------- 3. Respaldo
phase='backup'
readonly CONF="${WAZUH_HOME}/etc/ossec.conf"
readonly RULES_TARGET="${WAZUH_HOME}/etc/rules/${RULES_NAME}"
backup="${WAZUH_HOME}/backup/qapaq-priority-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "${backup}"
chmod 700 "${backup}"
cp -p "${CONF}" "${backup}/ossec.conf"
[[ -f "${RULES_TARGET}" ]] && cp -p "${RULES_TARGET}" "${backup}/${RULES_NAME}"
for list in "${LISTS[@]}"; do
  [[ -f "${WAZUH_HOME}/etc/lists/${list}" ]] && cp -p "${WAZUH_HOME}/etc/lists/${list}" "${backup}/${list}"
done

restore() {
  echo 'QAPAQ priority: restaurando el estado previo.' >&2
  cp -p "${backup}/ossec.conf" "${CONF}"
  if [[ -f "${backup}/${RULES_NAME}" ]]; then cp -p "${backup}/${RULES_NAME}" "${RULES_TARGET}"; else rm -f "${RULES_TARGET}"; fi
  for list in "${LISTS[@]}"; do
    local target="${WAZUH_HOME}/etc/lists/${list}"
    if [[ -f "${backup}/${list}" ]]; then cp -p "${backup}/${list}" "${target}"; else rm -f "${target}" "${target}.cdb"; fi
  done
}

# ---------------------------------------------------------------- 4. Instalar
phase='install'
install -m 0640 -o root -g wazuh "${SCRIPT_DIR}/rules/${RULES_NAME}" "${RULES_TARGET}"
for list in "${LISTS[@]}"; do
  install -m 0640 -o root -g wazuh "${work}/${list}" "${WAZUH_HOME}/etc/lists/${list}"
done
"${python_bin}" - "${CONF}" "${LISTS[@]}" <<'PY' || { restore; fail 'no se pudo registrar las listas en ossec.conf.'; }
import re
import sys

path, names = sys.argv[1], sys.argv[2:]
text = open(path, encoding="utf-8").read()
blocks = list(re.finditer(r"<ruleset>(.*?)</ruleset>", text, re.DOTALL))
if len(blocks) != 1:
    sys.exit("ossec.conf debe tener exactamente un bloque <ruleset>")
block = blocks[0]
missing = [n for n in names if f"<list>etc/lists/{n}</list>" not in block.group(1)]
if missing:
    insertion = "".join(f"\n    <list>etc/lists/{n}</list>" for n in missing) + "\n  "
    end = block.end() - len("</ruleset>")
    text = text[:end].rstrip() + insertion + text[end:]
    open(path, "w", encoding="utf-8").write(text)
PY

# ---------------------------------------------------------------- 5. Validar
phase='verify'
if ! "${WAZUH_HOME}/bin/wazuh-analysisd" -t >"${work}/analysisd.log" 2>&1; then
  grep -E 'ERROR|CRITICAL' "${work}/analysisd.log" >&2 || true
  restore
  fail 'wazuh-analysisd -t rechazó la configuración; se restauró el estado previo.'
fi
grep -E 'WARNING.*(1016|7617|not found)' "${work}/analysisd.log" >&2 || true

# ---------------------------------------------------------------- 6. Reinicio opcional
phase='restart'
if [[ "${RESTART}" == true ]]; then
  "${WAZUH_HOME}/bin/wazuh-control" restart >/dev/null
  echo 'QAPAQ priority: manager reiniciado.'
else
  echo 'QAPAQ priority: instalado y validado; reinicio pendiente (QAPAQ_PRIORITY_RESTART=true).'
fi
echo "QAPAQ priority: respaldo en ${backup}"
