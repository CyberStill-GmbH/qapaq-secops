#!/usr/bin/env bash
# QAPAQ SOC — aplica todas las políticas (docs/16-politicas.md) y luego las verifica. Idempotente.
# Corre EN el host de los contenedores (EC2 o local), como root en el EC2:
#
#   sudo bash infra/wazuh/policies/apply-policies.sh
#
# Orden: grupos de agentes → manager (reglas + ossec.conf, con wazuh-analysisd -t y rollback)
#        → retención ISM del Indexer → verificación PASS/FAIL.
# Variables: ver wazuh/manager/policy/lib.sh, apply-manager-policy.sh y apply-ism-local.sh.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
bash "$root/wazuh/manager/policy/apply-agent-groups.sh"
bash "$root/wazuh/manager/policy/apply-manager-policy.sh"
bash "$root/wazuh/indexer/ism/apply-ism-local.sh"
bash "$here/verify-policies.sh"
