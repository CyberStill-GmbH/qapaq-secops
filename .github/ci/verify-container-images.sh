#!/usr/bin/env bash
set -euo pipefail

bash .github/ci/install-scanner.sh trivy
export PATH="$RUNNER_TEMP/scanners:$PATH"

docker build --file apps/api/Dockerfile --tag qapaq-ci:api .
test "$(docker run --rm qapaq-ci:api --version)" = v24.21.0

docker run --detach --name qapaq-ci-api \
  --publish 127.0.0.1:3000:3000 \
  --env QAPAQ_ENTRA_TENANT_ID=00000000-0000-0000-0000-000000000000 \
  --env QAPAQ_ENTRA_CLIENT_ID=00000000-0000-0000-0000-000000000000 \
  --env QAPAQ_ENTRA_CLIENT_SECRET_REF=secret://aws-secretsmanager/demo/entra-client-secret \
  --env QAPAQ_ENTRA_REDIRECT_URI=https://example.invalid/oauth/callback \
  --env QAPAQ_ENTRA_ALLOWED_REDIRECT_URIS=https://example.invalid/oauth/callback \
  --env QAPAQ_ACCESS_ALLOWED_CIDRS=127.0.0.1/32 \
  --env QAPAQ_ACCESS_TRUSTED_PROXY_CIDRS=127.0.0.1/32 \
  --env QAPAQ_CONSOLE_BASE_URL=https://example.invalid \
  qapaq-ci:api
trap 'docker rm --force qapaq-ci-api qapaq-ci-worker >/dev/null 2>&1 || true' EXIT
for attempt in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:3000/health/live >/dev/null; then
    break
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' qapaq-ci-api)" != 'true' ]; then
    docker logs qapaq-ci-api
    exit 1
  fi
  sleep 1
done
curl --fail --silent http://127.0.0.1:3000/health/ready
for attempt in $(seq 1 30); do
  if [ "$(docker inspect --format '{{.State.Health.Status}}' qapaq-ci-api)" = healthy ]; then
    break
  fi
  sleep 1
done
test "$(docker inspect --format '{{.State.Health.Status}}' qapaq-ci-api)" = healthy
docker stop --time 10 qapaq-ci-api
test "$(docker inspect --format '{{.State.ExitCode}}' qapaq-ci-api)" = 0
trivy image --image-src docker --scanners vuln --severity HIGH,CRITICAL --exit-code 1 --no-progress qapaq-ci:api

docker build --file apps/worker/Dockerfile --tag qapaq-ci:worker .
test "$(docker run --rm qapaq-ci:worker --version)" = v24.21.0
docker run --detach --name qapaq-ci-worker qapaq-ci:worker
sleep 3
test "$(docker inspect --format '{{.State.Running}}' qapaq-ci-worker)" = true
test -z "$(docker inspect --format '{{json .Config.ExposedPorts}}' qapaq-ci-worker | grep -v '^null$' || true)"
docker logs qapaq-ci-worker | grep -q '"event":"application.ready"'
docker stop --time 10 qapaq-ci-worker
test "$(docker inspect --format '{{.State.ExitCode}}' qapaq-ci-worker)" = 0
trivy image --image-src docker --scanners vuln --severity HIGH,CRITICAL --exit-code 1 --no-progress qapaq-ci:worker

docker build --file platform/gateway/krakend/Dockerfile --tag qapaq-ci:krakend platform/gateway/krakend
trivy image --image-src docker --scanners vuln --severity HIGH,CRITICAL --exit-code 1 --no-progress qapaq-ci:krakend
