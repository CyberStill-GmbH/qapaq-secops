#!/usr/bin/env bash
# QAPAQ SOC — helpers comunes de las políticas (docs/16-politicas.md). Se carga con `source`.
#
# Corre EN el host que tiene los contenedores Wazuh (EC2 PowerUser o local con Docker Desktop):
# todo pasa por `docker exec`/`docker cp`, nunca por SSH ni por la API pública.
#
# Variables (todas opcionales):
#   QAPAQ_MANAGER_CONTAINER   contenedor del manager (autodetecta *wazuh.manager*)
#   QAPAQ_INDEXER_CONTAINER   contenedor del indexer (autodetecta *wazuh.indexer*)
#   QAPAQ_SECRETS_DIR         por defecto /opt/qapaq/secrets (compose.env con INDEXER_ADMIN_PASSWORD)
#   QAPAQ_INDEXER_ADMIN_PASSWORD  sobreescribe el archivo de secretos (pruebas locales)
#   QAPAQ_INDEXER_TLS_NAME    nombre del certificado del indexer (por defecto wazuh.indexer)
#
# Sin secretos en argumentos: la credencial viaja a curl por stdin (-K -), nunca por `ps`.

export PYTHONIOENCODING=utf-8
export MSYS_NO_PATHCONV=1 # Git Bash en Windows: no reescribir /var/ossec/... como rutas de Windows
QAPAQ_POLICY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QAPAQ_REPO_ROOT="$(cd "$QAPAQ_POLICY_LIB_DIR/../../.." && pwd)"

# Ruta del host en forma que entiendan docker y Python también desde Git Bash (C:/...).
qapaq_hp() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

qapaq_log() { printf '[qapaq-policy] %s\n' "$*"; }
qapaq_die() { printf '[qapaq-policy] ERROR %s\n' "$*" >&2; exit 1; }

qapaq_python() {
  local p
  for p in python3 python; do
    if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import sys; sys.exit(sys.version_info < (3, 8))' >/dev/null 2>&1; then
      local a=() x
      for x in "$@"; do if [[ -e "$x" || ( "$x" == /* && -d "$(dirname "$x")" ) ]]; then a+=("$(qapaq_hp "$x")"); else a+=("$x"); fi; done
      "$p" "${a[@]}" | tr -d '\r'; return "${PIPESTATUS[0]}"
    fi
  done
  qapaq_die 'se requiere Python 3.8+ en el host'
}

_qapaq_find_container() {
  docker ps --format '{{.Names}}' | grep -E -- "$1" | head -n1
}

qapaq_manager() {
  if [[ -z "${QAPAQ_MANAGER_CONTAINER:-}" ]]; then
    QAPAQ_MANAGER_CONTAINER="$(_qapaq_find_container 'wazuh\.manager')"
    [[ -n "$QAPAQ_MANAGER_CONTAINER" ]] || qapaq_die 'no hay contenedor wazuh.manager en ejecución'
  fi
  printf '%s' "$QAPAQ_MANAGER_CONTAINER"
}

qapaq_indexer_container() {
  if [[ -z "${QAPAQ_INDEXER_CONTAINER:-}" ]]; then
    QAPAQ_INDEXER_CONTAINER="$(_qapaq_find_container 'wazuh\.indexer')"
    [[ -n "$QAPAQ_INDEXER_CONTAINER" ]] || qapaq_die 'no hay contenedor wazuh.indexer en ejecución'
  fi
  printf '%s' "$QAPAQ_INDEXER_CONTAINER"
}

# Ejecuta un comando dentro del manager como root.
qapaq_mexec() { docker exec -u 0 "$(qapaq_manager)" "$@"; }
qapaq_mexec_i() { docker exec -i -u 0 "$(qapaq_manager)" "$@"; }

_qapaq_indexer_password() {
  if [[ -n "${QAPAQ_INDEXER_ADMIN_PASSWORD:-}" ]]; then
    printf '%s' "$QAPAQ_INDEXER_ADMIN_PASSWORD"; return
  fi
  local f="${QAPAQ_SECRETS_DIR:-/opt/qapaq/secrets}/compose.env"
  [[ -r "$f" ]] || qapaq_die "no se puede leer $f (o definir QAPAQ_INDEXER_ADMIN_PASSWORD)"
  # Solo la línea necesaria; no se hace `source` de todo el archivo de secretos.
  local v
  v="$(grep -E '^INDEXER_ADMIN_PASSWORD=' "$f" | tail -n1 | cut -d= -f2-)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  [[ -n "$v" ]] || qapaq_die "INDEXER_ADMIN_PASSWORD vacío en $f"
  printf '%s' "$v"
}

QAPAQ_WORK="$(mktemp -d)"
trap 'rm -rf "$QAPAQ_WORK"' EXIT

# qapaq_indexer <método> <ruta> [archivo-json-local]
#   Deja INDEXER_STATUS (código HTTP) e INDEXER_BODY (archivo local con la respuesta).
qapaq_indexer() {
  local method="$1" path="$2" body="${3:-}" idx name remote_body="" pw
  idx="$(qapaq_indexer_container)"
  name="${QAPAQ_INDEXER_TLS_NAME:-wazuh.indexer}"
  if [[ -n "$body" ]]; then
    remote_body="/tmp/qapaq-body-$$-$RANDOM.json"
    docker cp "$(qapaq_hp "$body")" "$idx:$remote_body" >/dev/null
  fi
  pw="$(_qapaq_indexer_password)"
  local args=(curl -sS -K - -o /dev/stdout -w '\n%{http_code}'
    --cacert /usr/share/wazuh-indexer/config/certs/root-ca.pem
    --resolve "$name:9200:127.0.0.1" -X "$method" -H 'content-type: application/json')
  [[ -n "$remote_body" ]] && args+=(--data-binary "@$remote_body")
  args+=("https://$name:9200$path")
  local out
  out="$(printf 'user = "admin:%s"\n' "$pw" | docker exec -i "$idx" "${args[@]}")" || true
  [[ -n "$remote_body" ]] && docker exec -u 0 "$idx" rm -f "$remote_body" >/dev/null 2>&1 || true
  INDEXER_STATUS="${out##*$'\n'}"
  INDEXER_BODY="$QAPAQ_WORK/indexer-$RANDOM.json"
  printf '%s' "${out%$'\n'*}" >"$INDEXER_BODY"
}

# jq-like con Python: qapaq_json <archivo> <expresión python sobre `d`>
qapaq_json() {
  qapaq_python - "$1" "$2" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
r = eval(sys.argv[2], {"d": d})
print(json.dumps(r) if isinstance(r, (dict, list)) else r)
PY
}

# Contador PASS/FAIL para verify.
QAPAQ_PASS=0; QAPAQ_FAIL=0; QAPAQ_WARN=0
qapaq_check() { # qapaq_check <PASS|FAIL|WARN> <id> <detalle>
  case "$1" in
    PASS) QAPAQ_PASS=$((QAPAQ_PASS + 1)) ;;
    FAIL) QAPAQ_FAIL=$((QAPAQ_FAIL + 1)) ;;
    WARN) QAPAQ_WARN=$((QAPAQ_WARN + 1)) ;;
  esac
  printf '%-4s  %-38s %s\n' "$1" "$2" "$3"
}
