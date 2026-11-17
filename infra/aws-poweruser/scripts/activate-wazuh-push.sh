#!/usr/bin/env bash
# Explicitly activates Wazuh push after an approved canary. Never called by deploy-host.sh.
#   QAPAQ_WAZUH_PUSH_ACTIVATE=YES SOC_HOSTNAME=... bash activate-wazuh-push.sh
set -Eeuo pipefail
umask 077

if [[ "${QAPAQ_WAZUH_PUSH_ACTIVATE:-}" != YES ]]; then
  echo 'set QAPAQ_WAZUH_PUSH_ACTIVATE=YES only after the canary and release gates are approved' >&2
  exit 2
fi
: "${SOC_HOSTNAME:?SOC_HOSTNAME is required}"
if [[ $EUID -ne 0 ]]; then echo 'run as root on the EC2 host' >&2; exit 1; fi

ROOT=/opt/qapaq
SRC=$ROOT/src
SECRETS=$ROOT/secrets
TEMPLATE=$SRC/wazuh/manager/ossec.qapaq-integrations.xml.tmpl
VALIDATOR=$SRC/wazuh/manager/integrations/validate_push_config.py
MANAGER=qapaq-wazuh.manager-1
API=qapaq-api-1
BEGIN='<!-- QAPAQ:wazuh-push:begin -->'
END='<!-- QAPAQ:wazuh-push:end -->'
log() { printf '[qapaq-wazuh-push] %s\n' "$*"; }
fail() { printf '[qapaq-wazuh-push] ERROR: %s\n' "$*" >&2; exit 1; }

install -d -o root -g root -m 0700 "$SECRETS"
docker inspect "$MANAGER" >/dev/null 2>&1 || fail 'Wazuh Manager container is not running'
docker inspect "$API" >/dev/null 2>&1 || fail 'QAPAQ API container is not running'
docker exec -u 0 "$MANAGER" test -x /var/ossec/integrations/custom-qapaq \
  || fail 'custom-qapaq wrapper is not installed; run deploy-host content setup first'
docker exec -u 0 "$MANAGER" test -s /var/ossec/integrations/custom-qapaq.py \
  || fail 'custom-qapaq implementation is not installed'
docker exec -u 0 "$MANAGER" test -s /var/ossec/etc/qapaq-wazuh-push.secret \
  || fail 'Manager HMAC file is missing; prepare the secret first'
HOSTCONF="$(docker inspect "$MANAGER" --format '{{range .Mounts}}{{if eq .Destination "/wazuh-config-mount/etc/ossec.conf"}}{{.Source}}{{end}}{{end}}')"
if [[ -z "$HOSTCONF" || ! -f "$HOSTCONF" ]]; then fail 'persistent ossec.conf host mount was not found'; fi
python3 "$VALIDATOR" "$TEMPLATE" "$SOC_HOSTNAME"

stage=$(mktemp -d "$SECRETS/.activate-wazuh-push.XXXXXX")
chmod 0700 "$stage"
manager_changed=0
host_changed=0
host_tmp=''
backup_path=''
rollback() {
  status=$?
  if [[ $status -ne 0 ]]; then
    if [[ $host_changed == 1 && -f "$stage/old.host.ossec.conf" ]]; then
      cp -p "$stage/old.host.ossec.conf" "$HOSTCONF.rollback"
      mv -f "$HOSTCONF.rollback" "$HOSTCONF"
    fi
    if [[ $manager_changed == 1 && -f "$stage/old.manager.ossec.conf" ]]; then
      docker cp "$stage/old.manager.ossec.conf" "$MANAGER:/tmp/qapaq-wazuh-push-rollback.conf" >/dev/null
      docker exec -u 0 "$MANAGER" bash -euo pipefail -c \
        'install -o root -g wazuh -m 0660 /tmp/qapaq-wazuh-push-rollback.conf /var/ossec/etc/ossec.conf; rm -f /tmp/qapaq-wazuh-push-rollback.conf; /var/ossec/bin/wazuh-analysisd -t >/dev/null 2>&1; /var/ossec/bin/wazuh-control restart >/dev/null 2>&1' \
        >/dev/null 2>&1 || true
    fi
    log 'activation failed; previous configuration restored where the change had committed'
  fi
  if [[ -n "$host_tmp" ]]; then rm -f "$host_tmp"; fi
  rm -rf "$stage"
  exit "$status"
}
trap rollback EXIT

# Read only this value into a private file. The API image is distroless and has no shell.
# Docker inspect streams env internally; awk writes only the requested key to the protected file.
docker inspect "$API" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | awk -F= '$1 == "QAPAQ_WAZUH_PUSH_SECRET" { print substr($0, index($0, "=") + 1); found++ } END { if (found != 1) exit 1 }' \
  >"$stage/api.secret"
chmod 0600 "$stage/api.secret"
docker cp "$MANAGER:/var/ossec/etc/qapaq-wazuh-push.secret" "$stage/manager.secret"
chmod 0600 "$stage/manager.secret"
python3 - "$stage/api.secret" "$stage/manager.secret" <<'PY'
import hmac
import sys
from pathlib import Path
api_file, manager_file = map(Path, sys.argv[1:])
api = api_file.read_text(encoding="ascii").strip()
manager = manager_file.read_text(encoding="ascii").strip()
if not 32 <= len(api) <= 512 or not 32 <= len(manager) <= 512 or not hmac.compare_digest(api, manager):
    raise SystemExit("API runtime and Manager HMAC secrets are not synchronized")
PY

docker cp "$MANAGER:/var/ossec/etc/ossec.conf" "$stage/old.manager.ossec.conf"
cp -p "$HOSTCONF" "$stage/old.host.ossec.conf"
python3 - "$stage/old.manager.ossec.conf" "$stage/manager.ossec.conf" "$TEMPLATE" "$SOC_HOSTNAME" "$BEGIN" "$END" <<'PY'
import re, sys, xml.etree.ElementTree as ET
from pathlib import Path
sys.path.insert(0, "/opt/qapaq/src")
from wazuh.manager.integrations.validate_push_config import validate_hostname
source, output, template, hostname, begin, end = sys.argv[1:]
validate_hostname(hostname)
root = ET.fromstring(Path(template).read_text(encoding="utf-8").replace("$" + "{SOC_HOSTNAME}", hostname))
items = [node for node in root.findall("integration") if node.findtext("name") == "custom-qapaq"]
if len(items) != 1:
    raise SystemExit("expected exactly one custom-qapaq integration")
existing = Path(source).read_text(encoding="utf-8")
without = re.sub(re.escape(begin) + r".*?" + re.escape(end) + r"\n?", "", existing, flags=re.S)
if begin not in existing and re.search(r"<name>\s*custom-qapaq\s*</name>", without):
    raise SystemExit("unmanaged custom-qapaq block exists; review ossec.conf manually")
fragment = ET.tostring(items[0], encoding="unicode")
block = f"{begin}\n<ossec_config>\n  {fragment}\n</ossec_config>\n{end}\n"
Path(output).write_text(without.rstrip() + "\n" + block, encoding="utf-8")
PY

backup_path="/var/ossec/etc/qapaq-backup-wazuh-push-$(date -u +%Y%m%dT%H%M%SZ)"
docker cp "$stage/manager.ossec.conf" "$MANAGER:/tmp/qapaq-wazuh-push.ossec.conf"
manager_changed=1
docker exec -u 0 "$MANAGER" bash -euo pipefail -c '
  O=/var/ossec; S=/tmp/qapaq-wazuh-push.ossec.conf; B="$1"
  mkdir -p "$B"; cp -a "$O/etc/ossec.conf" "$B/ossec.conf"
  install -o root -g wazuh -m 0660 "$S" "$O/etc/ossec.conf"
  if ! "$O/bin/wazuh-analysisd" -t >/tmp/qapaq-wazuh-push-analysisd.log 2>&1 || \
     ! "$O/bin/wazuh-integratord" -t >/tmp/qapaq-wazuh-push-integratord.log 2>&1; then
    cp -a "$B/ossec.conf" "$O/etc/ossec.conf"
    tail -20 /tmp/qapaq-wazuh-push-analysisd.log /tmp/qapaq-wazuh-push-integratord.log >&2 || true
    exit 1
  fi
  if ! "$O/bin/wazuh-control" restart >/dev/null 2>&1; then
    cp -a "$B/ossec.conf" "$O/etc/ossec.conf"
    "$O/bin/wazuh-control" restart >/dev/null 2>&1 || true
    exit 1
  fi
  rm -f "$S"
' bash "$backup_path"

# Persist via atomic rename only after Manager accepts and restarts the configuration.
host_tmp="$(mktemp "$HOSTCONF.qapaq-new.XXXXXX")"
cat "$stage/manager.ossec.conf" >"$host_tmp"
chown --reference="$HOSTCONF" "$host_tmp"
chmod --reference="$HOSTCONF" "$host_tmp"
mv -f "$host_tmp" "$HOSTCONF"
host_tmp=''
host_changed=1
log "custom-qapaq activated; integration filters and config tests OK; backup retained at $backup_path"
