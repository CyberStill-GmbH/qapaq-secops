# ankay/ — Ankay Qapaq (Shuffle con identidad QAPAQ)

El frontend se construye para alojarse en la ruta `/ankay/` detrás de la sesión QAPAQ. La autenticación propia de Ankay conserva el control de acceso a sus funciones.

Overlay versionado sobre **Shuffle v2.3.0** ([`upstream.lock`](upstream.lock)). Plan completo, tradeoffs
y fases en [`docs/13-ankay-qapaq.md`](../docs/13-ankay-qapaq.md).

| Ruta                                                         | Qué cambia de Shuffle                                                                                                                                                                                                                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend/patches/0001-ankay-tema-y-marca-por-defecto.patch` | Fondos QAPAQ (`#080808`) y nombre de marca por defecto «Ankay Qapaq» (white-label nativo de Shuffle)                                                                                                                                                      |
| `frontend/patches/0002-ankay-html-y-manifest.patch`          | Título, `theme-color` y manifest PWA (`lang` sigue en `en` hasta traducir la UI de Ankay)                                                                                                                                                                 |
| `frontend/patches/0003-ankay-csp-mismo-origen.patch`         | CSP de mismo origen: el frontend no puede llamar a la nube de Shuffle, Algolia ni otros terceros (N1)                                                                                                                                                     |
| `frontend/assets/`                                           | Arte Ankay (la Q de QAPAQ con el «ejecutar» ámbar). Reemplaza los logos con los mismos nombres de archivo (`targets.tsv`). Se regenera con `assets/tools/build-brand.mjs --raster`                                                                        |
| `frontend/rebrand.mjs`                                       | Codemod con AST de TypeScript: colores naranja → ámbar en todo el código y «Shuffle» → «Ankay Qapaq» **solo en texto visible**. No toca la lógica, los datos, los nombres de apps del backend (Shuffle Tools, DB, AI) ni los textos que el código compara |
| `build.sh`                                                   | Clona el tag, verifica el SHA, aplica parches, arte y codemod, publica el código fuente en `/source/` (AGPL §13) y construye la imagen                                                                                                                    |

El workflow [`.github/workflows/ankay-azure.yml`](../.github/workflows/ankay-azure.yml)
construye y verifica la imagen en PR sin credenciales cloud. La publicación a ACR
requiere `workflow_dispatch`, `main`, `publish_to_acr=true` y el environment
`azure-demo`; el workflow conserva la imagen del mismo run, valida su SHA-256 y
registra el digest OCI. Publicar la imagen no despliega Shuffle ni habilita una
ruta pública.

## TLS de OpenSearch

Backend y worker deben montar la CA de OpenSearch en solo lectura en
`/run/ankay/opensearch-ca`. El archivo `ca.pem` debe contener la CA raíz/intermedia
que firma el certificado presentado por OpenSearch. No se incluye una CA dentro de
la imagen ni se desactiva la validación TLS.

```yaml
services:
  shuffle-backend:
    environment:
      SHUFFLE_OPENSEARCH_CERTIFICATE_FILE: /run/ankay/opensearch-ca/ca.pem
      SHUFFLE_CERT_DIR: /run/ankay/opensearch-ca
    volumes:
      - /var/lib/qapaq/ankay/opensearch-ca:/run/ankay/opensearch-ca:ro
  shuffle-worker:
    environment:
      SHUFFLE_CERT_DIR: /run/ankay/opensearch-ca
    volumes:
      - /var/lib/qapaq/ankay/opensearch-ca:/run/ankay/opensearch-ca:ro
```

Provisiona el archivo en el host desde el almacén de secretos/certificados del
entorno. El backend lee `SHUFFLE_OPENSEARCH_CERTIFICATE_FILE` en el cliente de
OpenSearch; si el archivo no existe o no contiene PEM válido, la creación del
cliente falla. El cliente HTTP compartido de Shuffle añade los certificados PEM
del directorio `SHUFFLE_CERT_DIR` al almacén de confianza del sistema cuando su
entorno es `onprem`/`worker`; con un CA privado ausente o incorrecto, la conexión
TLS no valida. La fuente fijada es `shuffle-shared v1.3.22` (checksum en
`azure-components.lock.json`): el valor predeterminado de `InsecureSkipVerify` es
`false`, y `SHUFFLE_OPENSEARCH_SKIPSSL_VERIFY=true` lo habilita explícitamente.

El montaje anterior es un contrato requerido del runtime. Hasta que Compose o el
orquestador lo aplique y se verifique conectividad TLS a OpenSearch, no declarar
Ankay listo para Terraform/runtime.

## Usuario runtime y límite del Docker socket

Backend y worker corren como UID/GID fijo `10001:10001`. Solo el backend recibe
escritura en `/app/generated`, que Shuffle usa para generar los artefactos de apps;
`/app_gen` permanece de solo lectura para ese usuario. El worker no necesita escribir
en `/app` según las rutas de escritura revisadas. `ankay/verify-runtime-users.sh`
comprueba la identidad efectiva y la escritura de esos paths en las imágenes construidas.
Las carpetas del host que se monten como `/shuffle-apps` o `/shuffle-files` deben
provisionarse con permisos específicos para este UID/GID; este Dockerfile no cambia
permisos del host ni de montajes.

La configuración upstream monta `/var/run/docker.sock` en backend y Orborus. En Ankay solo lo monta
`docker-guard` (`runtime/docker-guard`, Go, sin dependencias externas), que corre como UID 10002 con el
grupo `docker` de GID fijo 2375, rootfs de solo lectura y sin capacidades. Orborus y los workers usan
`DOCKER_HOST=tcp://docker-guard:2375`. El guard permite solo create/start/stop/kill/wait/logs/delete sobre
contenedores que él creó, imágenes de la allowlist y lectura de `_ping`, `version`, `info`, listas e
inspección. Fuerza `no-new-privileges` y `PidsLimit`, y rechaza privileged, binds, mounts, devices, red/PID/IPC
del host, puertos publicados, perfiles unconfined, exec/attach, pull, build, swarm, redes y volúmenes.
`verify-docker-guard.sh` lo comprueba en CI contra el daemon real. Los contenedores de apps comparten la red
del worker y pueden alcanzar el guard, pero quedan sujetos a la misma política. El backend no tiene acceso al
daemon: los builds de apps fallan y las apps llegan como imágenes fijadas por digest.
**Ankay no queda listo para producción** hasta ejecutar un workflow sintético de punta a punta en el
host Azure con este límite.

### Pin de OpenSearch para runtime

El Compose fijado de Shuffle v2.3.0 usa OpenSearch 3.2.0. QAPAQ conserva el contrato
del servicio y su API, fija la imagen linux/amd64 oficial de OpenSearch 3.9.0 por
digest inmutable y construye una imagen derivada sobre Amazon Linux 2023 con release
fechado `2023.12.20261028` (sobre la imagen base 2023.12.20261021.0). Una etapa intermedia copia la distribución OpenSearch y
reemplaza siete bibliotecas Java con versiones corregidas y checksum fijado en
[`runtime/opensearch-dependencies.lock`](runtime/opensearch-dependencies.lock),
y copia solo el árbol corregido a la imagen final sobre AL2023. Los digests, los
parches de dependencias, la versión de OS y el Dockerfile derivado quedan en
[`azure-components.lock.json`](azure-components.lock.json) y en el bundle de procedencia.
El CI escanea la imagen derivada y debe arrancarla
con Security habilitado y comprobar su salud autenticada antes de permitir publicación.
Shuffle v2.3.0 documenta OpenSearch como su base de datos y usa su API REST; la
compatibilidad con 3.9.0 debe confirmarse con la inicialización real de índices y
persistencia del Compose final. No se añade ningún plugin externo.

El agregado upstream `opensaml-3.9.0.0-all.jar` incluye descriptores Maven de Jackson 2.22.2,
que Trivy reportó como componentes vulnerables, aunque su implementación se carga desde los JAR
externos de OpenSearch. El parche verifica que `jackson-core` y `jackson-databind` efectivos son
2.22.3 y sincroniza cuatro descriptores Maven del agregado con esa versión. Comprueba clases Jackson
canónicas, multi-release y reubicadas, y aborta ante JARs anidados, firmas o digests de manifiesto.
Como el JAR fijado contiene entradas de licencia duplicadas con solapamiento, el helper agrega las
cuatro entradas corregidas y redirige solo sus registros del directorio central; no desempaqueta ni
reconstruye las entradas upstream ajenas al cambio. Limpia los payloads Maven antiguos que quedan
sin referencia y verifica los cuatro descriptores activos. Mantiene las referencias de API que
OpenSAML usa hacia el runtime externo.
Tres colisiones de nombre verificadas en este JAR upstream (`Version`, `ReferenceType` y
`ContentReference`, bajo `org/opensaml`) se excluyen del cotejo por nombre simple; no se excluyen
paquetes Jackson ni otras clases con nombres coincidentes. El helper exige el SHA-256 exacto del
OpenSAML fijado (`2d0c1db9e284a36ec2c279c7b7cb1cdaaae9d64f55f60548a32a1babfddbd1ab`), rechaza
descriptores Maven duplicados y copia los cuatro POM/properties directamente desde los JAR
2.22.3 verificados, validando sus coordenadas Maven.
Cualquier versión o estructura inesperada detiene el build. La corrección solo se considera válida
cuando el escaneo HIGH/CRITICAL del artefacto terminado pasa en CI; no se omite CVE ni se modifica
la lógica de OpenSearch Security.

La verificación CI construye backend, worker y la capa OpenSearch derivada, y ejecuta
Trivy con su escaneo de vulnerabilidades completo para HIGH/CRITICAL. Eso no equivale
a una prueba end-to-end de Shuffle contra OpenSearch 3.9.0: antes de activar el runtime
se debe validar la inicialización de índices, búsquedas y persistencia con el Compose
final. En un cluster con datos existentes, no se debe sustituir la imagen como simple
actualización; debe seguirse el procedimiento de upgrade y respaldo de OpenSearch.

## Verificación de imágenes en CI

Los Dockerfiles de backend y worker están registrados en `.github/ci/containers.json`
para que discovery los detecte y habilite los controles de contenedor. La construcción
y verificación reproducible de componentes Ankay pertenece al workflow personalizado
`.github/workflows/ankay-azure.yml`; el verificador genérico
`.github/ci/verify-container-images.sh` aún enumera imágenes por separado y no debe
considerarse evidencia de que haya construido backend o worker.

### Migración del Docker SDK

Backend, worker y Orborus usan `github.com/moby/moby/client v0.2.1` y `github.com/moby/moby/api v1.53.0`.
Ninguno conserva `github.com/docker/docker` ni `github.com/moby/go-archive` en su grafo de módulos.
Orborus sale del monorepo Shuffle v2.2.0 (AGPL-3.0) con `runtime/orborus/orborus-moby-v29.patch`. El repositorio
separado `Shuffle/orborus` no tiene licencia. `runtime/shuffle-runtime-go-jose.patch` sube go-jose a 4.1.6
(CVE-2026-116587) en backend y worker. Trivy HIGH/CRITICAL corre sobre las seis imágenes y la app; no se
suprime ningún CVE. Falta la prueba de ejecución contra Engine 29.x en el host Azure.

## Uso

```bash
pnpm install                                    # el codemod usa el TypeScript del monorepo
bash ankay/build.sh out/ ankay-qapaq-frontend:dev
node --test ankay/frontend/rebrand.test.mjs ankay/frontend/subpath.test.mjs
```

## Subir de versión de Shuffle

1. Cambiar `SHUFFLE_TAG` y `SHUFFLE_SHA` en `upstream.lock`.
2. Correr `bash ankay/build.sh out/`. Si un parche no aplica, regenerarlo con `git diff` sobre el tag nuevo.
3. Revisar en la salida del codemod las «apariciones restantes» y si apareció algún logo nuevo que
   agregar a `targets.tsv`.

## Licencia

Shuffle es AGPL-3.0. Ankay Qapaq es una versión modificada: la imagen sirve en `/source/` el código fuente
correspondiente y la licencia. Los avisos de copyright de Shuffle se conservan. Pendiente: dictamen de
Legal (U-022).
