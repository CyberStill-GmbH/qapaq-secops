# Artefactos prerequisito del SIEM Azure (experimental)

El workflow manual [`azure-siem-prerequisites-experimental.yml`](../../../.github/workflows/azure-siem-prerequisites-experimental.yml)
construye en paralelo un paquete Wazuh Manager 4.14.8, un paquete Wazuh Indexer 4.14.8 y recoge
Filebeat 7.10.2-2 del APT firmado de Wazuh. Los artefactos de cada componente y el manifiesto de
evidencia expiran después de un día. El workflow no inicia sesión en Azure, AWS ni ACR; no usa
OIDC, secretos, Terraform, Blob, DNS ni despliega servicios.

## Procedencia fijada

| Componente | Fuente o método | Pin | Comprobación |
| --- | --- | --- | --- |
| Wazuh Manager | `wazuh/wazuh`, builder oficial `packages/generate_package.sh` | commit `f470ad7db717b18db7feeed568949643698f0f34`, DEB `4.14.8-1` amd64 | igualdad del commit, verificación de firma vía GitHub, campos Debian; SHA-256 y SHA-512 del paquete |
| Wazuh Indexer | `wazuh/wazuh-indexer`, `docker/ci/ci.sh`, `packaging_scripts/build.sh` y `assemble.sh` oficiales | commit `9f4796b8738969ac50ea8b6d23cdea5ce1a8565a`, DEB `4.14.8-1` amd64; compatibilidad fijada OSD `2.19.6` | igualdad del commit, verificación de firma vía GitHub, versión del script `product_version.sh`, campos Debian; SHA-256 y SHA-512 |
| Filebeat | repositorio APT Wazuh `4.x`, archivo firmado y clave Wazuh fijada | `7.10.2-2` amd64 | SHA-256 de clave pública, verificación de firma APT, hash SHA-256 del paquete igual al pin; metadatos Debian |
| Módulo Filebeat Wazuh | URL oficial `wazuh-filebeat-0.5.tar.gz` | versión `0.5` | SHA-256 fijado |
| Template Wazuh | repositorio Wazuh en el commit de Manager fijado | `extensions/elasticsearch/7.x/wazuh-template.json` | URL contiene el SHA de origen y el manifiesto registra el hash del contenido |

Los hashes de los `.deb` construidos se calculan en cada ejecución: el resultado compilado no tiene
un hash de upstream predeterminado. El manifiesto registra el commit fuente y ambas sumas para que el
revisor pueda asociar el resultado a esa ejecución de Actions.

## Ejecución y límites

1. Ejecutar manualmente `Azure SIEM prerequisite packages (experimental)`.
2. Activar `acknowledge_experimental`; el valor predeterminado es falso y el workflow falla cerrado
   si no se confirma que produce solo artefactos temporales.
3. Verificar los tres trabajos de construcción y el trabajo de evidencia. Descargar el manifiesto y
   revisar commits, versiones Debian y hashes junto con los logs de esa ejecución.

El build de Manager e Indexer no se puede reproducir localmente desde este checkout Windows porque
requiere Docker y las herramientas de build Linux del upstream. La sintaxis de los comandos se
contrastó con los scripts oficiales en los commits fijados, pero el workflow todavía debe completar
su primera ejecución antes de considerarse validado. Las imágenes base y algunas dependencias de
build upstream no están fijadas por digest; los hashes atestiguan los artefactos de esa ejecución,
pero no prueban que una compilación futura produzca bytes idénticos. El manifiesto marca el resultado
como experimental y enumera estos límites.

Este resultado **no** es un release bundle ni satisface el contrato de
[`siem_host`](../../../infra/azure/modules/siem_host/README.md). No incluye el Dashboard QAPAQ,
`qapaq-core`, su instalador idempotente, configuración de servicios, políticas, ni pruebas de
integración. No cargar estos artefactos en Azure ni habilitar el módulo con ellos. La posterior fase
de release debe unir componentes, scripts, configuración y pruebas; validar el contrato del
bootstrap y revisar el manifiesto antes de publicar a un almacenamiento privado.
