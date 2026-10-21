#!/usr/bin/env bash
# Ankay Qapaq — build del frontend de Shuffle rebrandeado (docs/13).
#
#   bash ankay/build.sh <OUT_DIR> [IMAGE_REF]
#
# Desde la raíz de qapaq-secops, con `pnpm install` hecho (el codemod usa el TypeScript del monorepo).
#   1. Clona Shuffle en el tag fijado y verifica el SHA (ankay/upstream.lock).
#   2. Aplica los parches de ankay/frontend/patches (falla ante cualquier rechazo).
#   3. Reemplaza el arte según ankay/frontend/assets/targets.tsv (mismos nombres de archivo).
#   4. Corre el codemod ankay/frontend/rebrand.mjs (texto visible y colores).
#   5. AGPL-3.0 §13: empaqueta el código fuente modificado del frontend y lo publica DENTRO de la imagen
#      en /source/, con la licencia, para cualquier persona que use Ankay por red.
#   6. docker build con el Dockerfile oficial de Shuffle. Etiqueta IMAGE_REF (por defecto
#      ankay-qapaq-frontend:<sha-qapaq>) y deja el código fuente también en OUT_DIR.
set -euo pipefail
OUT_DIR="${1:?uso: build.sh <OUT_DIR> [IMAGE_REF]}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERE="$ROOT/ankay"
# shellcheck source=upstream.lock
source "$HERE/upstream.lock"
QAPAQ_SHA="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
IMAGE_REF="${2:-ankay-qapaq-frontend:${QAPAQ_SHA}}"

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$OUT_DIR"

git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$SHUFFLE_TAG" "$SHUFFLE_REPO" "$work/shuffle"
actual="$(git -C "$work/shuffle" rev-parse HEAD)"
[[ "$actual" == "$SHUFFLE_SHA" ]] || { echo "SHA de Shuffle inesperado: $actual (lock: $SHUFFLE_SHA)" >&2; exit 1; }
FE="$work/shuffle/frontend"

for patch in "$HERE"/frontend/patches/*.patch; do
  git -C "$work/shuffle" apply --whitespace=nowarn "$patch"
  echo "parche aplicado: $(basename "$patch")"
done

# Shuffle v2.3.0 provides this supported source-level subpathing pattern for reverse proxies.
# Keep the frontend deployable under the QAPAQ edge's protected /ankay/ prefix.
node "$HERE/frontend/subpath.mjs" "$FE"

grep -v '^#' "$HERE/frontend/assets/targets.tsv" | while IFS=$'\t' read -r src dst _; do
  [[ -n "$src" ]] || continue
  [[ -f "$FE/$dst" ]] || { echo "destino de arte inexistente en upstream: $dst" >&2; exit 1; }
  cp "$HERE/frontend/assets/$src" "$FE/$dst"
done

node "$HERE/frontend/rebrand.mjs" "$FE"

# AGPL-3.0 §13: el código fuente correspondiente, servido por la propia aplicación.
src_name="ankay-qapaq-frontend-source-${QAPAQ_SHA}.tar.gz"
tar -C "$work/shuffle" --exclude=node_modules -czf "$OUT_DIR/$src_name" frontend LICENSE
mkdir -p "$FE/public/source"
cp "$OUT_DIR/$src_name" "$work/shuffle/LICENSE" "$FE/public/source/"
cat >"$FE/public/source/index.html" <<HTML
<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Ankay Qapaq · código fuente</title></head>
<body style="background:#080808;color:#f4f4f5;font-family:system-ui;max-width:640px;margin:48px auto;line-height:1.6">
<h1>Ankay Qapaq · código fuente</h1>
<p>Ankay Qapaq es una versión modificada de Shuffle ${SHUFFLE_TAG} (commit ${SHUFFLE_SHA}), distribuida bajo la
<a style="color:#c49a5a" href="LICENSE">GNU Affero General Public License v3.0</a>.</p>
<p>Código fuente correspondiente de esta versión: <a style="color:#c49a5a" href="${src_name}">${src_name}</a>.</p>
<p>Modificaciones de QAPAQ: tema, marca y textos (overlay <code>ankay/</code> de qapaq-secops, ${QAPAQ_SHA}).</p>
</body></html>
HTML

if command -v docker >/dev/null 2>&1; then
  docker build --pull -t "$IMAGE_REF" "$FE"
  echo "imagen lista: $IMAGE_REF"
else
  echo "docker no disponible: se omite la imagen (fuente en $OUT_DIR/$src_name)"
fi
