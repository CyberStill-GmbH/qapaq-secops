#!/usr/bin/env bash
set -euo pipefail

backend_image="${1:?usage: verify-runtime-users.sh BACKEND_IMAGE WORKER_IMAGE}"
worker_image="${2:?usage: verify-runtime-users.sh BACKEND_IMAGE WORKER_IMAGE}"

docker run --rm --entrypoint /bin/sh "$backend_image" -ec '
  test "$(id -u)" = 10001
  test "$(id -g)" = 10001
  test -x /app/shufflebackend
  test -w /app/generated
  probe="/app/generated/.ankay-write-check-$$"
  : > "$probe"
  rm "$probe"
  test ! -w /app_gen
'

docker run --rm --entrypoint /bin/sh "$worker_image" -ec '
  test "$(id -u)" = 10001
  test "$(id -g)" = 10001
  test -x /app/worker
  test ! -w /app
'
