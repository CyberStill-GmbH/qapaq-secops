#!/usr/bin/env bash
# Prepara un contenedor desechable wazuh/wazuh-manager:4.14.8 para run-logtest.sh.
#
# Uso: prepare-container.sh <contenedor> [hora-local-deseada]
#
# - Copia las reglas QAPAQ de las que dependen las financieras (office365,
#   active-directory, launch-detections) y las propias de finance.
# - Instala las listas CDB de ejemplo (sintéticas) y las registra en ossec.conf.
# - Adapta SOLO en el contenedor la regla base de Windows para leer los casos JSON con
#   el decoder json, igual que el job de Active Directory; producción no cambia.
# - Reinicia el Manager con una TZ POSIX que deja la hora local en la hora pedida
#   (23 por defecto) para que las reglas con <time> sean deterministas.
set -Eeuo pipefail

container="${1:?Uso: prepare-container.sh <contenedor> [hora-local]}"
target_hour="${2:-23}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

rules=(
  "wazuh/office365/rules/qapaq_office365_rules.xml"
  "infra/wazuh/active-directory/rules/qapaq_active_directory_rules.xml"
  "infra/wazuh/launch-detections/rules/qapaq_launch_provider_rules.xml"
  "infra/wazuh/finance/rules/qapaq_finance_rules.xml"
)
for rule in "${rules[@]}"; do
  docker cp "${root}/${rule}" "${container}:/var/ossec/etc/rules/$(basename "${rule}")"
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
  chown wazuh:wazuh /var/ossec/etc/rules/qapaq_*.xml /var/ossec/etc/lists/qapaq-*
  chmod 660 /var/ossec/etc/rules/qapaq_*.xml /var/ossec/etc/lists/qapaq-*
  grep -q 'etc/lists/qapaq-finance-core-users' /var/ossec/etc/ossec.conf ||
    sed -i '0,/<\/ruleset>/s||${register}  </ruleset>|' /var/ossec/etc/ossec.conf
  sed -i -e '/<category>ossec<\/category>/d' \
    -e 's|<decoded_as>windows_eventchannel</decoded_as>|<decoded_as>json</decoded_as>|' \
    /var/ossec/ruleset/rules/0575-win-base_rules.xml
"

# TZ POSIX "QPQ+N" significa hora local = UTC - N; no requiere tzdata.
utc_hour="$(date -u +%H)"
offset=$(( (10#${utc_hour} - target_hour + 24) % 24 ))
tz="QPQ+${offset}"
echo "Manager de prueba con TZ=${tz} (hora local ${target_hour}:xx)."

MSYS_NO_PATHCONV=1 docker exec -e "TZ=${tz}" "${container}" /var/ossec/bin/wazuh-control stop >/dev/null 2>&1 || true
if ! MSYS_NO_PATHCONV=1 docker exec -e "TZ=${tz}" "${container}" /var/ossec/bin/wazuh-control start; then
  echo 'wazuh-control start devolvió error; se verifica analysisd a continuación.'
fi
for _ in $(seq 1 60); do
  if docker exec "${container}" /var/ossec/bin/wazuh-control status 2>/dev/null | grep -q 'wazuh-analysisd is running'; then
    MSYS_NO_PATHCONV=1 docker exec "${container}" /var/ossec/bin/wazuh-analysisd -t
    exit 0
  fi
  sleep 2
done
echo 'wazuh-analysisd no quedó en ejecución.' >&2
docker exec "${container}" tail -n 50 /var/ossec/logs/ossec.log >&2 || true
exit 1
