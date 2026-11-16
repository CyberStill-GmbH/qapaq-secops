#!/usr/bin/env bash
# PostgreSQL LOCAL para el API QAPAQ (persistencia `postgres`). Idempotente.
#
#   bash infra/local/edge/setup-database.sh
#
#   1. bootstrap de roles (platform/database/bootstrap/roles.sql) con el usuario maestro del
#      contenedor qapaq-local-postgres-1: crea/rota qapaq_migrator y qapaq_soc_runtime con las
#      contraseñas de .env.local (QAPAQ_MIGRATOR_PASSWORD, QAPAQ_RUNTIME_PASSWORD). Las contraseñas
#      viajan por stdin a psql, nunca en argumentos ni en logs.
#   2. migrate: platform/database/migrator/entrypoint.mjs (prisma migrate deploy + post-migrate.sql)
#      como qapaq_migrator, sin TLS (Postgres local en loopback).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
pg_c="${POSTGRES_CONTAINER:-qapaq-local-postgres-1}"
set -a; . "$repo/.env.local"; set +a
: "${POSTGRES_USER:?}" "${POSTGRES_DB:?}" "${QAPAQ_MIGRATOR_PASSWORD:?}" "${QAPAQ_RUNTIME_PASSWORD:?}"
sql_quote() { printf "'%s'" "${1//\'/\'\'}"; }

{
  echo '\set ON_ERROR_STOP on'
  echo "SET qapaq.migrator_password = $(sql_quote "$QAPAQ_MIGRATOR_PASSWORD");"
  echo "SET qapaq.runtime_password = $(sql_quote "$QAPAQ_RUNTIME_PASSWORD");"
  cat "$repo/platform/database/bootstrap/roles.sql"
} | docker exec -i "$pg_c" psql -q -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null
echo 'roles qapaq_migrator y qapaq_soc_runtime listos'

(cd "$repo/platform/database" &&
  QAPAQ_POSTGRES_HOST=127.0.0.1 QAPAQ_POSTGRES_PORT="${QAPAQ_POSTGRES_PORT:-5432}" \
  QAPAQ_POSTGRES_DATABASE="$POSTGRES_DB" QAPAQ_POSTGRES_TLS=false \
  node migrator/entrypoint.mjs migrate)
