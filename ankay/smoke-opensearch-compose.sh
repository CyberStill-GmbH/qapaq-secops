#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="${RUNNER_TEMP:?RUNNER_TEMP is required}/ankay-runtime"
source_archive="$runtime_dir/shuffle-corresponding-source.tar.gz"
source_dir="$RUNNER_TEMP/ankay-opensearch-smoke-source"
compose_file="$root/ankay/runtime/opensearch-smoke.compose.yml"
lock_file="$root/ankay/azure-components.lock.json"
project_name="ankay-os-smoke-${GITHUB_RUN_ID:-local}"
opensearch_image="$(jq -r '.sources.opensearch.repository + "@" + .sources.opensearch.amd64Digest' "$lock_file")"
backend_image="ankay-qapaq-backend:${GITHUB_SHA:-local}"
go_builder_image="$(jq -r '.buildBases.golang1273Alpine323' "$lock_file")"
ca_file="$RUNNER_TEMP/ankay-opensearch-root-ca.pem"
bootstrap_file="$RUNNER_TEMP/ankay-smoke-admin.json"
bootstrap_response="$RUNNER_TEMP/ankay-smoke-registration.json"
bootstrap_username="ankay-smoke-${GITHUB_RUN_ID:-local}@example.invalid"
bootstrap_password="Aa1!$(openssl rand -hex 24)"
# OpenSearch's demo-security bootstrap rejects hex-only passwords. Keep the
# generated password ephemeral while guaranteeing every required character class.
smoke_password="Aa1!$(openssl rand -hex 24)"

[[ -f "$source_archive" ]] || { echo 'Falta el tar reproducible de fuente Shuffle generado por el build.' >&2; exit 1; }
mkdir -p "$source_dir"
tar -xzf "$source_archive" -C "$source_dir"

export COMPOSE_PROJECT_NAME="$project_name"
export OPENSEARCH_IMAGE="$opensearch_image"
export BACKEND_IMAGE="$backend_image"
export OPENSEARCH_CA_HOST_PATH="$ca_file"
export SMOKE_OPENSEARCH_PASSWORD="$smoke_password"
cleanup() {
  status=$?
  if (( status != 0 )); then
    echo 'Compose/API smoke failed; collecting ephemeral service logs before cleanup.' >&2
    docker compose -f "$compose_file" logs --no-color backend opensearch memcached \
      | sed -E 's/(api key )[[:alnum:]_-]+/\1[REDACTED]/Ig' >&2 || true
  fi
  docker compose -f "$compose_file" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ca_file" "$bootstrap_file" "$bootstrap_response"
}
trap cleanup EXIT

docker compose -f "$compose_file" up --detach --wait --wait-timeout 180 opensearch memcached
opensearch_container="$(docker compose -f "$compose_file" ps --quiet opensearch)"
[[ -n "$opensearch_container" ]] || { echo 'OpenSearch smoke container did not start.' >&2; exit 1; }
docker cp "$opensearch_container:/usr/share/opensearch/config/root-ca.pem" "$ca_file"
openssl x509 -in "$ca_file" -noout -subject >/dev/null
docker compose -f "$compose_file" up --detach backend
# Wait for the backend's listener and its OpenSearch connection before using
# the first-user endpoint. This health route does not require an organization.
curl --fail --silent --show-error --retry 90 --retry-connrefused --retry-all-errors --retry-delay 2 \
  http://127.0.0.1:15001/api/v1/_ah/health --output /dev/null
# Shuffle's supported first-user registration bootstraps the initial admin,
# default organization, environment, and API key in a clean OpenSearch store.
# These credentials and the created indexes are confined to this disposable smoke.
jq -cn --arg username "$bootstrap_username" --arg password "$bootstrap_password" \
  '{username: $username, password: $password}' > "$bootstrap_file"
curl --fail --silent --show-error --retry 90 --retry-connrefused --retry-delay 2 \
  --header 'Content-Type: application/json' --data-binary "@$bootstrap_file" \
  "http://127.0.0.1:15001/api/v1/users/register" \
  --output "$bootstrap_response"
jq -e '.success == true' "$bootstrap_response" >/dev/null || {
  echo 'Shuffle first-user registration did not bootstrap an admin organization.' >&2
  exit 1
}

health_status="$(curl --silent --show-error --retry 90 --retry-connrefused --retry-all-errors --retry-delay 2 \
  http://127.0.0.1:15001/api/v1/health?force=true \
  --output "$RUNNER_TEMP/ankay-backend-health.json" --write-out '%{http_code}')"

# Full health initializes Shuffle's default indexes in a clean store. Inspect
# the mapping only after that supported bootstrap path has run.
curl --fail --silent --show-error --retry 30 --retry-connrefused --retry-all-errors --retry-delay 2 \
  --cacert "$ca_file" --resolve node-0.example.com:19200:127.0.0.1 \
  --user "admin:$smoke_password" \
  https://node-0.example.com:19200/workflow-000001/_mapping \
  | jq -e 'to_entries | length == 1 and .[0].value.mappings.properties.actions.properties.parameters.properties.example.type == "keyword"' >/dev/null || {
    echo 'El índice workflow no aplicó el mapping keyword para actions.parameters.example.' >&2
    exit 1
  }

jq -e '.success == true' "$RUNNER_TEMP/ankay-backend-health.json" >/dev/null && [[ "$health_status" == 200 ]] || {
  echo 'Shuffle API health no devolvió success=true contra OpenSearch candidato.' >&2
  echo "HTTP status: $health_status" >&2
  cat "$RUNNER_TEMP/ankay-backend-health.json" >&2
  docker compose -f "$compose_file" logs --no-color backend opensearch >&2
  exit 1
}

docker run --rm --network "${project_name}_smoke" \
  --volume "$source_dir:/src:ro" \
  --volume "$ca_file:/run/ankay/opensearch-ca/ca.pem:ro" \
  --workdir /src/shuffle/backend/go-app \
  --env SHUFFLE_ELASTIC=true \
  --env SHUFFLE_OPENSEARCH_CERTIFICATE_FILE=/run/ankay/opensearch-ca/ca.pem \
  --env SHUFFLE_OPENSEARCH_PASSWORD="$smoke_password" \
  --env SHUFFLE_OPENSEARCH_SKIPSSL_VERIFY=false \
  --env SHUFFLE_OPENSEARCH_URL=https://node-0.example.com:9200 \
  --env SHUFFLE_OPENSEARCH_USERNAME=admin \
  --env SHUFFLE_MEMCACHED=memcached:11211 \
  "$go_builder_image" \
  sh -c 'go build -tags=integration -o /tmp/shuffle-os-integration ./test-suite && /tmp/shuffle-os-integration -test.v -test.run "^(TestOpensearchInit|TestWorkflowStorageRoundTrip)$"'

echo 'Shuffle v2.3.0 backend health and OpenSearch storage round-trip passed against the candidate digest.'
