#!/bin/sh
# QAPAQ SecOps — arranque de KrakenD (Sprint 5 · fase 0).
#
# En ECS la CA del proxy del Indexer llega como secreto en WAZUH_INDEXER_CA_PEM (no hay montaje
# de archivos en Fargate). Se escribe en WAZUH_INDEXER_CA_FILE con permisos 0600 antes de
# arrancar y la variable se descarta del entorno del proceso. Sin esas variables, KrakenD
# arranca igual que antes.
set -eu
if [ -n "${WAZUH_INDEXER_CA_PEM:-}" ] && [ -n "${WAZUH_INDEXER_CA_FILE:-}" ]; then
  umask 077
  mkdir -p "$(dirname "$WAZUH_INDEXER_CA_FILE")"
  printf '%s\n' "$WAZUH_INDEXER_CA_PEM" >"$WAZUH_INDEXER_CA_FILE"
  grep -q 'BEGIN CERTIFICATE' "$WAZUH_INDEXER_CA_FILE" || {
    echo 'qapaq-gateway: WAZUH_INDEXER_CA_PEM no es un certificado PEM' >&2
    exit 1
  }
fi
unset WAZUH_INDEXER_CA_PEM
exec /usr/bin/krakend "$@"
