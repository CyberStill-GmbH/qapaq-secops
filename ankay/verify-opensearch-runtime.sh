#!/usr/bin/env bash
set -euo pipefail

image="${1:?uso: verify-opensearch-runtime.sh <image>}"
container="ankay-opensearch-smoke-${GITHUB_RUN_ID:-local}"
password="$(openssl rand -hex 24)"
response="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ankay-opensearch-health.json"

cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach \
  --name "$container" \
  --publish 127.0.0.1:19200:9200 \
  --memory 2g \
  --cpus 2 \
  --ulimit memlock=-1:-1 \
  --ulimit nofile=65536:65536 \
  --sysctl vm.max_map_count=262144 \
  --env cluster.name=ankay-smoke \
  --env discovery.type=single-node \
  --env OPENSEARCH_INITIAL_ADMIN_PASSWORD="$password" \
  --env OPENSEARCH_JAVA_OPTS='-Xms512m -Xmx512m' \
  "$image" >/dev/null

healthy=false
for attempt in $(seq 1 120); do
  if curl --fail --silent --show-error --insecure \
    --user "admin:$password" \
    --output "$response" \
    https://127.0.0.1:19200/_cluster/health; then
    healthy=true
    break
  fi
  sleep 2
done

if [[ "$healthy" != true ]]; then
  echo 'OpenSearch no alcanzó health autenticado en 240 segundos.' >&2
  exit 1
fi

jq -e '.status == "green" or .status == "yellow"' "$response" >/dev/null
printf 'OpenSearch respondió health autenticado con estado %s.\n' "$(jq -r '.status' "$response")"
