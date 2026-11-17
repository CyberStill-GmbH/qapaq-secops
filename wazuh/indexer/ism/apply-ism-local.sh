#!/usr/bin/env bash
# QAPAQ SecOps — retención del Indexer en nodo único SIN repositorio de snapshots (EC2 PowerUser y
# local). Idempotente. Catálogo y motivos: docs/16-politicas.md.
#
#   qapaq-wazuh-alerts-90d        wazuh-alerts-*                         hot 90 d → delete
#   qapaq-wazuh-monitoring-15d    wazuh-monitoring-*, wazuh-statistics-*  15 d → delete
#   qapaq-wazuh-archives-7d       wazuh-archives-* (si se habilita logall_json)  7 d → delete
#
# Con S3 + rol IAM (infra/aws) se usa apply-ism.sh (qapaq-wazuh-retention con snapshot a qapaq-s3).
# Este script no crea repositorios ni borra snapshots. Corre en el host vía docker exec al
# contenedor del indexer (wazuh/manager/policy/lib.sh); credencial admin desde
# /opt/qapaq/secrets/compose.env o QAPAQ_INDEXER_ADMIN_PASSWORD.
#
# Variables: QAPAQ_ALERTS_RETENTION_DAYS (90), QAPAQ_MONITORING_RETENTION_DAYS (15),
#            QAPAQ_ISM_TAKEOVER (0): 1 = cambiar a estas políticas índices que ya tengan OTRA.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../manager/policy/lib.sh
source "$here/../../manager/policy/lib.sh"

alerts_days="${QAPAQ_ALERTS_RETENTION_DAYS:-90}"
mon_days="${QAPAQ_MONITORING_RETENTION_DAYS:-15}"
[[ "$alerts_days" =~ ^[0-9]+$ && "$alerts_days" -ge 7 ]] || qapaq_die 'QAPAQ_ALERTS_RETENTION_DAYS debe ser ≥ 7'
[[ "$mon_days" =~ ^[0-9]+$ && "$mon_days" -ge 1 ]] || qapaq_die 'QAPAQ_MONITORING_RETENTION_DAYS inválido'

qapaq_indexer GET /_cluster/health
[[ "$INDEXER_STATUS" == 200 ]] || qapaq_die "indexer no responde (HTTP $INDEXER_STATUS)"
qapaq_log "indexer: $(qapaq_indexer_container) ($(qapaq_json "$INDEXER_BODY" 'd["status"]'))"

# policy-id|archivo|días (vacío = tal cual)|patrón de índices existentes a adjuntar
specs=(
  "qapaq-wazuh-alerts-90d|$here/qapaq-wazuh-alerts-90d.json|$alerts_days|wazuh-alerts-*"
  "qapaq-wazuh-monitoring-15d|$here/qapaq-wazuh-monitoring-15d.json|$mon_days|wazuh-monitoring-*,wazuh-statistics-*"
  "qapaq-wazuh-archives-7d|$here/qapaq-wazuh-archives-7d.json||wazuh-archives-*"
)

for spec in "${specs[@]}"; do
  IFS='|' read -r id file days pattern <<<"$spec"
  want="$QAPAQ_WORK/$id.want.json"
  # Ajusta la edad de borrado (transición hacia el estado final) si se pidió otro plazo.
  qapaq_python - "$file" "$want" "$days" <<'PY'
import json, sys
src, dst, days = sys.argv[1], sys.argv[2], sys.argv[3]
p = json.load(open(src, encoding="utf-8"))
if days:
    for st in p["policy"]["states"]:
        for t in st.get("transitions", []):
            t["conditions"]["min_index_age"] = f"{days}d"
json.dump(p, open(dst, "w", encoding="utf-8"), ensure_ascii=False)
PY
  qapaq_indexer GET "/_plugins/_ism/policies/$id"
  if [[ "$INDEXER_STATUS" == 200 ]]; then
    same="$(qapaq_python - "$INDEXER_BODY" "$want" <<'PY'
import json, sys
cur = json.load(open(sys.argv[1], encoding="utf-8"))["policy"]
want = json.load(open(sys.argv[2], encoding="utf-8"))["policy"]
def norm(p):
    keep = {k: p.get(k) for k in ("description", "default_state", "states")}
    keep["ism_template"] = [{"index_patterns": t["index_patterns"], "priority": t["priority"]}
                            for t in (p.get("ism_template") or [])]
    for st in keep["states"]:
        for a in st.get("actions", []):
            a.pop("retry", None)
    return json.dumps(keep, sort_keys=True)
print("yes" if norm(cur) == norm(want) else "no")
PY
)"
    if [[ "$same" == yes ]]; then
      qapaq_log "política $id: sin cambios"
    else
      seq="$(qapaq_json "$INDEXER_BODY" 'd["_seq_no"]')"; term="$(qapaq_json "$INDEXER_BODY" 'd["_primary_term"]')"
      qapaq_indexer PUT "/_plugins/_ism/policies/$id?if_seq_no=$seq&if_primary_term=$term" "$want"
      [[ "$INDEXER_STATUS" =~ ^20[01]$ ]] || { cat "$INDEXER_BODY" >&2; qapaq_die "política $id → HTTP $INDEXER_STATUS"; }
      qapaq_log "política $id: actualizada"
    fi
  else
    qapaq_indexer PUT "/_plugins/_ism/policies/$id" "$want"
    [[ "$INDEXER_STATUS" =~ ^20[01]$ ]] || { cat "$INDEXER_BODY" >&2; qapaq_die "política $id → HTTP $INDEXER_STATUS"; }
    qapaq_log "política $id: creada"
  fi

  # ism_template solo alcanza índices NUEVOS: adjuntar los existentes sin política.
  IFS=',' read -ra pats <<<"$pattern"
  for pat in "${pats[@]}"; do
    qapaq_indexer GET "/_plugins/_ism/explain/$pat"
    [[ "$INDEXER_STATUS" == 200 ]] || continue
    mapfile -t rows < <(qapaq_python - "$INDEXER_BODY" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
for k, v in d.items():
    if isinstance(v, dict) and "index.plugins.index_state_management.policy_id" in v or isinstance(v, dict) and "index.opendistro.index_state_management.policy_id" in v:
        pid = v.get("index.plugins.index_state_management.policy_id") or v.get("index.opendistro.index_state_management.policy_id")
        print(f"{k} {pid or '-'}")
PY
)
    unmanaged=(); others=()
    for row in "${rows[@]}"; do
      idx="${row% *}"; pid="${row#* }"
      if [[ "$pid" == "-" || "$pid" == null || "$pid" == None ]]; then unmanaged+=("$idx")
      elif [[ "$pid" != "$id" ]]; then others+=("$idx:$pid"); fi
    done
    body="$QAPAQ_WORK/attach.json"; printf '{"policy_id":"%s"}' "$id" >"$body"
    for idx in "${unmanaged[@]}"; do
      qapaq_indexer POST "/_plugins/_ism/add/$idx" "$body"
      qapaq_log "adjuntada $id a $idx (HTTP $INDEXER_STATUS)"
    done
    for item in "${others[@]}"; do
      if [[ "${QAPAQ_ISM_TAKEOVER:-0}" == 1 ]]; then
        cbody="$QAPAQ_WORK/change.json"; printf '{"policy_id":"%s"}' "$id" >"$cbody"
        qapaq_indexer POST "/_plugins/_ism/change_policy/${item%%:*}" "$cbody"
        qapaq_log "cambiada a $id: $item (HTTP $INDEXER_STATUS)"
      else
        qapaq_log "AVISO: ${item%%:*} tiene la política ${item#*:}; no se cambia (QAPAQ_ISM_TAKEOVER=1 para tomarla)"
      fi
    done
  done
done

# Nodo único: el índice interno de ISM nace con 1 réplica y deja el clúster en amarillo. Es un
# índice de sistema (el usuario admin no puede tocarlo): se usa el certificado admin del propio
# contenedor, que nunca sale de él.
qapaq_indexer GET /_cluster/health
nodes="$(qapaq_json "$INDEXER_BODY" 'd["number_of_nodes"]')"
if [[ "$nodes" == 1 ]]; then
  c=/usr/share/wazuh-indexer/config/certs
  out="$(docker exec "$(qapaq_indexer_container)" curl -sS --cacert "$c/root-ca.pem" --cert "$c/admin.pem" \
    --key "$c/admin-key.pem" --resolve "${QAPAQ_INDEXER_TLS_NAME:-wazuh.indexer}:9200:127.0.0.1" \
    "https://${QAPAQ_INDEXER_TLS_NAME:-wazuh.indexer}:9200/.opendistro-ism-config/_settings/index.number_of_replicas?flat_settings=true" 2>&1 || true)"
  if [[ "$out" == *'"index.number_of_replicas":"0"'* ]]; then
    qapaq_log 'índice interno de ISM: 0 réplicas (nodo único)'
  elif [[ "$out" == *'number_of_replicas'* ]]; then
    docker exec "$(qapaq_indexer_container)" curl -sS --cacert "$c/root-ca.pem" --cert "$c/admin.pem" \
      --key "$c/admin-key.pem" --resolve "${QAPAQ_INDEXER_TLS_NAME:-wazuh.indexer}:9200:127.0.0.1" -X PUT \
      -H 'content-type: application/json' -d '{"index":{"number_of_replicas":0}}' \
      "https://${QAPAQ_INDEXER_TLS_NAME:-wazuh.indexer}:9200/.opendistro-ism-config/_settings" >/dev/null &&
      qapaq_log 'índice interno de ISM: réplicas → 0 (nodo único; evita el estado amarillo)'
  fi
fi

qapaq_indexer GET /_snapshot
repos="$(qapaq_json "$INDEXER_BODY" 'sorted(d.keys()) if isinstance(d, dict) else []')"
qapaq_log "repositorios de snapshot registrados: $repos (sin S3/IAM: respaldo por snapshot EBS del volumen, ver docs/16)"
