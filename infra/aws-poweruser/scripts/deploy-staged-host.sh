#!/usr/bin/env bash
# Activates one unique staged source tree and runs the host deployment while holding the shared
# host lock. Invoked by ship.sh through SSH; stdin carries at most one Entra secret assignment.
set -euo pipefail
umask 022

ROOT=/opt/qapaq
DEPLOY_LOCK=/run/lock/qapaq-wazuh-deploy.lock
if [[ ${QAPAQ_DEPLOY_LOCK_HELD:-0} != 1 ]]; then
  command -v flock >/dev/null || { echo 'flock is required to serialize QAPAQ deployments' >&2; exit 69; }
  exec 9>"$DEPLOY_LOCK"
  flock -n 9 || { echo 'another QAPAQ deployment is active on this host' >&2; exit 75; }
fi

STAGING=$ROOT/staging
RELEASES=$ROOT/releases
release_id=${1:-}
hostname=${2:-}
skip_api_build=${3:-0}
secret_present=${4:-0}

[[ $release_id =~ ^[0-9]{8}T[0-9]{6}-[a-f0-9]{4}$ ]] || {
  echo 'release id invalid' >&2
  exit 64
}
[[ $hostname =~ ^[A-Za-z0-9.-]{1,253}$ && $hostname != *..* ]] || {
  echo 'SOC_HOSTNAME invalid' >&2
  exit 64
}
[[ $skip_api_build == 0 || $skip_api_build == 1 ]] || {
  echo 'SKIP_API_BUILD invalid' >&2
  exit 64
}
[[ $secret_present == 0 || $secret_present == 1 ]] || {
  echo 'secret flag invalid' >&2
  exit 64
}

stage=$STAGING/$release_id
release=$RELEASES/$release_id
[[ -d $stage && ! -L $stage && ! -e $release ]] || {
  echo 'staged release is missing or already exists' >&2
  exit 73
}

if [[ $secret_present == 1 ]]; then
  secret_line=''
  IFS= read -r secret_line || { echo 'Entra secret input missing' >&2; exit 64; }
  [[ $secret_line == QAPAQ_ENTRA_CLIENT_SECRET=* && ${secret_line#*=} != '' && $secret_line != *$'\r'* ]] || {
    echo 'Entra secret input invalid' >&2
    exit 64
  }
  printf '%s\n' "$secret_line" | bash "$stage/infra/aws-poweruser/scripts/sync-entra-secret.sh"
  unset secret_line
fi

mkdir -p "$RELEASES"
previous_target=''
previous_directory=''
switched=0
rollback() {
  status=$?
  if ((status != 0 && switched == 1)); then
    if [[ -n $previous_target ]]; then
      ln -s "$previous_target" "$ROOT/src.rollback.$release_id"
      mv -Tf "$ROOT/src.rollback.$release_id" "$ROOT/src"
    else
      rm -f "$ROOT/src"
    fi
  fi
  return "$status"
}
trap rollback EXIT

if [[ -L $ROOT/src ]]; then
  previous_target=$(readlink "$ROOT/src")
elif [[ -d $ROOT/src ]]; then
  previous_directory=$RELEASES/legacy-$release_id
  mv "$ROOT/src" "$previous_directory"
  previous_target=${previous_directory#"$ROOT/"}
  switched=1
elif [[ -e $ROOT/src ]]; then
  echo '/opt/qapaq/src is neither a directory nor symlink' >&2
  exit 73
fi

mv "$stage" "$release"
switched=1
ln -s "$release" "$ROOT/src.next.$release_id"
mv -Tf "$ROOT/src.next.$release_id" "$ROOT/src"

find -H "$ROOT/src" -type f \( -name '*.sh' -o -name '*.tsv' -o -name '*.yml' -o -name '*.yaml' -o -name '*.template' -o -name '*.conf' \) -exec sed -i 's/\r$//' {} +
QAPAQ_DEPLOY_LOCK_HELD=1 SKIP_API_BUILD=$skip_api_build SOC_HOSTNAME=$hostname \
  bash "$ROOT/src/infra/aws-poweruser/scripts/deploy-host.sh"

trap - EXIT
echo "QAPAQ deployment completed for release $release_id"
