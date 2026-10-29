#!/usr/bin/env bash
set -euo pipefail

usage='usage: verify-runtime-users.sh BACKEND WORKER ORBORUS DOCKER_GUARD APP'
backend_image="${1:?$usage}"
worker_image="${2:?$usage}"
orborus_image="${3:?$usage}"
guard_image="${4:?$usage}"
app_image="${5:?$usage}"

docker run --rm --entrypoint /bin/sh "$backend_image" -ec '
  test "$(id -u)" = 10001
  test "$(id -g)" = 10001
  test -x /app/shufflebackend
  test -w /app/generated
  probe="/app/generated/.ankay-write-check-$$"
  : > "$probe"
  rm "$probe"
  test ! -w /app_gen
  test -s /shuffle-apps/qapaq-ankay/1.0.0/api.yaml
'

docker run --rm --entrypoint /bin/sh "$worker_image" -ec '
  test "$(id -u)" = 10001
  test "$(id -g)" = 10001
  test -x /app/worker
  test ! -w /app
'

docker run --rm --entrypoint /bin/sh "$orborus_image" -ec '
  test "$(id -u)" = 10001
  test -x /app/orborus
  test ! -e /certs
  test ! -w /app
'

docker run --rm --entrypoint /bin/sh "$guard_image" -ec '
  test "$(id -u)" = 10002
  test -x /usr/local/bin/docker-guard
'

docker run --rm --entrypoint /bin/sh "$app_image" -ec '
  test "$(id -u)" = 10003
  test ! -w /app
  python -c "import walkoff_app_sdk.app_base, qapaq_ankay_logic, json; json.load(open(\"/app/ankay-catalog.json\"))"
  test -s /usr/share/licenses/shuffle-app-sdk/LICENSE
  ls /opt/ankay/playbooks/workflows/*.json >/dev/null
'
