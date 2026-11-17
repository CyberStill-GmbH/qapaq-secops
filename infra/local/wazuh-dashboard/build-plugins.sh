#!/usr/bin/env bash
# Compila qapaq_ops y qapaq_i18n con plugin_helpers de OSD (versión de upstream.lock) dentro de un
# contenedor node. Solo para el entorno local: deja los zips en infra/local/wazuh-dashboard/plugins-dist/.
#
#   bash infra/local/wazuh-dashboard/build-plugins.sh
#
# El árbol de OSD bootstrapeado se cachea en el volumen Docker `qapaq-osd-build` (rehacer: docker volume rm qapaq-osd-build).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=../../../wazuh/dashboard/upstream.lock
source "$REPO/wazuh/dashboard/upstream.lock"
mkdir -p "$HERE/plugins-dist"
to_docker_path() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }

# OSD se niega a correr como root: el volumen pasa al usuario `node` (uid 1000) de la imagen.
MSYS_NO_PATHCONV=1 docker run --rm -v qapaq-osd-build:/work "node:${NODE_VERSION}" chown -R 1000:1000 /work

MSYS_NO_PATHCONV=1 docker run --rm --user 1000:1000 -e HOME=/home/node \
  -e WAZUH_DASHBOARD_REPO -e WAZUH_DASHBOARD_TAG="$WAZUH_DASHBOARD_TAG" -e WAZUH_DASHBOARD_SHA="$WAZUH_DASHBOARD_SHA" \
  -e WAZUH_DASHBOARD_REPO="$WAZUH_DASHBOARD_REPO" -e OSD_VERSION="$OSD_VERSION" \
  -e NODE_OPTIONS=--max-old-space-size=4096 \
  -v qapaq-osd-build:/work \
  -v "$(to_docker_path "$HERE")":/tools:ro \
  -v "$(to_docker_path "$REPO/wazuh/dashboard/plugins")":/src:ro \
  -v "$(to_docker_path "$HERE/plugins-dist")":/out \
  "node:${NODE_VERSION}" bash -euo pipefail -c '
    cd /work
    if [ ! -f osd/.qapaq-bootstrapped ]; then
      [ -d osd/.git ] || git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$WAZUH_DASHBOARD_TAG" "$WAZUH_DASHBOARD_REPO" osd
      [ "$(git -C osd rev-parse HEAD)" = "$WAZUH_DASHBOARD_SHA" ] || { echo "SHA inesperado"; exit 1; }
      cd osd
      yarn config set network-timeout 1000000 >/dev/null
      yarn osd bootstrap
      touch .qapaq-bootstrapped
      cd /work
    fi
    for name in qapaq_ops qapaq_i18n; do
      rm -rf "osd/plugins/$name"; mkdir -p "osd/plugins/$name"
      (cd "/src/$name" && tar --exclude=node_modules --exclude=build --exclude=target -cf - .) | (cd "osd/plugins/$name" && tar -xf -)
      node /tools/strip-numeric-separators.cjs "osd/plugins/$name"
      id="$(node -p "require(\"/work/osd/plugins/$name/opensearch_dashboards.json\").id")"
      (cd "osd/plugins/$name" && OPENSEARCH_DASHBOARDS_VERSION="$OSD_VERSION" node ../../scripts/plugin_helpers build --opensearch-dashboards-version "$OSD_VERSION")
      cp "osd/plugins/$name/build/$id-$OSD_VERSION.zip" /out/
      echo "OK $id-$OSD_VERSION.zip"
    done
  '
