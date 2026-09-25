# C-06 — plan y ejecución de integración

Fecha: 2026-09-24 · Rama inspeccionada: `main` · HEAD: `74200a0e41d9`

## Resumen ejecutivo

Se implementó y verificó localmente el perfil `base` de C-06 con servicios
reales. Dos entornos simultáneos ejecutaron operaciones en PostgreSQL, Redis y
MinIO, comprobaron aislamiento y terminaron sin recursos Docker huérfanos. La
suite completa obtuvo **10/10 pruebas PASS**. C-06 global permanece
**IN_PROGRESS / PARTIALLY VERIFIED**: OpenSearch QAPAQ con TLS y el flujo oficial
Wazuh Manager → pipeline → Indexer siguen sin aceptación; el job C-06 de CI aún
no tiene run remoto observado.

## Plan técnico aplicado

| Etapa | Acción | Salida esperada | Resultado |
| --- | --- | --- | --- |
| 1. Base y capacidad | Actualizar `main`, revisar lock y medir Docker/RAM/disco | Requisitos observados antes de iniciar | PASS; 12 CPU, Docker 3.46 GiB, host 7 GiB, 11.1 GiB libres |
| 2. Reproducibilidad | Fijar Postgres/Redis/MinIO por versión y digest | Lock OCI y preflight verificable | PASS para `base` |
| 3. Harness | Mantener `starting` hasta health; CRUD real y cleanup aislado | Health, aislamiento, cleanup | PASS en dos entornos concurrentes |
| 4. Validación | Typecheck y suite de integración completa | Resultado y salida capturados | PASS; 10 pruebas, 4 archivos |
| 5. Perfiles pesados | OpenSearch TLS y Compose Wazuh oficial | Operación real + evidencia | BLOCKED; prerequisitos no satisfechos |
| 6. Cierre | CI remoto, checkout limpio y matriz global | Evidencia vinculada a SHA aceptado | Pendiente; no cerrar global |

## Cómo reproducir el perfil base

Desde la raíz del checkout, con Docker iniciado:

```powershell
pnpm --filter @qapaq/testing typecheck
pnpm run test:integration --reporter=verbose
```

La prueba `platform/testing/test/base-environment.integration.spec.ts` crea dos
instancias concurrentes y verifica:

1. IDs de ejecución, puertos, buckets y etiquetas Docker de ownership únicos.
2. PostgreSQL: versión del servidor y ciclo crear/leer/eliminar de schema
   aislado.
3. Redis: PING, INFO y SET/GET/TTL/DEL dentro del namespace del run.
4. MinIO: cliente S3 autenticado y CreateBucket/Put/Get/Head/Delete, contenido,
   longitud y metadata/hash SHA-256.
5. Teardown: no quedan contenedores con las etiquetas de esos runs; evidencia
   sanitizada escrita con commit, imágenes/digests, health y resultado de
   cleanup.

Las imágenes OCI utilizadas tienen tag y digest completos en
`platform/testing/integration-environment.lock.json`. El preflight `base` pide
3 GiB Docker/host y 5 GiB libres; los mínimos se calibraron a la ejecución
completa observada con 3.46 GiB Docker y 11.1 GiB disponibles. No se extrapola
esta reducción al setup oficial Wazuh.

El runner CI recibió `401 unauthorized` al descargar la imagen MinIO desde
Quay. Para mantener el flujo reproducible se usa el mirror público
`docker.io/tobi312/minio`, fijado por digest OCI; la prueba valida la API S3
real y registra explícitamente el registro e imagen usados en la evidencia.
Este mirror resuelve la descarga de CI, pero la imagen base debe volver a
evaluarse si cambia el origen o el digest publicado.

## Resultado y evidencia visual

Salida real guardada: `artifacts/integration/c06-validation-2026-09-24/vitest-integration.log`.
Evidencias JSON individuales:

- `artifacts/integration/c06-99424f90-f079-4248-9a13-d4d8f6fb1b09/environment-evidence.json`
- `artifacts/integration/c06-98fd2686-8e77-4db3-b89f-812f19a9bfa3/environment-evidence.json`

Ambas registran commit `74200a0e41d9abe9693b162ca2fba4264b2b35f0`, `workingTreeDirty: true`,
perfil `base`, `result: PASS`, servicios saludables, digests completos y
`cleanup.status: PASS` con lista de recursos remanentes vacía. Son runs locales
de árbol de trabajo modificado; el resultado remoto de CI queda pendiente.

**Salida completa de Vitest:**

![Captura renderizada desde stdout real de Vitest](assets/2026-09-24-c06-vitest-output.png)

**Dos evidencias JSON posteriores al cleanup:**

![Resumen visual de evidencias reales de ambos entornos](assets/2026-09-24-c06-environment-evidence.png)

Las imágenes son representaciones legibles de las salidas originales, no
capturas fotográficas de pantalla. Se pueden regenerar desde esos archivos con
`scripts/ci/render-c06-evidence.py`.

## Bloqueos restantes y tratamiento

### OpenSearch QAPAQ (`search`)

Hace falta TLS y autenticación de integración aprobados, digest de imagen
verificado y pruebas reales de conectividad/operaciones. OpenSearch QAPAQ se
mantiene distinto de Wazuh Indexer; no se mezclan certificados ni credenciales.

### Wazuh oficial (`wazuh` / `full`)

Se ejecutó `scripts/dev/setup-wazuh.ps1` usando el prerequisito oficial local.
El preflight terminó antes de clonar el Compose, descargar imágenes o iniciar
servicios: 12 CPU disponibles, pero Docker con 3.5 GiB frente a 8 GiB requeridos
y disco con 11 GiB frente a 50 GiB. No se descargaron artefactos pesados ni se
saltó la barrera. La salida real se preservó en
`artifacts/integration/c06-validation-2026-09-24/wazuh-preflight.log`.

![Salida real del preflight local Wazuh](assets/2026-09-24-c06-wazuh-preflight.png)

Para ejecutar después, provisionar capacidad conforme al script, seguir la
composición oficial fijada en `v4.14.7`, generar y verificar certificados, y
producir un marcador sintético autorizado observable a través de Manager →
pipeline → Indexer. Registrar las versiones/digests y confirmar teardown.

### Alternativa evaluada: Railway

La CLI local está instalada y autenticada; el inventario de solo lectura no
contiene un proyecto QAPAQ dedicado. No se tocaron los proyectos existentes ni
se creó infraestructura. Railway permite mapear servicios de Compose a
servicios separados con red privada, pero no ejecuta el `docker-compose.yml`
completo como Docker Compose; su documentación señala que no todos los campos
están soportados. La regla de Railway admite un solo volumen por servicio,
mientras que el manager del compose oficial tiene múltiples mounts persistentes.

Hay otra incógnita técnica que debe probarse en el host Railway: Wazuh Indexer
requiere `vm.max_map_count=262144` en el host Docker/Linux. La plataforma no
expone un ajuste de kernel en la documentación consultada. Por eso Railway es
una ruta experimental razonable con un proyecto aislado, no una capacidad
confirmada todavía. Una adaptación debería conservar las imágenes oficiales,
certificados, Manager → pipeline → Indexer y health checks; cualquier montaje
fusionado u omitido debe justificarse y quedar registrado en el plan de prueba.

Antes de crear servicios desplegados hay que verificar el plan y el límite de
gasto de la cuenta: la página oficial lista 5 GB de volumen total en Hobby y un
máximo superior en Pro; el preflight de Wazuh exige 50 GB de disco. La creación
de un piloto puede generar cargos de cómputo, imagen, disco y red. Referencias:
[guía Compose de Railway](https://docs.railway.com/guides/docker-compose),
[limitaciones de volúmenes](https://docs.railway.com/volumes/reference),
[precios y cuotas](https://docs.railway.com/pricing/plans), y
[requisito de kernel Wazuh](https://documentation.wazuh.com/current/deployment-options/docker/wazuh-container.html).

## Definition of Done: estado actual

| Gate | Estado |
| --- | --- |
| PostgreSQL, Redis, object storage: health y operaciones reales | PASS local |
| Aislamiento concurrente | PASS local |
| Limpieza completa de recursos por run | PASS local |
| Versiones/digests/commit registrados | PASS local; working tree dirty declarado |
| Suite C-06 en CI y artifact ligado al SHA | IN_REVIEW; falta observar el run remoto |
| OpenSearch real y TLS aprobado | BLOCKED |
| Wazuh oficial E2E Manager → pipeline → Indexer | BLOCKED |
| C-06 completo | IN_PROGRESS; no cumple todavía DoD global |

La matriz técnica viva está en
[`c-06-integration-testing.md`](../../architecture/c-06-integration-testing.md)
y la auditoría en
[`c-06-completeness-audit.md`](../../architecture/c-06-completeness-audit.md).

## Addendum de piloto Wazuh en Railway — 2026-09-25

Por autorización explícita se creó y luego eliminó el proyecto aislado
`qapaq-c06-wazuh-pilot-20260924` en Railway. Se usaron las imágenes oficiales
Wazuh `4.14.7` (Manager, Indexer y Dashboard) y el checkout oficial fijado en
`v4.14.7`, SHA `adcc5b57d2f7edfcbe6c399272dc76fbdf12b623`. Se adaptaron la
configuración TLS con SAN para DNS privado Railway y el arranque del Indexer
para asignar el volumen a UID 1000, manteniendo el entrypoint oficial. El
Indexer, Manager y Dashboard alcanzaron `RUNNING`; el log del Indexer muestra
inicialización de seguridad, creación del índice diario de alertas y health
`GREEN`. Filebeat del Manager inició, cargó el pipeline Wazuh de alertas y el
Indexer registró creación/mapeo de `wazuh-alerts-4.x-2026.09.25`.

El piloto **no demuestra E2E completo**: no se recuperó por API el documento
marcador `C06_RAILWAY_SYNTHETIC_20260925`. La sesión `railway ssh` no abrió desde
esta máquina y la sonda privada terminó al heredar el comando de la imagen base.
Por eso no se afirma que la alerta sintética haya sido consultada en el índice.
La evidencia respalda un smoke de topología/arranque, TLS privado y salud del
Indexer, no aceptación oficial de Wazuh ni el requisito de recursos completos.
Railway permitió un volumen de 5 GB frente a 50 GB de la especificación local;
no se validó `vm.max_map_count=262144` en el host. Esta arquitectura tampoco es
un despliegue Compose oficial íntegro: el manager fue efímero y los certificados
/configuración se prepararon para servicios separados.

Evidencia preservada antes de eliminar los servicios:
`artifacts/integration/c06-railway-2026-09-25/deployment-evidence.json`,
`wazuh-indexer.log` y `wazuh-manager.log`. El proyecto figura eliminado en el
inventario Railway; no quedan sus servicios en ejecución. La llave SSH temporal
registrada para este piloto fue desregistrada. C-06 permanece **IN_PROGRESS**.

**Salida real de Railway preservada antes del teardown:** el nodo Indexer
inicializó, Filebeat estableció la conexión TLS privada al Indexer, y el índice
diario de alertas quedó creado con shards en estado GREEN. La captura se
renderizó desde las líneas originales preservadas; el documento del marcador
sintético no fue consultado por API.

![Logs reales del smoke de Wazuh en Railway](assets/2026-09-25-c06-railway-wazuh-smoke.png)
