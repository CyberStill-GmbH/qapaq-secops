#!/usr/bin/env bash
# QAPAQ SecOps — instala o actualiza el núcleo QAPAQ en el host del SIEM (docs/12, opción B). Idempotente.
#
#   1. Usuario de sistema `qapaq-core` (sin shell ni home).
#   2. Descarga el release (URL prefirmada), verifica su SHA256 y lo extrae en
#      /opt/qapaq-core/releases/<sha>. Conserva los 3 anteriores: rollback e histórico.
#   3. Renderiza /etc/qapaq-core/core.env (0640 root:qapaq-core) desde el parámetro SSM con el
#      entorno (generado por Terraform) y los secretos de Secrets Manager por el rol de la instancia.
#      Los valores no se imprimen, y NO se crea ni rota ningún secreto: solo se leen.
#   4. Cambia /opt/qapaq-core/current con un enlace atómico, reinicia la API y espera
#      /health/ready. Si falla, vuelve al release anterior. Después reinicia el worker.
#
# Variables: QAPAQ_CORE_URL, QAPAQ_CORE_SHA256, QAPAQ_CORE_ENV_PARAM (p. ej.
#            /qapaq-secops/demo/core/environment) y QAPAQ_AWS_REGION.
set -euo pipefail
umask 077
fail() { printf 'qapaq-core: ERROR %s\n' "$1" >&2; exit 1; }
info() { printf 'qapaq-core: %s\n' "$1"; }
: "${QAPAQ_CORE_URL:?}" "${QAPAQ_CORE_SHA256:?}" "${QAPAQ_CORE_ENV_PARAM:?}" "${QAPAQ_AWS_REGION:?}"
[[ "$QAPAQ_CORE_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail 'QAPAQ_CORE_SHA256 inválido'
command -v aws >/dev/null || fail 'falta aws cli en el host'
command -v jq >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq >/dev/null

BASE=/opt/qapaq-core
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT

# 1 · usuario
id qapaq-core >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin qapaq-core

# 2 · release verificado
curl -fsS --max-time 600 -o "$work/core.tar.gz" "$QAPAQ_CORE_URL"
echo "${QAPAQ_CORE_SHA256}  $work/core.tar.gz" | sha256sum -c - >/dev/null || fail 'checksum del release no coincide'
mkdir -p "$BASE/releases"
top="$(tar -tzf "$work/core.tar.gz" | head -1 | cut -d/ -f1)"
[[ "$top" =~ ^qapaq-core-[0-9a-f]{12}$ ]] || fail "release con estructura inesperada ($top)"
release="$BASE/releases/${top#qapaq-core-}"
if [[ ! -d "$release" ]]; then
  tar -C "$work" -xzf "$work/core.tar.gz"
  mv "$work/$top" "$release"
  chown -R root:qapaq-core "$release"; chmod -R g+rX,o-rwx "$release"
fi
info "release ${release##*/} listo"

# 3 · entorno y secretos (sin imprimir valores)
install -d -m 0750 -o root -g qapaq-core /etc/qapaq-core
aws ssm get-parameter --region "$QAPAQ_AWS_REGION" --name "$QAPAQ_CORE_ENV_PARAM" \
  --query Parameter.Value --output text >"$work/env.json"
jq -e '.environment and .secrets' "$work/env.json" >/dev/null || fail 'parámetro de entorno inválido'
envfile="$work/core.env"
# EnvironmentFile de systemd: KEY="valor" con \ y " escapados; sin saltos de línea.
emit() { python3 -c 'import sys;k,v=sys.argv[1],sys.stdin.read();assert "\n" not in v.rstrip("\n"),k;v=v.rstrip("\n").replace("\\","\\\\").replace("\"","\\\"");print(f"{k}=\"{v}\"")' "$1"; }
jq -r '.environment | to_entries[] | [.key, .value] | @tsv' "$work/env.json" |
  while IFS=$'\t' read -r key value; do printf '%s' "$value" | emit "$key"; done >"$envfile"
jq -r '.secrets | to_entries[] | [.key, .value] | @tsv' "$work/env.json" |
  while IFS=$'\t' read -r key ref; do
    # Igual que ECS: "arn" o "arn:clave-json::"
    arn="$ref"; jsonkey=''
    if [[ "$ref" =~ ^(arn:aws:secretsmanager:[^:]+:[0-9]+:secret:[^:]+):([^:]+)::$ ]]; then
      arn="${BASH_REMATCH[1]}"; jsonkey="${BASH_REMATCH[2]}"
    fi
    value="$(aws secretsmanager get-secret-value --region "$QAPAQ_AWS_REGION" --secret-id "$arn" \
      --query SecretString --output text)" || fail "no se pudo leer el secreto de $key"
    [[ -n "$jsonkey" ]] && value="$(printf '%s' "$value" | jq -r --arg k "$jsonkey" '.[$k]')"
    printf '%s' "$value" | emit "$key"
  done >>"$envfile"
install -m 0640 -o root -g qapaq-core "$envfile" /etc/qapaq-core/core.env
info "core.env renderizado ($(wc -l </etc/qapaq-core/core.env) variables; valores no impresos)"

# 4 · activación atómica con rollback
previous="$(readlink -f "$BASE/current" 2>/dev/null || true)"
install -m 0644 "$release"/systemd/qapaq-core-*.service /etc/systemd/system/
systemctl daemon-reload
ln -sfn "$release" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"
systemctl enable --quiet qapaq-core-api qapaq-core-worker
systemctl restart qapaq-core-api
ready=false
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:3000/health/ready; then ready=true; break; fi
  sleep 3
done
if [[ "$ready" != true ]]; then
  if [[ -n "$previous" && -d "$previous" ]]; then
    ln -sfn "$previous" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"
    systemctl restart qapaq-core-api
    fail "el release ${release##*/} no quedó listo; se volvió a ${previous##*/}"
  fi
  fail "el release ${release##*/} no quedó listo y no hay anterior"
fi
systemctl restart qapaq-core-worker
info "núcleo QAPAQ activo: release ${release##*/} (API 127.0.0.1:3000 y worker)"

# Histórico: conservar los 3 releases más recientes además del activo.
ls -1dt "$BASE"/releases/* | tail -n +5 | while read -r old; do
  [[ "$old" == "$(readlink -f "$BASE/current")" ]] || rm -rf "$old"
done
