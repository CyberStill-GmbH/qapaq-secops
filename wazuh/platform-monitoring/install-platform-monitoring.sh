#!/usr/bin/env bash
# QAPAQ SecOps — monitoreo de plataforma, priorización KEV/EPSS y canarios (docs/20). EN el host, como root:
#
#   sudo bash /opt/qapaq/src/wazuh/platform-monitoring/install-platform-monitoring.sh [--no-restart]
#
# Idempotente. Nunca imprime secretos. Pasos:
#   1. Identidades de SOLO LECTURA (las crea este instalador con la credencial admin de compose.env;
#      el código del monitor nunca la lee):
#        - indexer: rol qapaq_platform_monitor + usuario interno qapaq_monitor (autoprueba: lee, no escribe);
#        - API Wazuh: usuario qapaq-monitor con el rol RBAC readonly;
#        - Postgres: rol qapaq_monitor sin contraseña (solo socket local del contenedor), SELECT en las
#          tablas de salud de ingesta.
#   2. Código en /opt/qapaq/platform-monitoring/bin, configs en etc/ (0600), estado en state/.
#      Actualiza el collector Snyk (enriquecimiento KEV/EPSS en línea) sin reinstalar los collectors.
#   3. Descarga KEV/EPSS y genera las listas CDB antes del reinicio (así cargan ya).
#   4. Reglas 101800-101879, listas qapaq-vuln-kev / qapaq-vuln-noise en <ruleset> y <localfile> de
#      platform-health.jsonl y vulnprio.jsonl entre marcadores QAPAQ:platform-monitoring. Respaldo,
#      wazuh-analysisd -t (revierte si falla), persistencia en el ossec.conf montado y reinicio SOLO
#      del manager (salvo --no-restart).
#   5. Units systemd: qapaq-platform-monitor (5 min), qapaq-vulnprio (1 h), qapaq-canary-inject (diario 06:10
#      UTC), qapaq-canary-verify (10 min). Ejecuta una vez cada uno y muestra el resultado.
#
# Variables: QAPAQ_EXPOSED_AGENTS=agente1,agente2 (agentes Wazuh con servicios publicados directamente a
#   Internet; por defecto ninguno: el nodo SOC solo publica vía ALB → edge en contenedor), SOC_HOSTNAME.
set -Eeuo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WAZUH_SRC="$(cd "${HERE}/.." && pwd)"
M="${QAPAQ_WAZUH_CONTAINER:-qapaq-wazuh.manager-1}"
PG="${QAPAQ_POSTGRES_CONTAINER:-qapaq-postgres-1}"
SECRETS="${QAPAQ_SECRETS:-/opt/qapaq/secrets}"
PMS="${SECRETS}/platform-monitoring"
ROOT=/opt/qapaq/platform-monitoring
BIN="$ROOT/bin"; ETC="$ROOT/etc"; STATE="$ROOT/state"
CERTS=/opt/qapaq/wazuh-docker/single-node/config/wazuh_indexer_ssl_certs
SOC_HOSTNAME="${SOC_HOSTNAME:-dev.security.qapaq.pe}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="/opt/qapaq/backups/platform-monitoring-$TS"
BEGIN='<!-- QAPAQ:platform-monitoring:begin -->'
END='<!-- QAPAQ:platform-monitoring:end -->'
RESTART=true
[[ ${1:-} == --no-restart ]] && RESTART=false
log() { printf '[qapaq-platform] %s\n' "$*"; }
fail() { printf '[qapaq-platform] ERROR: %s\n' "$*" >&2; exit 1; }

[[ $(id -u) -eq 0 ]] || fail 'ejecutar como root'
docker inspect "$M" >/dev/null 2>&1 || fail "no existe el contenedor $M"
[[ -s $SECRETS/compose.env ]] || fail 'falta compose.env'
install -d -m 0700 "$PMS" "$BACKUP"
install -d -m 0750 "$ROOT" "$BIN" "$STATE" "$STATE/vulnprio"
install -d -m 0700 "$ETC"
chmod 0755 "$ROOT" "$STATE" "$STATE/vulnprio"   # la caché KEV/EPSS la lee el collector Snyk

admin_env() { # VAR → valor desde compose.env, sin exportarlo al entorno de los hijos
  python3 - "$SECRETS/compose.env" "$1" <<'PY'
import sys
for line in open(sys.argv[1], encoding="utf-8"):
    k, _, v = line.strip().partition("=")
    if k == sys.argv[2]:
        print(v.strip().strip('"').strip("'")); break
PY
}
genpw() { python3 -c 'import secrets,string; a=string.ascii_letters+string.digits; print("".join(secrets.choice(a) for _ in range(28))+"Aa9.")'; }

# ------------------------------------------------------------------ 1. identidades
IDX_ADMIN="$(admin_env INDEXER_ADMIN_PASSWORD)"; [[ -n $IDX_ADMIN ]] || fail 'INDEXER_ADMIN_PASSWORD vacío'
[[ -s $PMS/indexer-monitor-password ]] || { genpw >"$PMS/indexer-monitor-password"; chmod 600 "$PMS/indexer-monitor-password"; }
idx() { # método ruta [json por stdin]
  curl -sS -o /dev/null -w '%{http_code}' --cacert "$CERTS/root-ca.pem" --resolve wazuh.indexer:9200:127.0.0.1 \
    -K <(printf 'user = "admin:%s"\n' "$IDX_ADMIN") -X "$1" -H 'Content-Type: application/json' \
    "https://wazuh.indexer:9200$2" ${3:+--data-binary @-}
}
ok() { [[ $1 =~ ^(200|201)$ ]] || fail "$2 → HTTP $1"; }
ok "$(printf '%s' '{"description":"QAPAQ: monitor de plataforma (solo lectura, docs/20)","cluster_permissions":["cluster_monitor","cluster:admin/opendistro/ism/managedindex/explain"],"index_permissions":[{"index_patterns":["wazuh-alerts-*","wazuh-states-vulnerabilities-*"],"allowed_actions":["read"]},{"index_patterns":["*"],"allowed_actions":["indices_monitor","indices:admin/opensearch/ism/managedindex/explain"]}]}' \
  | idx PUT /_plugins/_security/api/roles/qapaq_platform_monitor x)" 'rol qapaq_platform_monitor'
ok "$(python3 -c 'import json,sys;print(json.dumps({"password":open(sys.argv[1]).read().strip(),"description":"QAPAQ: monitor de plataforma (solo lectura)"}))' "$PMS/indexer-monitor-password" \
  | idx PUT /_plugins/_security/api/internalusers/qapaq_monitor x)" 'usuario qapaq_monitor'
ok "$(printf '%s' '{"users":["qapaq_monitor"]}' | idx PUT /_plugins/_security/api/rolesmapping/qapaq_platform_monitor x)" 'mapeo qapaq_platform_monitor'
mon() { curl -sS -o /dev/null -w '%{http_code}' --cacert "$CERTS/root-ca.pem" --resolve wazuh.indexer:9200:127.0.0.1 \
  -K <(printf 'user = "qapaq_monitor:%s"\n' "$(cat "$PMS/indexer-monitor-password")") -H 'Content-Type: application/json' "$@"; }
r="$(mon --data '{"size":0}' 'https://wazuh.indexer:9200/wazuh-alerts-*/_search')"
w="$(mon -X POST --data '{"x":1}' 'https://wazuh.indexer:9200/wazuh-alerts-4.x-qapaqselftest/_doc')"
[[ $r == 200 && $w == 403 ]] || fail "autoprueba qapaq_monitor: search $r, write $w"
log "indexer: qapaq_monitor lee (HTTP $r) y no escribe (HTTP $w)"

API_ADMIN="$(admin_env WAZUH_API_PASSWORD)"; [[ -n $API_ADMIN ]] || fail 'WAZUH_API_PASSWORD vacío'
[[ -s $PMS/wazuh-api-monitor-password ]] || { genpw >"$PMS/wazuh-api-monitor-password"; chmod 600 "$PMS/wazuh-api-monitor-password"; }
docker cp "$M:/var/ossec/api/configuration/ssl/server.crt" "$PMS/wazuh-api-ca.pem"; chmod 0600 "$PMS/wazuh-api-ca.pem"
API_ADMIN="$API_ADMIN" python3 - "$PMS/wazuh-api-monitor-password" "$PMS/wazuh-api-ca.pem" <<'PY'
import base64, json, os, ssl, sys, urllib.request, urllib.error
pw = open(sys.argv[1]).read().strip()
ctx = ssl.create_default_context(cafile=sys.argv[2]); ctx.check_hostname = False
base = "https://127.0.0.1:55000"
def call(method, path, token=None, body=None, basic=None):
    req = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode())
    req.add_header("Content-Type", "application/json")
    if token: req.add_header("Authorization", "Bearer " + token)
    if basic: req.add_header("Authorization", "Basic " + base64.b64encode(basic.encode()).decode())
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=20) as r: return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"{}")
st, d = call("POST", "/security/user/authenticate", basic="wazuh-wui:" + os.environ["API_ADMIN"])
assert st == 200, f"auth admin API HTTP {st}"
tok = d["data"]["token"]
st, d = call("GET", "/security/users?search=qapaq-monitor", tok)
users = [u for u in d["data"]["affected_items"] if u["username"] == "qapaq-monitor"]
if users:
    uid = users[0]["id"]
    st, _ = call("PUT", f"/security/users/{uid}", tok, {"password": pw})
else:
    st, d = call("POST", "/security/users", tok, {"username": "qapaq-monitor", "password": pw})
    assert st == 200, f"crear usuario API HTTP {st}"
    uid = d["data"]["affected_items"][0]["id"]
st, d = call("GET", "/security/roles?search=readonly", tok)
rid = [r["id"] for r in d["data"]["affected_items"] if r["name"] == "readonly"][0]
st, d = call("GET", f"/security/users?user_ids={uid}", tok)
if rid not in d["data"]["affected_items"][0].get("roles", []):
    st, _ = call("POST", f"/security/users/{uid}/roles?role_ids={rid}", tok)
    assert st == 200, f"rol readonly HTTP {st}"
import time; time.sleep(3)  # Wazuh revoca los tokens emitidos en el mismo segundo de un cambio RBAC
st, d = call("POST", "/security/user/authenticate", basic="qapaq-monitor:" + pw)
mt = d["data"]["token"]
r, _ = call("GET", "/agents?limit=1", mt)
st, d = call("GET", f"/security/users?user_ids={uid}", tok)
roles = d["data"]["affected_items"][0].get("roles", [])
assert r == 200 and roles == [rid], f"autoprueba API: lectura {r}, roles {roles}"
print(f"[qapaq-platform] API Wazuh: qapaq-monitor lee agentes (HTTP {r}) con un único rol RBAC: readonly")
PY

docker exec -i "$PG" psql -X -q -v ON_ERROR_STOP=1 -U qapaq_admin -d qapaq_secops <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qapaq_monitor') THEN
    CREATE ROLE qapaq_monitor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $$;
ALTER ROLE qapaq_monitor PASSWORD NULL;
ALTER ROLE qapaq_monitor SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE qapaq_secops TO qapaq_monitor;
GRANT USAGE ON SCHEMA public TO qapaq_monitor;
GRANT SELECT ON public.source_poll_observations, public.source_stream_activity, public.source_health_transitions TO qapaq_monitor;
SQL
docker exec "$PG" psql -X -At -U qapaq_monitor -d qapaq_secops -c 'select count(*) from source_poll_observations' >/dev/null \
  || fail 'autoprueba Postgres qapaq_monitor'
log 'Postgres: rol qapaq_monitor (sin contraseña, solo socket local, SELECT en salud de ingesta)'

# ------------------------------------------------------------------ 2. código y configs
LOGVOL="$(docker inspect "$M" --format '{{range .Mounts}}{{if eq .Destination "/var/ossec/logs"}}{{.Source}}{{end}}{{end}}')"
[[ -d $LOGVOL ]] || fail 'no se encontró el volumen de /var/ossec/logs del manager'
OUT="$LOGVOL/qapaq-collectors"
install -d -m 0750 "$OUT"
install -m 0640 "$HERE"/qapaq_*.py "$WAZUH_SRC/provider-ingestion/common/qapaq_collector.py" \
  "$WAZUH_SRC/provider-ingestion/common/qapaq_vuln_priority.py" "$BIN/"
# collector Snyk: enriquecimiento en línea (no reinstala los collectors ni reinicia nada)
CI=/opt/qapaq/collectors/provider-ingestion
if [[ -d $CI/snyk ]]; then
  cp -a "$CI/snyk/issues.py" "$BACKUP/snyk-issues.py.orig" 2>/dev/null || true
  install -m 0640 "$WAZUH_SRC/provider-ingestion/common/qapaq_vuln_priority.py" "$CI/common/"
  install -m 0640 "$WAZUH_SRC/provider-ingestion/snyk/issues.py" "$CI/snyk/"
  if [[ -f /opt/qapaq/collectors/etc/snyk.json ]]; then
    python3 - /opt/qapaq/collectors/etc/snyk.json "$STATE/vulnprio" <<'PY'
import json, sys
p, d = sys.argv[1:3]; c = json.load(open(p)); c["vulnprio_dir"] = d
json.dump(c, open(p, "w"), indent=1)
PY
  fi
fi
find "$BIN" "$CI" -name '*.py' -exec sed -i 's/\r$//' {} + 2>/dev/null || true
for f in platform-health vulnprio; do [[ -e $OUT/$f.jsonl ]] || install -m 0640 /dev/null "$OUT/$f.jsonl"; done

python3 - "$ETC" "$STATE" "$OUT" "$PMS" "$CERTS" "$SOC_HOSTNAME" "${QAPAQ_EXPOSED_AGENTS:-}" <<'PY'
import json, os, sys
etc, state, out, pms, certs, host, agents = sys.argv[1:8]
indexer = {"url": "https://127.0.0.1:9200", "server_hostname": "wazuh.indexer", "ca_file": f"{certs}/root-ca.pem",
           "user": "qapaq_monitor", "password_file": f"{pms}/indexer-monitor-password"}
postgres = {"container": "qapaq-postgres-1", "role": "qapaq_monitor", "database": "qapaq_secops"}
def write(name, data):
    path = os.path.join(etc, name)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as s: json.dump(data, s, indent=1, ensure_ascii=False)
coll = "/opt/qapaq/collectors/state"
write("monitor.json", {
    "output_file": f"{out}/platform-health.jsonl", "state_file": f"{state}/monitor.json",
    "renotify_hours": 6, "snapshot_minutes": 60,
    "indexer": indexer, "postgres": postgres,
    "wazuh_api": {"url": "https://127.0.0.1:55000", "ca_file": f"{pms}/wazuh-api-ca.pem", "verify_hostname": False,
                  "user": "qapaq-monitor", "password_file": f"{pms}/wazuh-api-monitor-password"},
    "collectors": {
        "snyk": {"unit": "qapaq-collector-snyk", "state_file": f"{coll}/snyk.json", "interval_minutes": 15, "fail_after_intervals": 3},
        "cloudflare": {"unit": "qapaq-collector-cloudflare", "state_file": f"{coll}/cloudflare.json", "interval_minutes": 5, "fail_after_intervals": 4},
        "bitdefender": {"unit": "qapaq-collector-bitdefender", "state_file": f"{coll}/bitdefender.json", "interval_minutes": 10, "fail_after_intervals": 3},
        "vulnprio": {"unit": "qapaq-vulnprio", "state_file": f"{state}/vulnprio.json", "interval_minutes": 60, "fail_after_intervals": 3},
        "canary": {"unit": "qapaq-canary-verify", "state_file": f"{state}/canary.json", "interval_minutes": 10, "fail_after_intervals": 6},
        # SharePoint/OneDrive (docs/23): auditoría por el módulo office365 (ActivityFeed.Read) + postura; required=False si no se instalaron.
        "sharepoint-audit": {"unit": "qapaq-collector-sharepoint-audit", "state_file": f"{coll}/sharepoint-audit.json", "interval_minutes": 5, "fail_after_intervals": 4, "required": False},
        "sharepoint-posture": {"unit": "qapaq-collector-sharepoint-posture", "state_file": f"{coll}/sharepoint-posture.json", "interval_minutes": 60, "fail_after_intervals": 3, "required": False},
    },
    # Cadencia esperada por fuente. heartbeat = fuente de bajo volumen: se exige el latido del pipeline
    # (éxito del collector o receptor sano) y solo se esperan eventos dentro de event_window_hours.
    "sources": {
        "snyk": {"mode": "heartbeat", "heartbeat": {"collector": "snyk"}, "max_silence_minutes": 45, "event_window_hours": 168,
                 "query": {"term": {"rule.groups": "snyk"}}},
        "cloudflare": {"mode": "heartbeat", "heartbeat": {"collector": "cloudflare"}, "max_silence_minutes": 20, "event_window_hours": 72,
                       "query": {"term": {"rule.groups": "cloudflare"}}},
        "bitdefender": {"mode": "heartbeat", "heartbeat": {"collector": "bitdefender"}, "max_silence_minutes": 30, "event_window_hours": 26,
                        "query": {"term": {"rule.groups": "bitdefender"}}},
        "aws": {"mode": "heartbeat", "heartbeat": {"container": "qapaq-aws-events-1"}, "max_silence_minutes": 15, "event_window_hours": 72,
                "query": {"term": {"rule.groups": "aws"}}},
        # Alertas de seguridad no son un heartbeat: un entorno sin alertas se marcaba falso en silencio.
        # El manager vivo se comprueba aquí; cada agente se vigila por lastKeepAlive en agent_disconnected.
        "wazuh-agents": {"mode": "heartbeat", "heartbeat": {"container": "qapaq-wazuh.manager-1"},
                         "max_silence_minutes": 15, "event_window_hours": 0,
                         "query": {"bool": {"must_not": [{"terms": {"rule.groups": ["qapaq_provider", "office365", "aws", "qapaq_platform"]}}]}}},
        "office365": {"enabled": False, "mode": "events", "max_silence_minutes": 360, "query": {"term": {"rule.groups": "office365"}},
                      "disabled_reason": "Office 365 bloqueado: falta ActivityFeed.Read (docs/20)."},
        "sharepoint": {"mode": "heartbeat", "heartbeat": {"collector": "sharepoint-audit"}, "max_silence_minutes": 40,
                       "event_window_hours": 72, "query": {"term": {"rule.groups": "qapaq_sharepoint"}}},
    },
    "containers": {
        "required": ["qapaq-wazuh.manager-1", "qapaq-wazuh.indexer-1", "qapaq-wazuh.dashboard-1", "qapaq-api-1", "qapaq-edge-1",
                     "qapaq-postgres-1", "qapaq-wazuh-gateway-1", "qapaq-aws-events-1"],
        "optional": ["qapaq-ankay-sso-1", "qapaq-ankay-qapaq-frontend-1", "qapaq-shuffle-backend-1",
                     "qapaq-shuffle-orborus-1", "qapaq-shuffle-opensearch-1", "tenzir-node"],
        "watch_prefix": "qapaq-"},
    "agents": {"max_disconnected_minutes": 15},
    "indexer_checks": {"disk_low_pct": 85, "disk_high_pct": 90, "ism_pattern": "wazuh-*"},
    "host": {"disk_paths": ["/", "/var/lib/docker"], "disk_warn_pct": 85, "disk_crit_pct": 95, "mem_warn_pct": 92, "load_per_cpu_warn": 2.0},
    "certificates": {"warn_days": 30, "critical_days": 7, "files": [
        {"name": "edge-letsencrypt", "path": f"/etc/letsencrypt/live/{host}/fullchain.pem"},
        {"name": "indexer", "path": f"{certs}/wazuh.indexer.pem"},
        {"name": "dashboard", "path": f"{certs}/wazuh.dashboard.pem"},
        {"name": "manager-filebeat", "path": f"{certs}/wazuh.manager.pem"},
        {"name": "indexer-admin", "path": f"{certs}/admin.pem"},
        {"name": "wazuh-root-ca", "path": f"{certs}/root-ca.pem"},
        {"name": "qapaq-internal-ca", "path": "/opt/qapaq/pki/ca.pem", "required": False},
        {"name": "gateway", "path": "/opt/qapaq/pki/gateway/cert.pem", "required": False},
        {"name": "postgres", "path": "/opt/qapaq/pki/postgres/postgres.crt", "required": False},
        {"name": "wazuh-api", "path": f"{pms}/wazuh-api-ca.pem", "required": False}]},
    "qapaq_ingestion": {"max_lag_minutes": 15},
    "edge_probe": {"url": f"https://{host}/", "ok_status": [200, 301, 302, 401, 403]},
    "vulnprio": {"cache_dir": f"{state}/vulnprio", "max_age_hours": 48},
    "canary": {"state_file": f"{state}/canary.json", "max_verdict_age_hours": 26},
    "sns": {"enabled": False},
})
write("vulnprio.json", {
    "cache_dir": f"{state}/vulnprio", "state_file": f"{state}/vulnprio.json", "output_file": f"{out}/vulnprio.jsonl",
    "snyk_jsonl": f"{out}/snyk-issues.jsonl", "indexer": indexer, "refresh_hours": 24, "summary_hours": 24,
    "policy": {"epss_high": 0.5, "epss_low": 0.1, "p4_requires_no_fix": True, "max_cache_age_hours": 72},
    "exposure": {"cdb_list": "qapaq-internet-facing-projects", "snyk_projects": [], "snyk_project_patterns": [],
                 "agents": [a for a in agents.split(",") if a]},
    "manager": {"container": "qapaq-wazuh.manager-1"}, "sync_cdb_lists": True, "max_events_per_run": 500,
})
write("canary.json", {
    "state_file": f"{state}/canary.json", "deadline_minutes": 30, "check_qapaq": True, "indexer": indexer, "postgres": postgres,
    "monitor_watch": {"state_file": f"{state}/monitor.json", "stale_minutes": 30, "output_file": f"{out}/platform-health.jsonl"},
    "pipelines": {
        "snyk": {"vendor": "snyk", "source": "issues", "file": f"{out}/snyk-issues.jsonl", "unit": "qapaq-collector-snyk"},
        "cloudflare": {"vendor": "cloudflare", "source": "security", "file": f"{out}/cloudflare-security.jsonl", "unit": "qapaq-collector-cloudflare"},
        "bitdefender": {"vendor": "bitdefender", "source": "gravityzone", "file": f"{out}/bitdefender-gz.jsonl", "unit": "qapaq-collector-bitdefender"},
        "aws": {"vendor": "aws", "source": "eventbridge", "file": f"{out}/aws/aws-events.jsonl"},
        "platform": {"vendor": "qapaq-platform", "source": "monitor", "file": f"{out}/platform-health.jsonl", "unit": "qapaq-platform-monitor"},
        "vulnprio": {"vendor": "qapaq-vulnprio", "source": "vulnprio", "file": f"{out}/vulnprio.jsonl", "unit": "qapaq-vulnprio"},
        "agent": {"type": "journald"},
    },
})
PY
log "configs en $ETC (agentes expuestos a Internet: ${QAPAQ_EXPOSED_AGENTS:-ninguno})"

# ------------------------------------------------------------------ 3. feeds + listas antes del reinicio
/usr/bin/python3 -I "$BIN/qapaq_vulnprio.py" run --config "$ETC/vulnprio.json" || log 'AVISO: primera pasada de vulnprio con errores (ver arriba)'

# ------------------------------------------------------------------ 4. reglas + ossec.conf
stage="$(mktemp -d)"; trap 'rm -rf "$stage"' EXIT
cp "$HERE"/rules/*.xml "$stage/"; sed -i 's/\r$//' "$stage"/*.xml
docker cp "$M:/var/ossec/etc/ossec.conf" "$stage/ossec.conf"
cp "$stage/ossec.conf" "$BACKUP/ossec.conf"
docker cp "$M:/var/ossec/etc/rules" "$BACKUP/rules"
docker cp "$M:/var/ossec/etc/lists" "$BACKUP/lists"
python3 - "$stage/ossec.conf" "$BEGIN" "$END" <<'PY'
import re, sys, xml.etree.ElementTree as ET
path, begin, end = sys.argv[1:4]
text = open(path, encoding="utf-8").read()
text = re.sub(re.escape(begin) + r".*?" + re.escape(end) + r"\n?", "", text, flags=re.S)
for name in ("qapaq-vuln-kev", "qapaq-vuln-noise"):
    entry = f"<list>etc/lists/{name}</list>"
    if entry not in text:
        text = text.replace("<ruleset>", f"<ruleset>\n    {entry}", 1)
files = ["platform-health", "vulnprio"]
blocks = "\n".join(
    "<ossec_config>\n  <localfile>\n"
    f"    <location>/var/ossec/logs/qapaq-collectors/{f}.jsonl</location>\n"
    "    <log_format>json</log_format>\n"
    "    <label key=\"qapaq.channel\">platform-monitoring</label>\n"
    "  </localfile>\n</ossec_config>" for f in files)
text = text.rstrip("\n") + "\n" + begin + "\n" + blocks + "\n" + end + "\n"
ET.fromstring("<root>" + re.sub(r"<\?xml[^>]*\?>", "", text) + "</root>")
open(path, "w", encoding="utf-8").write(text)
PY
docker cp "$stage/." "$M:/tmp/qapaq-platform"
docker exec -u 0 "$M" bash -euo pipefail -c '
  O=/var/ossec; S=/tmp/qapaq-platform
  bak=$O/etc/qapaq-backup-platform-'"$TS"'; mkdir -p "$bak"
  cp -a $O/etc/ossec.conf "$bak/"; cp -a $O/etc/rules "$bak/rules"; cp -a $O/etc/lists "$bak/lists"
  for l in qapaq-vuln-kev qapaq-vuln-noise; do
    [[ -s $O/etc/lists/$l ]] || { printf "CVE-0000-0000.invalid:none\n" >$O/etc/lists/$l; chown wazuh:wazuh $O/etc/lists/$l; chmod 0660 $O/etc/lists/$l; }
  done
  install -o wazuh -g wazuh -m 0660 $S/qapaq_watch_platform_rules.xml $S/qapaq_watch_vulnprio_rules.xml $O/etc/rules/
  install -o root -g wazuh -m 0660 $S/ossec.conf $O/etc/ossec.conf
  if ! $O/bin/wazuh-analysisd -t >/tmp/qapaq-platform-analysisd.log 2>&1; then
    tail -20 /tmp/qapaq-platform-analysisd.log >&2
    cp -a "$bak/ossec.conf" $O/etc/ossec.conf; rm -f $O/etc/rules/qapaq_watch_platform_rules.xml $O/etc/rules/qapaq_watch_vulnprio_rules.xml
    echo "configuración inválida: revertida a $bak" >&2; exit 1
  fi
  rm -rf $S
'
log "reglas 101800-101879 instaladas; wazuh-analysisd -t OK (respaldo $BACKUP)"
HOSTCONF="$(docker inspect "$M" --format '{{range .Mounts}}{{if eq .Destination "/wazuh-config-mount/etc/ossec.conf"}}{{.Source}}{{end}}{{end}}')"
if [[ -n $HOSTCONF && -f $HOSTCONF ]]; then
  cp -p "$HOSTCONF" "$BACKUP/wazuh_manager.conf.host"
  docker cp "$M:/var/ossec/etc/ossec.conf" "$stage/persist.conf"
  cat "$stage/persist.conf" >"$HOSTCONF"
  log 'ossec.conf persistido en el montaje del host'
fi
if [[ $RESTART == true ]]; then
  docker exec -u 0 "$M" /var/ossec/bin/wazuh-control restart >/dev/null 2>&1
  log 'manager reiniciado (wazuh-control restart)'
fi

# ------------------------------------------------------------------ 5. systemd
# Solo reescribe una unit si cambió: cada escritura en /etc/systemd/system dispara FIM (101756, persistencia).
put() { if ! cmp -s "$1.new" "$1"; then mv "$1.new" "$1"; chmod 0644 "$1"; else rm -f "$1.new"; fi; }
unit() { # nombre descripción comando calendario-o-intervalo
  cat >"/etc/systemd/system/$1.service.new" <<EOF
[Unit]
Description=$2
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
User=root
UMask=0027
ExecStart=$3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ProtectKernelTunables=true
ProtectControlGroups=true
TimeoutStartSec=600
EOF
  if [[ $4 == *:* ]]; then sched="OnCalendar=$4"; else sched="OnBootSec=3min
OnUnitActiveSec=$4"; fi
  cat >"/etc/systemd/system/$1.timer.new" <<EOF
[Unit]
Description=Programa $2

[Timer]
$sched
RandomizedDelaySec=20s
Persistent=true
Unit=$1.service

[Install]
WantedBy=timers.target
EOF
  put "/etc/systemd/system/$1.service"; put "/etc/systemd/system/$1.timer"
}
PY3="/usr/bin/python3 -I"
unit qapaq-platform-monitor 'QAPAQ platform health monitor' "$PY3 $BIN/qapaq_platform_monitor.py --config $ETC/monitor.json" 5min
unit qapaq-vulnprio 'QAPAQ KEV/EPSS vulnerability prioritization' "$PY3 $BIN/qapaq_vulnprio.py run --config $ETC/vulnprio.json" 1h
unit qapaq-canary-inject 'QAPAQ synthetic canaries (inject)' "$PY3 $BIN/qapaq_canary.py inject --config $ETC/canary.json" '*-*-* 06:10:00 UTC'
unit qapaq-canary-verify 'QAPAQ synthetic canaries (verify)' "$PY3 $BIN/qapaq_canary.py verify --config $ETC/canary.json" 10min
systemctl daemon-reload
for t in qapaq-platform-monitor qapaq-vulnprio qapaq-canary-inject qapaq-canary-verify; do systemctl enable --now "$t.timer" >/dev/null; done
# Orden: verify (deja su latido) → monitor (lo ve sano) para no abrir falsos problemas al instalar.
systemctl start qapaq-canary-verify.service || true
systemctl start qapaq-platform-monitor.service || true
journalctl -u qapaq-platform-monitor.service --no-pager -o cat -n 3 | grep -E '^qapaq-platform-monitor' | tail -1 || true
log "eventos de salud: $(wc -l <"$OUT/platform-health.jsonl") · vulnprio: $(wc -l <"$OUT/vulnprio.jsonl")"
log "listo. Canarios: sudo $PY3 $BIN/qapaq_canary.py inject --config $ETC/canary.json (diario 06:10 UTC)"
