#!/usr/bin/env bash
# Precrea como administrador TODOS los index patterns que la app de Wazuh crearÃ­a al primer acceso
# (chequeo de salud: alerts/monitoring/statistics; vistas de mÃ³dulo: vulnerabilidades, IT Hygiene,
# FIM) y fija los uiSettings que el chequeo de salud escribirÃ­a. AsÃ­ un analista QAPAQ (solo lectura)
# abre todas las vistas sin escrituras fallidas (Â«Unable to write index patternÂ», chequeos en rojo).
#
# Cada index pattern se guarda CON su lista de campos (la de _fields_for_wildcard): un pattern sin
# `fields` obliga a OSD a refrescarlo y re-guardarlo en cada carga, lo que falla para solo lectura.
# Se conservan los atributos ya presentes (fieldFormatMap, sourceFilters...) y, si falta, se aÃ±ade
# el fieldFormatMap que define la app (bytes/percent/integer). Patterns sin Ã­ndices se omiten (la
# vista muestra Â«No matching indicesÂ», sin escribir). Idempotente: se re-ejecuta en cada despliegue
# y asÃ­ recoge campos nuevos de las plantillas.
#
# Las peticiones salen DESDE el contenedor del dashboard (172.30.89.10, el Ãºnico proxy en el que
# confÃ­a el indexer) con la identidad de servicio qapaq-bootstrap y el rol qapaq.platform.admin.
set -euo pipefail
C=qapaq-wazuh.dashboard-1
osd() {
  docker exec "$C" curl -s -o /dev/null -w '%{http_code}' -H 'osd-xsrf: true' \
    -H 'securitytenant: global' \
    -H 'x-proxy-user: qapaq-bootstrap' -H 'x-proxy-roles: qapaq.platform.admin' \
    -H 'x-forwarded-for: 127.0.0.1' "$@"   # el proxy auth del indexer exige XFF resuelto
}

for _ in $(seq 1 60); do
  [[ $(osd http://127.0.0.1:5601/api/status) == 200 ]] && break
  sleep 5
done

C="$C" python3 - <<'PY'
import json, os, subprocess, sys, urllib.parse

C = os.environ["C"]
BASE = "http://127.0.0.1:5601"


def osd(method, path, body=None):
    cmd = ["docker", "exec", "-i", C, "curl", "-s", "-g", "-X", method, "-w", "\n%{http_code}",
           "-H", "osd-xsrf: true", "-H", "x-proxy-user: qapaq-bootstrap",
           "-H", "x-proxy-roles: qapaq.platform.admin", "-H", "x-forwarded-for: 127.0.0.1",
           "-H", "securitytenant: global",
           "-H", "Content-Type: application/json"]
    if body is not None:
        cmd += ["--data-binary", "@-"]
    out = subprocess.run(cmd + [BASE + path], input=json.dumps(body) if body is not None else None,
                         capture_output=True, text=True, check=True).stdout
    text, _, code = out.rpartition("\n")
    return int(code), (json.loads(text) if text.strip().startswith(("{", "[")) else text)


BYTES = {"id": "bytes"}
INT = {"id": "number", "params": {"pattern": "0"}}
PCT = {"id": "percent", "params": {"pattern": "0,0.[00]%"}}
URL = {"id": "url"}
MEM = {"host.memory.free": BYTES, "host.memory.total": BYTES, "host.memory.used": BYTES,
       "host.memory.usage": PCT}
NET = {"host.network.egress.bytes": BYTES, "host.network.ingress.bytes": BYTES}
PORTS = {"destination.port": INT, "source.port": INT, "process.pid": INT}
PROC = {"process.parent.pid": INT, "process.pid": INT}
# (pattern, campo de tiempo, formatos) = lo que crea la app de Wazuh 4.14 (plugins/main/public:
# health-check, it-hygiene/vulnerabilities/fim validate-*-index-pattern).
PATTERNS = [
    ("wazuh-alerts-*", "timestamp", {"data.virustotal.permalink": URL,
                                     "data.vulnerability.reference": URL, "data.url": URL}),
    ("wazuh-monitoring-*", "timestamp", {}),
    ("wazuh-statistics-*", "timestamp", {}),
    ("wazuh-states-vulnerabilities-*", None, {}),
    ("wazuh-states-fim-files-*", None, {"file.size": BYTES}),
    ("wazuh-states-fim-registries-*", None, {"registry.size": BYTES}),
    ("wazuh-states-inventory-*", None, {**MEM, **NET, **PORTS, **PROC, "package.size": BYTES}),
    ("wazuh-states-inventory-hardware-*", None, MEM),
    ("wazuh-states-inventory-hotfixes-*", None, {}),
    ("wazuh-states-inventory-interfaces-*", None, NET),
    ("wazuh-states-inventory-networks-*", None, {}),
    ("wazuh-states-inventory-packages-*", None, {"package.size": BYTES}),
    ("wazuh-states-inventory-ports-*", None, PORTS),
    ("wazuh-states-inventory-processes-*", None, PROC),
    ("wazuh-states-inventory-protocols-*", None, {}),
    ("wazuh-states-inventory-system-*", None, {}),
    ("wazuh-states-inventory-users-*", None, {}),
    ("wazuh-states-inventory-groups-*", None, {}),
    ("wazuh-states-inventory-services-*", None, {}),
    ("wazuh-states-inventory-browser-extensions-*", None, {}),
]
META = "&".join(f"meta_fields={m}" for m in ("_source", "_id", "_type", "_index", "_score"))

failed = False
for title, time_field, formats in PATTERNS:
    q = urllib.parse.quote(title, safe="")
    code, res = osd("GET", f"/api/index_patterns/_fields_for_wildcard?pattern={q}&{META}")
    if code == 404 or (code == 200 and not res.get("fields")):
        print(f"[qapaq-deploy] index pattern {title}: sin Ã­ndices todavÃ­a, se omite")
        continue
    if code != 200:
        print(f"index pattern {title}: campos â†’ HTTP {code}", file=sys.stderr); failed = True; continue
    fields = res["fields"]
    code, cur = osd("GET", f"/api/saved_objects/index-pattern/{q}")
    attrs = dict(cur.get("attributes", {})) if code == 200 else {}
    attrs.update(title=title, fields=json.dumps(fields))
    if time_field:
        attrs["timeFieldName"] = time_field
    if formats and not attrs.get("fieldFormatMap"):
        numeric = {f["name"] for f in fields if f.get("type") == "number"}
        fmt = {k: v for k, v in formats.items() if v is URL or k in numeric}
        if fmt:
            attrs["fieldFormatMap"] = json.dumps(fmt)
    code, res = osd("POST", f"/api/saved_objects/index-pattern/{q}?overwrite=true", {"attributes": attrs})
    if code != 200:
        print(f"index pattern {title} â†’ HTTP {code}: {str(res)[:300]}", file=sys.stderr); failed = True; continue
    print(f"[qapaq-deploy] index pattern {title}: {len(fields)} campos")

# Restos de un ensayo con prefijo qapaq-* (los datos viven en wazuh-*): confunden el selector de
# index pattern de la app y apuntan a Ã­ndices inexistentes.
for stale in ("qapaq-alerts-*", "qapaq-statistics-*", "qapaq-monitoring-*"):
    q = urllib.parse.quote(stale, safe="")
    code, _ = osd("DELETE", f"/api/saved_objects/index-pattern/{q}")
    if code == 200:
        print(f"[qapaq-deploy] index pattern obsoleto {stale}: borrado")

# uiSettings que el chequeo de salud (checks.maxBuckets/metaFields/timeFilter) escribirÃ­a como el
# usuario en curso, mÃ¡s el index pattern por defecto.
code, res = osd("POST", "/api/opensearch-dashboards/settings", {"changes": {
    "defaultIndex": "wazuh-alerts-*",
    "timelion:max_buckets": 200000,
    "metaFields": ["_source", "_index"],
    "timepicker:timeDefaults": json.dumps({"from": "now-24h", "to": "now"}),
}})
if code != 200:
    print(f"uiSettings â†’ HTTP {code}: {str(res)[:300]}", file=sys.stderr); failed = True
sys.exit(1 if failed else 0)
PY

# Dashboards QAPAQ de los proveedores sin mÃ³dulo nativo en la app de Wazuh (Bitdefender GravityZone,
# Snyk, Cloudflare, AWS) y de Microsoft 365 (wazuh/dashboard/saved-objects). Tenant global, misma
# identidad de servicio. Idempotente: IDs estables `qapaq-*` + overwrite.
NDJSON="${QAPAQ_PROVIDER_DASHBOARDS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/wazuh/dashboard/saved-objects/qapaq-provider-dashboards.ndjson}"
if [[ -f $NDJSON ]]; then
  result="$(docker exec -i "$C" curl -s -H 'osd-xsrf: true' \
    -H 'securitytenant: global' \
    -H 'x-proxy-user: qapaq-bootstrap' -H 'x-proxy-roles: qapaq.platform.admin' \
    -H 'x-forwarded-for: 127.0.0.1' -F 'file=@-;filename=qapaq-provider-dashboards.ndjson' \
    'http://127.0.0.1:5601/api/saved_objects/_import?overwrite=true' <"$NDJSON")"
  if [[ $result == *'"success":true'* ]]; then
    echo "[qapaq-deploy] dashboards de proveedores: $(grep -o '"successCount":[0-9]*' <<<"$result")"
  else
    echo "dashboards de proveedores: importaciÃ³n fallida: ${result:0:500}" >&2
    exit 1
  fi
fi
