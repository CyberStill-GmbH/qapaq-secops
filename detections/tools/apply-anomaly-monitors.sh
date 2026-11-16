#!/usr/bin/env bash
# QAPAQ SOC · monitores de Alerting sobre los detectores de Anomaly Detection (docs/detection-engineering/07).
#
#   sudo bash wazuh/indexer/anomaly-detection/apply-detectors.sh     # crea y arranca los detectores qapaq-*
#   sudo bash detections/tools/apply-anomaly-monitors.sh             # crea/actualiza un monitor por detector
#
# Cada monitor corre cada 10 min sobre .opendistro-anomaly-results* y dispara cuando el detector reporta
# anomaly_grade > 0.7 con confidence > 0.7 en los últimos 20 min. Las alertas quedan en Alerting (OSD) y
# en el índice de resultados que lee la API QAPAQ (docs/07: señal ANOMALY_CORROBORATED). Idempotente por nombre.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../wazuh/manager/policy/lib.sh
source "$here/../../wazuh/manager/policy/lib.sh"
log() { printf '[qapaq-anomaly] %s\n' "$*"; }
AD=/_plugins/_anomaly_detection/detectors
AL=/_plugins/_alerting/monitors

for detector in ${QAPAQ_AD_MONITORS:-qapaq-logins-per-user qapaq-waf-blocks-per-zone qapaq-m365-login-failures}; do
  printf '{"query":{"term":{"name.keyword":"%s"}}}' "$detector" >"$QAPAQ_WORK/q.json"
  qapaq_indexer POST "$AD/_search" "$QAPAQ_WORK/q.json"
  id="$(qapaq_json "$INDEXER_BODY" "(d.get('hits',{}).get('hits') or [{}])[0].get('_id','')")"
  [[ -n "$id" ]] || { log "$detector: no existe (correr apply-detectors.sh primero)"; continue; }
  name="QAPAQ · Anomalía · $detector"
  qapaq_python - "$name" "$id" >"$QAPAQ_WORK/monitor.json" <<'PY'
import json, sys
name, detector_id = sys.argv[1:3]
grade = "ctx.results[0].aggregations.max_grade.value"
conf = "ctx.results[0].aggregations.max_confidence.value"
print(json.dumps({
    "type": "monitor", "monitor_type": "query_level_monitor", "name": name, "enabled": True,
    "schedule": {"period": {"interval": 10, "unit": "MINUTES"}},
    "inputs": [{"search": {"indices": [".opendistro-anomaly-results*"], "query": {
        "size": 0,
        "query": {"bool": {"filter": [
            {"range": {"execution_end_time": {"from": "{{period_end}}||-20m", "to": "{{period_end}}",
                                              "include_lower": True, "include_upper": True}}},
            {"term": {"detector_id": {"value": detector_id}}}]}},
        "aggregations": {"max_grade": {"max": {"field": "anomaly_grade"}},
                         "max_confidence": {"max": {"field": "confidence"}}}}}}],
    "triggers": [{"name": "Anomalía QAPAQ (grado > 0.7)", "severity": "2", "actions": [],
                  "condition": {"script": {"lang": "painless", "source":
                      f"return ctx.results != null && ctx.results.length > 0 && {grade} != null && {grade} > 0.7 "
                      f"&& {conf} != null && {conf} > 0.7"}}}],
    "ui_metadata": {"monitor_type": "query_level_monitor", "search": {"searchType": "ad"}},
}))
PY
  printf '{"query":{"match_phrase":{"monitor.name":"%s"}}}' "$name" >"$QAPAQ_WORK/mq.json"
  qapaq_indexer POST "$AL/_search" "$QAPAQ_WORK/mq.json"
  mid="$(qapaq_json "$INDEXER_BODY" "(d.get('hits',{}).get('hits') or [{}])[0].get('_id','')")"
  if [[ -n "$mid" ]]; then
    qapaq_indexer PUT "$AL/$mid" "$QAPAQ_WORK/monitor.json"; log "$name actualizado ($mid) → HTTP $INDEXER_STATUS"
  else
    qapaq_indexer POST "$AL" "$QAPAQ_WORK/monitor.json"; log "$name creado → HTTP $INDEXER_STATUS"
  fi
done
