#!/usr/bin/env bash
set -euo pipefail

action="${1:-apply}"
site=/etc/nginx/sites-available/default
format=/etc/nginx/conf.d/30-qapaq-api-no-query-log.conf
backup_dir=/var/backups/qapaq-api-no-query-log
site_backup="$backup_dir/default.before-qapaq-no-query-log"
format_backup="$backup_dir/format.before-qapaq-no-query-log"
format_absent_marker="$backup_dir/format.was-absent"
site_applied_hash="$backup_dir/default.applied.sha256"
format_applied_hash="$backup_dir/format.applied.sha256"
access_directive='access_log /var/log/nginx/qapaq-api-access.log qapaq_no_query;'
error_directive='error_log /dev/null emerg;'

if [[ "$EUID" -ne 0 ]]; then
  echo 'Run this script as root.' >&2
  exit 1
fi

restore_files() {
  if [[ ! -f "$site_backup" ]]; then
    echo 'No saved Nginx configuration exists for rollback.' >&2
    return 1
  fi
  cp -a "$site_backup" "$site"
  if [[ -f "$format_backup" ]]; then
    cp -a "$format_backup" "$format"
  elif [[ -f "$format_absent_marker" ]]; then
    rm -f "$format"
  else
    echo 'No saved state exists for the Nginx log format file.' >&2
    return 1
  fi
}

case "$action" in
  apply)
    [[ -f "$site" ]] || { echo 'Expected Nginx site config is missing.' >&2; exit 1; }
    [[ -d /etc/nginx/conf.d ]] || { echo 'Expected Nginx conf.d directory is missing.' >&2; exit 1; }
    nginx -t
    install -d -m 0700 "$backup_dir"
    backup_existed=0
    if [[ -e "$site_backup" ]]; then backup_existed=1; fi

    site_snapshot="$(mktemp)"
    format_snapshot="$(mktemp)"
    cp -a "$site" "$site_snapshot"
    format_existed=0
    if [[ -f "$format" ]]; then
      cp -a "$format" "$format_snapshot"
      format_existed=1
    fi
    rollback_current() {
      cp -a "$site_snapshot" "$site"
      if [[ "$format_existed" == 1 ]]; then
        cp -a "$format_snapshot" "$format"
      else
        rm -f "$format"
      fi
      nginx -t && systemctl reload nginx || true
      rm -f "$site_snapshot" "$format_snapshot"
      if [[ "$backup_existed" == 0 ]]; then
        rm -f "$site_backup" "$format_backup" "$format_absent_marker" "$site_applied_hash" "$format_applied_hash"
        rmdir "$backup_dir" 2>/dev/null || true
      fi
    }
    trap rollback_current ERR

    python3 - "$site" "$access_directive" "$error_directive" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
access_directive, error_directive = sys.argv[2:]
text = path.read_text()
pattern = re.compile(r'(?m)^(?P<indent>[ \t]*)location\s+\^~\s+/qapaq-api/\s*\{')
matches = list(pattern.finditer(text))
if len(matches) != 1:
    raise SystemExit('Expected exactly one /qapaq-api/ location block.')
start = matches[0].end()
end = re.search(r'(?m)^\s*\}', text[start:])
if end is None:
    raise SystemExit('Could not find the end of the /qapaq-api/ location block.')
block = text[start : start + end.start()]
lines = [line.strip() for line in block.splitlines()]
access_count = lines.count(access_directive)
error_count = lines.count(error_directive)
has_access = access_count == 1
has_error = error_count == 1
if has_access and has_error:
    raise SystemExit(0)
if access_count > 1 or error_count > 1 or has_access or has_error:
    raise SystemExit('The /qapaq-api/ location has a partial QAPAQ log policy; refusing to guess how to repair it.')
if re.search(r'(?m)^\s*(access_log|error_log)\s+', block):
    raise SystemExit('The /qapaq-api/ location already defines access_log or error_log; refusing to override it.')
updated = text[:start] + '\n    ' + access_directive + '\n    ' + error_directive + text[start:]
path.write_text(updated)
PY

    cat > "$format" <<'NGINX'
log_format qapaq_no_query '$time_iso8601 $request_id "$request_method $uri $server_protocol" $status $body_bytes_sent $request_time';
NGINX
    chmod 0644 "$format"

    if [[ ! -e "$site_backup" ]]; then
      cp -a "$site_snapshot" "$site_backup"
      if [[ "$format_existed" == 1 ]]; then
        cp -a "$format_snapshot" "$format_backup"
      else
        touch "$format_absent_marker"
      fi
    fi

    nginx -t
    sha256sum "$site" | cut -d ' ' -f 1 > "$site_applied_hash"
    sha256sum "$format" | cut -d ' ' -f 1 > "$format_applied_hash"
    systemctl reload nginx
    trap - ERR
    rm -f "$site_snapshot" "$format_snapshot"
    echo 'QAPAQ API access logs omit query/client IP/referrer; Nginx request errors for this location are suppressed.'
    ;;

  rollback)
    if [[ ! -e "$site_backup" ]]; then
      if ! grep -Fq "$access_directive" "$site" 2>/dev/null &&
        ! grep -Fq "$error_directive" "$site" 2>/dev/null && [[ ! -e "$format" ]]; then
        echo 'QAPAQ API access logging is already rolled back.'
        exit 0
      fi
      echo 'No saved Nginx configuration exists for rollback.' >&2
      exit 1
    fi
    if [[ ! -f "$site_applied_hash" || ! -f "$format_applied_hash" ]] ||
      [[ "$(sha256sum "$site" | cut -d ' ' -f 1)" != "$(cat "$site_applied_hash")" ]] ||
      [[ "$(sha256sum "$format" | cut -d ' ' -f 1)" != "$(cat "$format_applied_hash")" ]]; then
      echo 'Nginx configuration changed since this workflow applied it; refusing to overwrite newer edits.' >&2
      exit 1
    fi
    restore_files
    if ! nginx -t; then
      echo 'Nginx configuration test failed after rollback; manual recovery is required.' >&2
      exit 1
    fi
    if ! systemctl reload nginx; then
      echo 'Nginx reload failed after rollback; manual recovery is required.' >&2
      exit 1
    fi
    rm -f "$site_backup" "$format_backup" "$format_absent_marker" "$site_applied_hash" "$format_applied_hash"
    rmdir "$backup_dir" 2>/dev/null || true
    echo 'QAPAQ API access logging rollback completed.'
    ;;

  *)
    echo 'Usage: qapaq-api-no-query-logging.sh apply|rollback' >&2
    exit 2
    ;;
esac
