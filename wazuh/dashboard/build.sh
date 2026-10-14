#!/usr/bin/env bash
#
# Construye el .deb de QAPAQ SecOps Dashboard (Wazuh 4.14.8 / OpenSearch Dashboards 2.19.6)
# como overlay: clona upstream en los SHA fijados, aplica parches, copia activos y plugins
# QAPAQ y empaqueta con el flujo oficial de Wazuh.
#
#   bash wazuh/dashboard/build.sh <OUT_DIR>
#
# Resultado: exactamente un `wazuh-dashboard_<WAZUH_VERSION>-<QAPAQ_REVISION>_amd64.deb` y
# `SHA256SUMS` en OUT_DIR. El paquete se llama `wazuh-dashboard`, instala en
# /usr/share/wazuh-dashboard y /etc/wazuh-dashboard con el mismo usuario y servicio, y su
# versión (4.14.8-1qapaq1) es mayor que la oficial (4.14.8-1): `dpkg -i` actualiza. Los ficheros
# de /etc son conffiles: dpkg conserva los del host (usar `--force-confold` en modo no interactivo).
#
# Modos (QAPAQ_BUILD_MODE):
#   source  (por defecto) compila OSD desde el fork de Wazuh con los parches del core y
#           empaqueta con dev-tools/build-packages (Docker). Aplica TODOS los parches.
#   repack  descarga el .deb oficial, verifica su SHA256 (índice APT firmado), sustituye
#           activos de marca y plugins (app de Wazuh parcheada, qapaq_ops, qapaq_i18n) y lo
#           reempaqueta con dpkg-deb. No compila el core: los parches de wazuh-dashboard
#           (pantalla de carga, menú de ayuda, títulos por defecto) NO se aplican.
#
# Variables opcionales:
#   QAPAQ_WORK_DIR   directorio de trabajo (por defecto, uno temporal que se borra al terminar)
#   QAPAQ_KEEP_WORK  =1 para conservar el directorio de trabajo
#   QAPAQ_SKIP_NODE_INSTALL =1 si node/yarn ya están en el PATH con las versiones fijadas
#
# Requisitos (ubuntu-latest): git, curl, jq, zip, unzip, xz-utils, sha256sum; Docker (source);
# dpkg-deb (repack). Node y Yarn se instalan en el directorio de trabajo si no coinciden.

set -euo pipefail

log() { printf '\n[qapaq-build] %s\n' "$*" >&2; }
die() { printf '\n[qapaq-build] ERROR: %s\n' "$*" >&2; exit 1; }

[ $# -eq 1 ] || die "uso: bash wazuh/dashboard/build.sh <OUT_DIR>"
mkdir -p "$1"
OUT_DIR="$(cd "$1" && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${QAPAQ_BUILD_MODE:-source}"
[ "$MODE" = source ] || [ "$MODE" = repack ] || die "QAPAQ_BUILD_MODE debe ser source o repack"

# shellcheck source=upstream.lock
source "$HERE/upstream.lock"

for tool in git curl jq zip unzip sha256sum tar; do
  command -v "$tool" >/dev/null || die "falta la herramienta $tool"
done
if [ "$MODE" = source ]; then
  command -v docker >/dev/null || die "el modo source necesita Docker (o usa QAPAQ_BUILD_MODE=repack)"
else
  command -v dpkg-deb >/dev/null || die "el modo repack necesita dpkg-deb"
fi

WORK="${QAPAQ_WORK_DIR:-$(mktemp -d -t qapaq-dashboard-XXXXXX)}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
cleanup() {
  if [ "${QAPAQ_KEEP_WORK:-0}" != 1 ] && [ -z "${QAPAQ_WORK_DIR:-}" ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT

OSD="$WORK/wazuh-dashboard"          # raíz OSD (fork de Wazuh)
PLUGINS_SRC="$WORK/wazuh-dashboard-plugins"
SECURITY_SRC="$WORK/wazuh-security-dashboards-plugin"
PKG="$WORK/packages"
DEB_NAME="wazuh-dashboard_${WAZUH_VERSION}-${QAPAQ_REVISION}_amd64.deb"

# --- Utilidades ---------------------------------------------------------------------------

# Clona `tag` y exige que apunte al SHA fijado (un tag movido upstream detiene el build).
fetch_pinned() {
  local repo="$1" tag="$2" sha="$3" dir="$4"
  log "Clonando $repo@$tag ($sha)"
  rm -rf "$dir"
  git -c advice.detachedHead=false -c core.autocrlf=false clone --quiet --depth 1 --branch "$tag" "$repo" "$dir"
  local got
  got="$(git -C "$dir" rev-parse HEAD)"
  [ "$got" = "$sha" ] || die "$repo@$tag apunta a $got, se esperaba $sha (¿tag movido?)"
}

# Aplica patches/<repo>/NNNN-*.patch en orden; cualquier rechazo detiene el build.
apply_patches() {
  local dir="$1" set="$2" patch
  shopt -s nullglob
  for patch in "$HERE/patches/$set"/[0-9][0-9][0-9][0-9]-*.patch; do
    log "Parche $set/$(basename "$patch")"
    git -C "$dir" apply --check --whitespace=nowarn "$patch" || die "el parche $(basename "$patch") no aplica sobre $set"
    git -C "$dir" apply --whitespace=nowarn "$patch"
  done
  shopt -u nullglob
}

# Copia los activos de assets/targets.tsv cuyo repo sea `repo` bajo `root`.
copy_assets() {
  local repo="$1" root="$2" src kind dst
  log "Activos QAPAQ → $repo"
  while IFS=$'\t' read -r src kind dst; do
    case "$src" in ''|'#'*) continue ;; esac
    [ "$kind" = "$repo" ] || continue
    [ -f "$HERE/assets/$src" ] || die "falta assets/$src"
    mkdir -p "$(dirname "$root/$dst")"
    cp -f "$HERE/assets/$src" "$root/$dst"
  done < "$HERE/assets/targets.tsv"
}

ensure_node() {
  if [ "${QAPAQ_SKIP_NODE_INSTALL:-0}" = 1 ]; then return; fi
  if [ "$(node --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
    log "Instalando Node $NODE_VERSION (de .nvmrc de wazuh-dashboard)"
    local base="https://nodejs.org/dist/v$NODE_VERSION" file="node-v$NODE_VERSION-linux-x64.tar.xz"
    mkdir -p "$WORK/node"
    curl -fsSL "$base/$file" -o "$WORK/$file"
    curl -fsSL "$base/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
    (cd "$WORK" && grep " $file\$" SHASUMS256.txt | sha256sum -c -) || die "checksum de Node inválido"
    tar -xJf "$WORK/$file" -C "$WORK/node" --strip-components=1
    export PATH="$WORK/node/bin:$PATH"
  fi
  if [ "$(yarn --version 2>/dev/null || true)" != "$YARN_VERSION" ]; then
    log "Instalando Yarn $YARN_VERSION"
    npm install --global --silent --prefix "$WORK/yarn" "yarn@$YARN_VERSION"
    export PATH="$WORK/yarn/bin:$PATH"
  fi
  yarn config set network-timeout 1000000 >/dev/null
  log "node $(node --version) · yarn $(yarn --version)"
}

# Compila un plugin dentro de $OSD/plugins y deja su zip en el directorio indicado.
build_plugin() {
  local dir="$1" dest="$2" id zip
  id="$(jq -r '.id' "$dir/opensearch_dashboards.json")"
  log "Compilando plugin $id"
  if [ -f "$dir/yarn.lock" ] || jq -e '(.dependencies // {}) | length > 0' "$dir/package.json" >/dev/null; then
    (cd "$dir" && yarn install --frozen-lockfile --non-interactive || yarn install --non-interactive)
  fi
  (cd "$dir" && OPENSEARCH_DASHBOARDS_VERSION="$OSD_VERSION" \
    node ../../scripts/plugin_helpers build --opensearch-dashboards-version "$OSD_VERSION")
  zip="$(ls "$dir"/build/"$id"-"$OSD_VERSION".zip 2>/dev/null || true)"
  [ -n "$zip" ] || die "el plugin $id no produjo build/$id-$OSD_VERSION.zip"
  cp "$zip" "$dest/"
}

# --- 1. Fuentes upstream + overlay -------------------------------------------------------

node "$HERE/tools/verify-login-art.mjs"
fetch_pinned "$WAZUH_DASHBOARD_REPO" "$WAZUH_DASHBOARD_TAG" "$WAZUH_DASHBOARD_SHA" "$OSD"
[ "$(tr -d '[:space:]' < "$OSD/.nvmrc")" = "$NODE_VERSION" ] || die ".nvmrc de wazuh-dashboard ya no es $NODE_VERSION: revisa upstream.lock"
apply_patches "$OSD" wazuh-dashboard
copy_assets dashboard "$OSD"

fetch_pinned "$WAZUH_PLUGINS_REPO" "$WAZUH_PLUGINS_TAG" "$WAZUH_PLUGINS_SHA" "$PLUGINS_SRC"
apply_patches "$PLUGINS_SRC" wazuh-dashboard-plugins
copy_assets plugins "$PLUGINS_SRC"

ensure_node
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"

log "yarn osd bootstrap (OSD $OSD_VERSION)"
(cd "$OSD" && yarn osd bootstrap)

mkdir -p "$PKG/app" "$PKG/security" "$PKG/base"

# --- 2. Base de OSD (solo source; antes de añadir plugins externos al árbol) -------------

if [ "$MODE" = source ]; then
  log "yarn build-platform --linux --skip-os-packages --release"
  (cd "$OSD" && yarn build-platform --linux --skip-os-packages --release)
  base_tar="$(ls "$OSD"/target/opensearch-dashboards-"$OSD_VERSION"-linux-x64.tar.gz)"
  (cd "$PKG/base" && zip -q -j dashboard-package.zip "$base_tar")
fi

# --- 3. Plugins: app de Wazuh (parcheada) + plugins QAPAQ (+ security en source) ----------

for plugin in "$PLUGINS_SRC"/plugins/*/; do
  name="$(basename "$plugin")"
  rm -rf "$OSD/plugins/$name"
  cp -R "$plugin" "$OSD/plugins/$name"
  build_plugin "$OSD/plugins/$name" "$PKG/app"
done

# Todos los plugins propios de QAPAQ (qapaq_ops, qapaq_i18n, …): fuera del código de Wazuh.
for plugin in "$HERE"/plugins/*/; do
  name="$(basename "$plugin")"
  [ -f "$plugin/opensearch_dashboards.json" ] || continue
  rm -rf "$OSD/plugins/$name"
  mkdir -p "$OSD/plugins/$name"
  (cd "$plugin" && tar --exclude=node_modules --exclude=build --exclude=target -cf - .) | (cd "$OSD/plugins/$name" && tar -xf -)
  build_plugin "$OSD/plugins/$name" "$PKG/app"
done

if [ "$MODE" = source ]; then
  fetch_pinned "$WAZUH_SECURITY_REPO" "$WAZUH_SECURITY_TAG" "$WAZUH_SECURITY_SHA" "$SECURITY_SRC"
  rm -rf "$OSD/plugins/wazuh-security-dashboards-plugin"
  cp -R "$SECURITY_SRC" "$OSD/plugins/wazuh-security-dashboards-plugin"
  log "Compilando wazuh-security-dashboards-plugin (sin cambios)"
  (cd "$OSD/plugins/wazuh-security-dashboards-plugin" && yarn install --non-interactive && yarn build)
  cp "$OSD"/plugins/wazuh-security-dashboards-plugin/build/*.zip "$PKG/security/"
fi

log "Plugins empaquetados:"
ls -1 "$PKG/app" >&2

# --- 4a. Paquete desde fuente: flujo oficial dev-tools/build-packages (Docker) -----------

if [ "$MODE" = source ]; then
  (cd "$PKG/app" && zip -q -j ../wazuh-package.zip ./*.zip)
  (cd "$PKG/security" && zip -q -j ../security-package.zip ./*.zip)
  log "dev-tools/build-packages/build-packages.sh --deb -r $QAPAQ_REVISION"
  (cd "$OSD/dev-tools/build-packages" && bash ./build-packages.sh \
    --app "file://$PKG/wazuh-package.zip" \
    --base "file://$PKG/base/dashboard-package.zip" \
    --security "file://$PKG/security-package.zip" \
    --revision "$QAPAQ_REVISION" --deb --production)
  deb="$OSD/dev-tools/build-packages/output/$DEB_NAME"
  [ -f "$deb" ] || die "build-packages no produjo $DEB_NAME"
  cp "$deb" "$OUT_DIR/$DEB_NAME"
fi

# --- 4b. Reempaquetado del .deb oficial ---------------------------------------------------

if [ "$MODE" = repack ]; then
  log "Descargando el .deb oficial $WAZUH_VERSION"
  curl -fsSL "$WAZUH_DEB_URL" -o "$WORK/official.deb"
  echo "$WAZUH_DEB_SHA256  $WORK/official.deb" | sha256sum -c - || die "SHA256 del .deb oficial no coincide"
  ROOT="$WORK/debroot"
  rm -rf "$ROOT"
  dpkg-deb -R "$WORK/official.deb" "$ROOT"
  R="$ROOT/usr/share/wazuh-dashboard"
  [ -d "$R/src/core/server/core_app/assets" ] || die "estructura inesperada en el .deb oficial"
  copy_assets dashboard "$R"
  for zip in "$PKG"/app/*.zip; do
    tmp="$WORK/unzip-$(basename "$zip" .zip)"
    rm -rf "$tmp" && mkdir -p "$tmp"
    unzip -q "$zip" -d "$tmp"
    for dir in "$tmp"/opensearch-dashboards/*/; do
      name="$(basename "$dir")"
      log "Plugin instalado: $name"
      rm -rf "$R/plugins/$name"
      cp -R "$dir" "$R/plugins/$name"
    done
  done
  sed -i "s/^Version: .*/Version: ${WAZUH_VERSION}-${QAPAQ_REVISION}/" "$ROOT/DEBIAN/control"
  (cd "$ROOT" && find . -path ./DEBIAN -prune -o -type f -print0 | sort -z | xargs -0 md5sum | sed 's# \./# #' > DEBIAN/md5sums)
  dpkg-deb --root-owner-group -Zxz --build "$ROOT" "$OUT_DIR/$DEB_NAME"
fi

# --- 5. Salida ----------------------------------------------------------------------------

count="$(find "$OUT_DIR" -maxdepth 1 -name '*.deb' | wc -l)"
[ "$count" = 1 ] || die "OUT_DIR debe contener exactamente un .deb (hay $count)"
(cd "$OUT_DIR" && sha256sum ./*.deb | sed 's# \./# #' > SHA256SUMS)
log "Listo ($MODE): $OUT_DIR/$DEB_NAME"
cat "$OUT_DIR/SHA256SUMS" >&2
