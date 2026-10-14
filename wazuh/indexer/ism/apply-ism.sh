#!/usr/bin/env bash
# QAPAQ SecOps — retención hot/warm/cold del Indexer (docs/05-datos-y-retencion.md). Idempotente.
#
#   1. Verifica que el plugin repository-s3 esté instalado (no lo instala: eso requiere reiniciar
#      el Indexer y lo hace el bootstrap del host).
#   2. Registra el repositorio de snapshots `qapaq-s3`. Las credenciales salen del rol IAM de la
#      instancia, nunca de este script. Usa storage_class standard_ia y nunca lifecycle de S3.
#   3. Crea o actualiza las políticas ISM `qapaq-wazuh-retention` y `qapaq-restored-ttl`.
#   4. No borra snapshots: el borrado definitivo espera a que Legal ratifique la retención (N7).
#
# Variables: QAPAQ_SNAPSHOT_BUCKET (obligatoria), QAPAQ_AWS_REGION (obligatoria),
#            QAPAQ_SNAPSHOT_BASE_PATH (opcional, por defecto "wazuh-indexer").
set -euo pipefail
umask 077
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { printf 'qapaq-ism: ERROR %s\n' "$1" >&2; exit 1; }
info() { printf 'qapaq-ism: %s\n' "$1"; }
: "${QAPAQ_SNAPSHOT_BUCKET:?}" "${QAPAQ_AWS_REGION:?}"
[[ "$QAPAQ_SNAPSHOT_BUCKET" =~ ^[a-z0-9.-]{3,63}$ ]] || fail 'QAPAQ_SNAPSHOT_BUCKET inválido'
# shellcheck source=../../scripts/indexer-admin.sh
source "$here/../../scripts/indexer-admin.sh"

if ! /usr/share/wazuh-indexer/bin/opensearch-plugin list 2>/dev/null | grep -qx 'repository-s3'; then
  fail 'falta el plugin repository-s3 en el Indexer (instalarlo en el bootstrap y reiniciar)'
fi

repo="$_qapaq_work/repo.json"
jq -n --arg bucket "$QAPAQ_SNAPSHOT_BUCKET" --arg region "$QAPAQ_AWS_REGION" \
  --arg base "${QAPAQ_SNAPSHOT_BASE_PATH:-wazuh-indexer}" \
  '{type: "s3", settings: {bucket: $bucket, region: $region, base_path: $base,
    server_side_encryption: true, storage_class: "standard_ia", compress: true}}' >"$repo"
indexer PUT /_snapshot/qapaq-s3 "$repo"
[[ "$INDEXER_STATUS" == 200 ]] || fail "registro del repo qapaq-s3 → HTTP $INDEXER_STATUS"
indexer POST /_snapshot/qapaq-s3/_verify
[[ "$INDEXER_STATUS" == 200 ]] || fail "verificación del repo qapaq-s3 → HTTP $INDEXER_STATUS"
info 'repositorio qapaq-s3 verificado'

for policy in qapaq-wazuh-retention qapaq-restored-ttl; do
  file="$here/$policy.json"
  jq -e . "$file" >/dev/null || fail "$policy.json no es JSON válido"
  indexer GET "/_plugins/_ism/policies/$policy"
  if [[ "$INDEXER_STATUS" == 200 ]]; then
    seq="$(jq -r '._seq_no' "$INDEXER_BODY")"
    term="$(jq -r '._primary_term' "$INDEXER_BODY")"
    indexer PUT "/_plugins/_ism/policies/$policy?if_seq_no=$seq&if_primary_term=$term" "$file"
  else
    indexer PUT "/_plugins/_ism/policies/$policy" "$file"
  fi
  [[ "$INDEXER_STATUS" =~ ^20[01]$ ]] || fail "política $policy → HTTP $INDEXER_STATUS"
  info "política $policy aplicada"
done

# ism_template solo alcanza a índices NUEVOS. Los existentes se adjuntan una vez y se respeta
# la política que ya tengan.
attach="$_qapaq_work/attach.json"
echo '{"policy_id": "qapaq-wazuh-retention"}' >"$attach"
indexer POST '/_plugins/_ism/add/wazuh-alerts-*' "$attach"
info "adjuntar a wazuh-alerts-* existentes → HTTP $INDEXER_STATUS (failures = ya tenían política)"
