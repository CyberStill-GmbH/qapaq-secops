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
