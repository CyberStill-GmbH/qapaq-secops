#!/usr/bin/env bash
# Prepara un contenedor desechable wazuh/wazuh-manager:4.14.8 para run-logtest.sh.
#
# Uso:
#   prepare-container.sh --tz [hora]                  imprime la TZ para `docker run -e TZ=`
#   prepare-container.sh <contenedor> [hora-esperada] carga reglas y listas y reinicia
#
# El contenedor se crea con la TZ que devuelve `--tz`, para que analysisd (lo arranque el
# entrypoint o este script) vea la hora local nocturna (23 por defecto) y las reglas con
# <time> sean deterministas.
#
# - Copia las reglas QAPAQ de las que dependen las financieras (office365,
#   active-directory, launch-detections) y las propias de finance.
# - Instala las reglas financieras como zz_qapaq_finance_rules.xml: Wazuh carga
#   etc/rules en orden alfabético y estas reglas cuelgan de office365 y launch-detections.
# - Instala las listas CDB de ejemplo (sintéticas) y las registra en ossec.conf.
# - Adapta SOLO en el contenedor la regla base de Windows para leer los casos JSON con
#   el decoder json, igual que el job de Active Directory; producción no cambia.
set -Eeuo pipefail

if [[ "${1:-}" == "--tz" ]]; then
  # TZ POSIX "QPQ+N" significa hora local = UTC - N; no requiere tzdata.
  echo "QPQ+$(( (10#$(date -u +%H) - ${2:-23} + 24) % 24 ))"
  exit 0
fi

container="${1:?Uso: prepare-container.sh <contenedor> [hora-esperada]}"
target_hour="${2:-23}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

# Esperar a que el entrypoint de la imagen termine de inicializar la configuración.
ready=false
for _ in $(seq 1 90); do
  if docker exec --workdir /var/ossec "${container}" sh -c \
    'test -s etc/internal_options.conf && grep -q "^agent.remote_conf=" etc/internal_options.conf'; then
    ready=true
    break
  fi
  sleep 2
done
[[ "${ready}" == true ]] || { echo 'El Manager no terminó de inicializar.' >&2; exit 1; }

rules=(
  "wazuh/office365/rules/qapaq_office365_rules.xml"
  "infra/wazuh/active-directory/rules/qapaq_active_directory_rules.xml"
  "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml"
  "infra/wazuh/finance/rules/qapaq_finance_rules.xml"
)
for rule in "${rules[@]}"; do
  target="$(basename "${rule}")"
  [[ "${target}" == qapaq_finance_rules.xml ]] && target="zz_qapaq_finance_rules.xml"
  docker cp "${root}/${rule}" "${container}:/var/ossec/etc/rules/${target}"
done

declare -A lists=(
  [qapaq-break-glass]="wazuh/office365/lists/qapaq-break-glass.example"
  [qapaq-finance-core-users]="infra/wazuh/finance/lists/qapaq-finance-core-users.example"
  [qapaq-break-glass-ad]="infra/wazuh/finance/lists/qapaq-break-glass-ad.example"
  [qapaq-sensitive-sites]="infra/wazuh/finance/lists/qapaq-sensitive-sites.example"
  [qapaq-lookalike-domains]="infra/wazuh/finance/lists/qapaq-lookalike-domains.example"
)
register=""
for name in "${!lists[@]}"; do
  docker cp "${root}/${lists[${name}]}" "${container}:/var/ossec/etc/lists/${name}"
  register="${register}    <list>etc/lists/${name}</list>\\n"
done

MSYS_NO_PATHCONV=1 docker exec "${container}" sh -c "
  set -e
  chown wazuh:wazuh /var/ossec/etc/rules/*qapaq_*.xml /var/ossec/etc/lists/qapaq-*
  chmod 660 /var/ossec/etc/rules/*qapaq_*.xml /var/ossec/etc/lists/qapaq-*
  grep -q 'etc/lists/qapaq-finance-core-users' /var/ossec/etc/ossec.conf ||
    sed -i '0,/<\/ruleset>/s||${register}  </ruleset>|' /var/ossec/etc/ossec.conf
  sed -i -e '/<category>ossec<\/category>/d' \
    -e 's|<decoded_as>windows_eventchannel</decoded_as>|<decoded_as>json</decoded_as>|' \
    /var/ossec/ruleset/rules/0575-win-base_rules.xml
"

# Se tolera la hora siguiente por si la ejecución cruza el cambio de hora UTC.
local_hour="$(docker exec "${container}" date +%H)"
if (( (10#${local_hour} - target_hour + 24) % 24 > 1 )); then
  echo "Hora local del contenedor ${local_hour}; se esperaba ${target_hour}. Crearlo con -e TZ=\$(prepare-container.sh --tz ${target_hour})." >&2
  exit 1
fi

if ! docker exec "${container}" /var/ossec/bin/wazuh-control restart; then
  echo 'wazuh-control restart devolvió error; se verifica analysisd a continuación.'
fi
for _ in $(seq 1 60); do
  if docker exec "${container}" /var/ossec/bin/wazuh-control status 2>/dev/null | grep -q 'wazuh-analysisd is running'; then
    MSYS_NO_PATHCONV=1 docker exec "${container}" /var/ossec/bin/wazuh-analysisd -t
    echo "Manager listo con hora local ${local_hour}:xx."
    exit 0
  fi
  sleep 2
done
echo 'wazuh-analysisd no quedó en ejecución.' >&2
docker exec "${container}" /var/ossec/bin/wazuh-control status >&2 || true
docker exec "${container}" sh -c "grep -E 'CRITICAL|ERROR' /var/ossec/logs/ossec.log | tail -n 40" >&2 || true
exit 1
