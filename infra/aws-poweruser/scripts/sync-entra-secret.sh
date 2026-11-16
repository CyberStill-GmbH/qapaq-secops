#!/usr/bin/env bash
# Reads exactly one QAPAQ_ENTRA_CLIENT_SECRET assignment from stdin and stores it privately.
set -euo pipefail
umask 077

ROOT=/opt/qapaq
SECRETS=$ROOT/secrets
FILE=$SECRETS/services.env
IFS= read -r secret_line || { echo 'Entra secret input missing' >&2; exit 1; }
[[ $secret_line == QAPAQ_ENTRA_CLIENT_SECRET=* && ${secret_line#*=} != '' && $secret_line != *$'\r'* ]] \
  || { echo 'Entra secret input invalid' >&2; exit 1; }
install -d -o root -g root -m 0700 "$SECRETS"
tmp="$(mktemp "$SECRETS/.services.env.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
if [[ -f $FILE ]]; then
  grep -v '^QAPAQ_ENTRA_CLIENT_SECRET=' "$FILE" >"$tmp" || true
fi
printf '%s\n' "$secret_line" >>"$tmp"
chown root:root "$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$FILE"
trap - EXIT
unset secret_line
