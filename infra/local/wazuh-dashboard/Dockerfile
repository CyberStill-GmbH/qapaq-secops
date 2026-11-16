# Dashboard Wazuh con la marca QAPAQ para el entorno LOCAL (Docker Desktop).
#
# Equivale al modo `repack` de wazuh/dashboard/build.sh sobre la imagen oficial: sustituye los
# activos de marca según assets/targets.tsv e instala los plugins QAPAQ compilados por
# build-plugins.sh (si existen en plugins-dist/). De los parches del core solo se aplica el
# equivalente compilado de 0001 (pantalla de carga: patch-splash.cjs); 0002 (menú de ayuda),
# 0003 (títulos por defecto) y el parche de la app de Wazuh requieren el build desde fuente.
#
# Contextos: el de este directorio + `brand` = wazuh/dashboard (ver compose.wazuh-dashboard-qapaq.yaml).
ARG WAZUH_VERSION=4.14.8
FROM wazuh/wazuh-dashboard:${WAZUH_VERSION}

USER root
COPY --from=brand assets/ /tmp/qapaq/assets/
COPY plugins-dist/ /tmp/qapaq/plugins/
COPY patch-splash.cjs /tmp/qapaq/patch-splash.cjs
COPY set-ui-build.cjs /tmp/qapaq/set-ui-build.cjs
RUN set -eu; \
    R=/usr/share/wazuh-dashboard; \
    "$R/node/bin/node" /tmp/qapaq/set-ui-build.cjs "$R/package.json" /tmp/qapaq/assets /tmp/qapaq/plugins; \
    sed 's/\r$//' /tmp/qapaq/assets/targets.tsv | while IFS="$(printf '\t')" read -r src kind dst; do \
      case "$src" in ''|'#'*) continue ;; esac; \
      case "$kind" in \
        dashboard) out="$R/$dst" ;; \
        plugins) out="$R/plugins/wazuh/${dst#plugins/main/}" ;; \
        *) echo "repo desconocido: $kind" >&2; exit 1 ;; \
      esac; \
      test -f "/tmp/qapaq/assets/$src" || { echo "falta assets/$src" >&2; exit 1; }; \
      mkdir -p "$(dirname "$out")"; cp -f "/tmp/qapaq/assets/$src" "$out"; \
    done; \
    # Logo del login del Security plugin: va empaquetado con nombre hash (fondo oscuro, texto blanco).
    for f in "$R"/plugins/securityDashboards/target/public/*.svg; do \
      grep -q 'fill:#FFFFFF' "$f" && cp -f /tmp/qapaq/assets/svg/qapaq_wordmark_on_dark.svg "$f"; \
      rm -f "$f.br" "$f.gz"; \
    done; \
    "$R/node/bin/node" /tmp/qapaq/patch-splash.cjs "$R/src/core/server/rendering/views"; \
    # Informes PDF de la app de Wazuh: color primario QAPAQ (REPORTS_PRIMARY_COLOR no es configurable;
    # cabecera, pie y logo sí: customization.* en wazuh.yml).
    for f in "$R/plugins/wazuh/common/constants.js" "$R/plugins/wazuhCore/common/constants.js"; do \
      if [ -f "$f" ]; then sed -i 's/#256BD1/#C49A5A/g' "$f"; fi; \
    done; \
    chown -R wazuh-dashboard:wazuh-dashboard "$R/src/core/server/core_app/assets" "$R/plugins/wazuh/public/assets/images" "$R/plugins/securityDashboards/target/public"; \
    rm -rf /tmp/qapaq/assets;     chown -R wazuh-dashboard:wazuh-dashboard /tmp/qapaq
USER wazuh-dashboard
# Los plugins se instalan como el usuario del servicio (la imagen no trae `su`).
RUN set -eu;     for zip in /tmp/qapaq/plugins/*.zip; do       [ -f "$zip" ] || continue;       echo "Instalando plugin $(basename "$zip")";       /usr/share/wazuh-dashboard/bin/opensearch-dashboards-plugin install "file://$zip";     done;     ls /usr/share/wazuh-dashboard/plugins
