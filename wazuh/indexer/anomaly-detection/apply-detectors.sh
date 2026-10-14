#!/usr/bin/env bash
# QAPAQ SecOps — detectores ML (OpenSearch Anomaly Detection, RCF) (docs/07). Idempotente.
#
# Crea cada detector `qapaq-*.json` si no existe y lo arranca. Si ya existe, no lo toca, salvo
# con QAPAQ_AD_UPDATE=true: en ese caso lo detiene, lo actualiza y lo vuelve a arrancar, porque
# AD no admite actualizar un detector en marcha. Los resultados quedan en
# `.opendistro-anomaly-results*`, que `modules/connectors` lee con `qapaq_reader`.
set -euo pipefail
umask 077
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { printf 'qapaq-ad: ERROR %s\n' "$1" >&2; exit 1; }
info() { printf 'qapaq-ad: %s\n' "$1"; }
# shellcheck source=../../scripts/indexer-admin.sh
source "$here/../../scripts/indexer-admin.sh"
AD=/_plugins/_anomaly_detection/detectors

for file in "$here"/qapaq-*.json; do
  name="$(jq -er '.name' "$file")" || fail "$(basename "$file") no es un detector válido"
  query="$_qapaq_work/query.json"
  jq -n --arg name "$name" '{query: {term: {"name.keyword": $name}}}' >"$query"
  indexer POST "$AD/_search" "$query"
  id=""
  [[ "$INDEXER_STATUS" == 200 ]] && id="$(jq -r '.hits.hits[0]._id // empty' "$INDEXER_BODY")"

  if [[ -z "$id" ]]; then
    indexer POST "$AD" "$file"
    [[ "$INDEXER_STATUS" == 201 ]] || fail "$name: creación → HTTP $INDEXER_STATUS"
    id="$(jq -r '._id' "$INDEXER_BODY")"
    info "$name creado ($id)"
  elif [[ "${QAPAQ_AD_UPDATE:-false}" == true ]]; then
    indexer POST "$AD/$id/_stop"
    indexer PUT "$AD/$id" "$file"
    [[ "$INDEXER_STATUS" == 200 ]] || fail "$name: actualización → HTTP $INDEXER_STATUS"
    info "$name actualizado"
  else
    info "$name ya existe ($id); sin cambios"
  fi

  indexer POST "$AD/$id/_start"
  [[ "$INDEXER_STATUS" == 200 ]] && info "$name en marcha" \
    || info "$name: _start → HTTP $INDEXER_STATUS (ya en marcha o sin datos suficientes aún)"
done
