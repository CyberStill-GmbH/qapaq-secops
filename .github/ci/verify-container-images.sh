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
  --env QAPAQ_SOC_PERSISTENCE=memory \
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
# C-1: el bundle CA de RDS debe ser legible por el usuario sin privilegios de la imagen; si
# no, `sslmode=verify-full` contra RDS fallaría en AWS (Node lo ignora con una advertencia).
if docker logs qapaq-ci-api 2>&1 | grep -q 'Ignoring extra certs'; then
  docker logs qapaq-ci-api
  exit 1
fi
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
# Solo KrakenD tiene excepciones, exactas por purl y con vencimiento (ver el archivo).
trivy image --image-src docker --scanners vuln --severity HIGH,CRITICAL --exit-code 1 --no-progress \
  --ignorefile platform/gateway/krakend/.trivyignore.yaml qapaq-ci:krakend

# C-1 — imagen migrator: mismo commit que el API. El smoke comprueba que arranca, que
# rechaza un modo desconocido con código distinto de cero y emite el evento JSON de fallo, y
# que el bundle CA es legible. La redacción de secretos en la salida (D-12) la prueba el canary
# de `platform/database/test/migrator.integration.spec.ts`, no este smoke.
docker build --file platform/database/Dockerfile.migrator --tag qapaq-ci:migrator .
set +e
migrator_output="$(docker run --rm qapaq-ci:migrator modo-invalido 2>&1)"
migrator_status=$?
set -e
test "$migrator_status" -ne 0
grep -q '"event":"failed"' <<< "$migrator_output"
grep -q '"errorCode":"MODE_INVALID"' <<< "$migrator_output"
docker run --rm --entrypoint /nodejs/bin/node qapaq-ci:migrator -e "require('node:fs').accessSync(process.env.NODE_EXTRA_CA_CERTS, require('node:fs').constants.R_OK)"
trivy image --image-src docker --scanners vuln --severity HIGH,CRITICAL --exit-code 1 --no-progress qapaq-ci:migrator
