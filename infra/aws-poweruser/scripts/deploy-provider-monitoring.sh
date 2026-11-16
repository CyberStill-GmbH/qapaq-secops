#!/usr/bin/env bash
# Installs provider pollers and read-only JSONL inputs. Does not start/redeploy SOAR services.
set -euo pipefail
umask 027
ROOT=/opt/qapaq
SRC=$ROOT/src
SECRETS=$ROOT/secrets/provider-services
WD=$ROOT/wazuh-docker/single-node
HOST=$SRC/infra/aws-poweruser/host
MANAGER=qapaq-wazuh.manager-1
UNITS=$SRC/wazuh/provider-ingestion/systemd
RULES=$SRC/infra/wazuh/launch-detections/rules/qapaq_provider_service_rules.xml
LOG_DIR=$ROOT/provider-ingestion/logs
STATE_DIR=$ROOT/provider-ingestion/state
BACKUP=$ROOT/backups/provider-monitoring-$(date -u +%Y%m%dT%H%M%SZ)
EDGE_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
[[ -s $EDGE_CA_BUNDLE && -r $EDGE_CA_BUNDLE ]] || {
  echo "host CA bundle missing or unreadable: $EDGE_CA_BUNDLE" >&2
  exit 1
}
[[ -d $SECRETS ]] || { echo 'provider-services secret directory missing' >&2; exit 1; }
[[ -f $SRC/wazuh/provider-ingestion/third_party.py && -f $RULES ]] || { echo 'provider source or rules missing' >&2; exit 1; }
install -d -m 0750 -o 1000 -g 1000 "$LOG_DIR"
install -d -m 0700 "$STATE_DIR" "$BACKUP"
for f in "$LOG_DIR/cloudflare.jsonl" "$LOG_DIR/snyk.jsonl" "$LOG_DIR/bitdefender.jsonl" "$LOG_DIR/health.jsonl"; do
  [[ -e $f ]] || install -m 0640 -o 1000 -g 1000 /dev/null "$f"
done
chown -R 1000:1000 "$LOG_DIR"
chmod 0750 "$LOG_DIR"
chmod 0640 "$LOG_DIR"/*.jsonl
for unit in qapaq-provider-ingest@.service qapaq-provider-cloudflare.timer qapaq-provider-snyk.timer qapaq-provider-bitdefender.timer qapaq-provider-m365-health.timer; do
  install -m 0644 "$UNITS/$unit" "/etc/systemd/system/$unit"
done
docker cp "$MANAGER:/var/ossec/etc/ossec.conf" "$BACKUP/ossec.conf"
docker cp "$MANAGER:/var/ossec/etc/rules" "$BACKUP/rules"
python3 - "$BACKUP/ossec.conf" <<'PY'
import pathlib, sys, xml.etree.ElementTree as ET
path = pathlib.Path(sys.argv[1])
begin, end = "<!-- QAPAQ:provider-services:begin -->", "<!-- QAPAQ:provider-services:end -->"
vendors = ("cloudflare", "snyk", "bitdefender", "health")
blocks = []
for vendor in vendors:
    blocks.append(
        "  <localfile>\n"
        f"    <location>/var/ossec/logs/qapaq-providers/{vendor}.jsonl</location>\n"
        "    <log_format>json</log_format>\n"
        f"    <label key=\"integration.vendor\">{vendor}</label>\n"
        "    <label key=\"integration.channel\">provider-api</label>\n"
        "  </localfile>"
    )
block = begin + "\n" + "\n".join(blocks) + "\n" + end
text = path.read_text(encoding="utf-8")
if text.count(begin) != text.count(end) or text.count(begin) > 1:
    raise SystemExit("provider-services markers are malformed")
if begin in text:
    start = text.index(begin)
    finish = text.index(end, start) + len(end)
    text = text[:start] + text[finish:]
closing = text.rfind("</ossec_config>")
if closing < 0:
    raise SystemExit("ossec.conf has no closing ossec_config")
text = text[:closing] + block + "\n" + text[closing:]
ET.fromstring(text)
path.write_text(text, encoding="utf-8")
PY
docker cp "$BACKUP/ossec.conf" "$MANAGER:/var/ossec/etc/ossec.conf"
docker cp "$RULES" "$MANAGER:/tmp/qapaq_provider_service_rules.xml"
docker exec -u 0 "$MANAGER" install -o wazuh -g wazuh -m 0660 /tmp/qapaq_provider_service_rules.xml /var/ossec/etc/rules/qapaq_provider_service_rules.xml
docker exec -u 0 "$MANAGER" /var/ossec/bin/wazuh-analysisd -t
COMPOSE=(docker compose --env-file "$ROOT/secrets/compose.env" -f "$WD/docker-compose.yml" -f "$HOST/compose.qapaq.yaml" -f "$HOST/compose.providers.yaml")
"${COMPOSE[@]}" config -q
"${COMPOSE[@]}" up -d --no-deps --force-recreate wazuh.manager
systemctl daemon-reload
for timer in qapaq-provider-cloudflare.timer qapaq-provider-snyk.timer qapaq-provider-bitdefender.timer qapaq-provider-m365-health.timer; do
  systemctl enable --now "$timer"
done
for vendor in cloudflare snyk bitdefender m365; do
  if systemctl start "qapaq-provider-ingest@$vendor.service"; then
    printf '%s collector=started\n' "$vendor"
  else
    printf '%s collector=degraded\n' "$vendor"
  fi
done
"${COMPOSE[@]}" ps wazuh.manager
printf 'provider log lines: cloudflare=%s snyk=%s bitdefender=%s health=%s\n' "$(wc -l <"$LOG_DIR/cloudflare.jsonl")" "$(wc -l <"$LOG_DIR/snyk.jsonl")" "$(wc -l <"$LOG_DIR/bitdefender.jsonl")" "$(wc -l <"$LOG_DIR/health.jsonl")"
printf 'SOAR services were not touched.\n'
