#!/usr/bin/env bash
# Prepares (but does not activate) the shared HMAC secret for Wazuh push.
# Run on the EC2 host as root only after the canary gates in docs/25 are approved:
#   QAPAQ_WAZUH_PUSH_PREPARE=YES SOC_HOSTNAME=... bash prepare-wazuh-push-secret.sh
# No secret is accepted on argv, written to stdout, or passed through docker exec arguments.
set -euo pipefail
umask 077

[[ ${QAPAQ_WAZUH_PUSH_PREPARE:-} == YES ]] || {
  echo 'set QAPAQ_WAZUH_PUSH_PREPARE=YES after the documented canary gates' >&2
  exit 2
}
: "${SOC_HOSTNAME:?SOC_HOSTNAME is required}"
[[ $EUID -eq 0 ]] || { echo 'run as root on the EC2 host' >&2; exit 1; }

ROOT=/opt/qapaq
SECRETS=$ROOT/secrets
API_ENV=$SECRETS/api.env
MANAGER=qapaq-wazuh.manager-1
SRC=$ROOT/src
TEMPLATE=$SRC/wazuh/manager/ossec.qapaq-integrations.xml.tmpl
VALIDATOR=$SRC/wazuh/manager/integrations/validate_push_config.py
install -d -o root -g root -m 0700 "$SECRETS"
[[ -s $API_ENV ]] || { echo 'API secret file is missing; deploy-host must initialize it first' >&2; exit 1; }
docker inspect "$MANAGER" >/dev/null 2>&1 || { echo 'Wazuh Manager container is not running' >&2; exit 1; }

# Validate hostname and rendered XML before creating or changing secret material.
python3 "$VALIDATOR" "$TEMPLATE" "$SOC_HOSTNAME"

stage=$(mktemp -d "$SECRETS/.wazuh-push.XXXXXX")
trap 'rm -rf "$stage"' EXIT
chmod 0700 "$stage"
exec 9>"$SECRETS/.wazuh-push.lock"
flock -x 9

# Read an existing raw value if present; otherwise generate a 256-bit key. Python writes only
# protected files. It never prints the secret or interpolates it into shell command arguments.
python3 - "$API_ENV" "$stage/api.env" "$stage/manager.secret" <<'PY'
import os
import secrets
import sys
from pathlib import Path

source, api_stage, manager_stage = map(Path, sys.argv[1:])
lines = source.read_text(encoding="utf-8").splitlines()
found = [line.split("=", 1)[1] for line in lines if line.startswith("QAPAQ_WAZUH_PUSH_SECRET=")]
if len(found) > 1:
    raise SystemExit("duplicate QAPAQ_WAZUH_PUSH_SECRET entries; resolve manually")
if found:
    value = found[0].strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
else:
    value = secrets.token_hex(32)
if (
    not 32 <= len(value) <= 512
    or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in value)
):
    raise SystemExit("existing QAPAQ_WAZUH_PUSH_SECRET is invalid; no files changed")
lines = [line for line in lines if not line.startswith("QAPAQ_WAZUH_PUSH_SECRET=")]
lines.append(f"QAPAQ_WAZUH_PUSH_SECRET={value}")
api_stage.write_text("\n".join(lines) + "\n", encoding="utf-8")
manager_stage.write_text(value + "\n", encoding="ascii")
os.chmod(api_stage, 0o600)
os.chmod(manager_stage, 0o600)
PY

# Keep a protected host backup of the old Manager key so the two-file update can roll back.
manager_target=/var/ossec/etc/qapaq-wazuh-push.secret
manager_had_old=0
if docker exec -u 0 "$MANAGER" test -f "$manager_target"; then
  docker cp "$MANAGER:$manager_target" "$stage/manager.old.secret"
  chmod 0600 "$stage/manager.old.secret"
  manager_had_old=1
fi
manager_changed=0
api_changed=0
rollback() {
  status=$?
  if [[ $status -ne 0 ]]; then
    if [[ $api_changed == 1 && -f $stage/api.env.backup ]]; then
      cp -p "$stage/api.env.backup" "$SECRETS/.api.env.wazuh-push.rollback"
      mv -f "$SECRETS/.api.env.wazuh-push.rollback" "$API_ENV"
    fi
    if [[ $manager_changed == 1 ]]; then
      if [[ $manager_had_old == 1 ]]; then
        docker cp "$stage/manager.old.secret" "$MANAGER:/tmp/qapaq-wazuh-push.rollback" >/dev/null
        docker exec -u 0 "$MANAGER" sh -ceu \
          'install -o root -g wazuh -m 0640 /tmp/qapaq-wazuh-push.rollback /var/ossec/etc/qapaq-wazuh-push.secret; rm -f /tmp/qapaq-wazuh-push.rollback'
      else
        docker exec -u 0 "$MANAGER" rm -f "$manager_target"
      fi
    fi
    echo 'Wazuh push secret sync failed; restored the prior protected files where available.' >&2
  fi
  rm -rf "$stage"
  exit "$status"
}
cp -p "$API_ENV" "$stage/api.env.backup"
trap rollback EXIT

# Install the file through docker copy, then restrict it to root:wazuh. The key itself is never
# included in docker exec arguments and docker output is suppressed for file-copy operations.
docker cp "$stage/manager.secret" "$MANAGER:/tmp/qapaq-wazuh-push.secret"
docker exec -u 0 "$MANAGER" sh -ceu '
  target=/var/ossec/etc/qapaq-wazuh-push.secret
  install -o root -g wazuh -m 0640 /tmp/qapaq-wazuh-push.secret "$target"
'
manager_changed=1
docker exec -u 0 "$MANAGER" rm -f /tmp/qapaq-wazuh-push.secret >/dev/null

# Commit the API env update atomically only after the Manager's protected file is in place.
python3 - "$stage/api.env" "$API_ENV" <<'PY'
import os
import sys
from pathlib import Path

staged, target = map(Path, sys.argv[1:])
replacement = target.with_name(".api.env.wazuh-push.tmp")
replacement.write_bytes(staged.read_bytes())
os.chmod(replacement, 0o600)
os.replace(replacement, target)
PY
api_changed=1

echo 'Wazuh push HMAC secret synchronized to protected files; API/Manager were not restarted and integration was not enabled.'
