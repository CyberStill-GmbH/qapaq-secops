#!/usr/bin/env bash
# QAPAQ SecOps — build del núcleo QAPAQ como componente del SIEM (docs/12, opción B).
#
#   bash wazuh/core/build.sh <OUT_DIR>
#
# Produce <OUT_DIR>/qapaq-core-<sha>.tar.gz más SHA256SUMS: un release autocontenido que se instala en
# el host del SIEM junto al dashboard (wazuh/core/apply-core.sh). Contiene:
#   node/     runtime Node 24.21.0 linux-x64 propio (verificado por SHA256; el dashboard trae su Node 18)
#   api/      @qapaq/api   (pnpm deploy --prod), proceso HTTP en 127.0.0.1:3000
#   worker/   @qapaq/worker (pnpm deploy --prod), consumidor de colas
#   certs/    trust bundle para el destino elegido (AWS RDS por defecto; CA del sistema para Azure)
#   systemd/  unidades endurecidas
# Mismos pasos que apps/*/Dockerfile, para que el binario sea equivalente al de ECS.
set -euo pipefail
OUT_DIR="${1:?uso: build.sh <OUT_DIR>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/wazuh/core"
NODE_VERSION=24.21.0
NODE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
RDS_CA_SHA256=90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b
CA_MODE="${QAPAQ_CORE_CA_MODE:-aws-rds}"
SHA="$(git -C "$ROOT" rev-parse --short=12 HEAD)"

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
stage="$work/qapaq-core-$SHA"
mkdir -p "$stage"/{node,certs,systemd} "$OUT_DIR"

# Runtime Node propio, verificado.
curl -fsSL --retry 3 -o "$work/node.tar.xz" \
  "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
echo "${NODE_SHA256}  $work/node.tar.xz" | sha256sum -c -
tar -C "$stage/node" --strip-components=1 -xJf "$work/node.tar.xz"

case "$CA_MODE" in
  aws-rds)
    curl -fsSL --retry 3 -o "$stage/certs/rds-global-bundle.pem" \
      https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
    echo "${RDS_CA_SHA256}  $stage/certs/rds-global-bundle.pem" | sha256sum -c -
    ;;
  system)
    [[ -s /etc/ssl/certs/ca-certificates.crt ]] || {
      echo "No existe el almacén de CAs del sistema en /etc/ssl/certs/ca-certificates.crt" >&2
      exit 1
    }
    install -m 0644 /etc/ssl/certs/ca-certificates.crt "$stage/certs/rds-global-bundle.pem"
    ;;
  *)
    echo "QAPAQ_CORE_CA_MODE debe ser aws-rds o system" >&2
    exit 2
    ;;
esac

# API y worker: mismos pasos que los Dockerfile.
cd "$ROOT"
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile --filter '@qapaq/api...' --filter '@qapaq/worker...'
pnpm --filter @qapaq/database generate
pnpm --filter '@qapaq/api...' --filter '@qapaq/worker...' run build
pnpm --filter @qapaq/api deploy --prod --legacy "$stage/api"
pnpm --filter @qapaq/worker deploy --prod --legacy "$stage/worker"
node scripts/docker/prune-deploy.mjs "$stage/api"
node scripts/docker/prune-deploy.mjs "$stage/worker"

cp "$HERE"/systemd/*.service "$stage/systemd/"
printf '%s\n' "$SHA" >"$stage/RELEASE"
# Referencias de secretos opcionales que este release reconoce; el instalador Azure solo las
# publica si el release las declara (un release anterior las rechazaría al arrancar).
printf '%s\n' QAPAQ_VIRUSTOTAL_API_KEY_REF >"$stage/OPTIONAL_SECRET_REFS"

tar -C "$work" -czf "$OUT_DIR/qapaq-core-$SHA.tar.gz" "qapaq-core-$SHA"
(cd "$OUT_DIR" && sha256sum "qapaq-core-$SHA.tar.gz" >SHA256SUMS)
echo "qapaq-core-$SHA.tar.gz listo en $OUT_DIR"
