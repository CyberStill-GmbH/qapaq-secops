# Auditoría de completitud C-06

Fecha de verificación: 2026-09-24. Base de código inspeccionada: `main` en
`74200a0e41d9abe9693b162ca2fba4264b2b35f0`, con cambios locales aún sin
commit. Estado global: **IN_PROGRESS / PARTIALLY VERIFIED**. La ejecución real
local acredita el perfil `base`, no la topología completa OpenSearch/Wazuh ni CI.

## Resultado por criterio

| Criterio de aceptación | Resultado | Evidencia / pendiente |
| --- | --- | --- |
| API, estados y ciclo de vida | PASS en base | `start()` no marca saludable hasta finalizar health; teardown usado por suite |
| Fijación de imágenes | PASS en base | Postgres 18.6, Redis 8.10.1 y MinIO versionado con digest OCI en lock y JSON |
| Preflight Docker, host y disco | PASS en base | Docker 29.4.3; 3.46 GiB Docker, 7 GiB host, 11.1 GiB libres; mínimos base 3/3/5 |
| PostgreSQL health/operación | PASS | Server version y CRUD de schema aislado |
| Redis health/operación | PASS | PING, INFO, SET/GET/TTL/DEL, namespace aislado |
| Object storage real | PASS | MinIO S3 autenticado; CreateBucket, Put/Get/Head/Delete y SHA-256 metadata |
| Aislamiento concurrente | PASS | Dos run IDs concurrentes; puertos, bucket y ownership independientes |
| Cleanup/evidencia redactada | PASS | Dos JSON con cleanup PASS y cero recursos restantes |
| Suite de integración local | PASS | 4 archivos, 10 pruebas; log preservado bajo artifacts |
| CI C-06 | IN_REVIEW | Job `c06-base` y gate añadidos; run remoto aún no observado |
| OpenSearch QAPAQ + TLS | BLOCKED | Falta configuración TLS/autenticación aprobada, imagen fijada y operación real |
| Wazuh Manager → pipeline → Indexer | BLOCKED | El setup oficial no supera preflight de memoria/disco; sin clone/pull/start ni smoke |
| Perfiles `search`, `wazuh`, `full` | BLOCKED | Falta ejecutar prerequisitos anteriores y guardar evidencia ligada a commit limpio |

## Ejecución y trazabilidad

El comando `pnpm run test:integration --reporter=verbose` terminó con 10/10
pruebas aprobadas. `pnpm --filter @qapaq/testing typecheck` también terminó
correctamente. Los dos JSON base identifican el commit `74200a0...`, reportan
`workingTreeDirty: true`, las versiones/digests y el resultado de cleanup. No
atribuir esos resultados a un checkout limpio ni al workflow de GitHub.

Artefactos e imágenes se describen en el
[plan y ejecución de C-06](../project-management/c-06/README.md). La vista
ejecutiva de las dos evidencias y el stdout real están insertadas allí.

## Bloqueos cuantificados

El setup oficial local de Wazuh requiere al menos 4 CPU, 8 GiB Docker y 50 GiB
libres. La máquina reportó 12 CPU, 3.5 GiB Docker y 11 GiB libres. El script
terminó en su preflight antes de mutar el workspace o descargar imágenes. No se
omitió ese control. OpenSearch QAPAQ, adicionalmente, no tiene TLS/auth de
integración aprobados en el repo.

## Condiciones para cerrar C-06

1. Aprobar y fijar configuración TLS/autenticación e imagen OCI de OpenSearch;
   ejecutar health y operaciones reales del perfil `search`.
2. Habilitar runner con recursos/disco conforme al setup Wazuh; ejecutar la
   composición oficial `v4.14.7`, certs y prueba sintética Manager → pipeline →
   Indexer. Registrar versiones/digests, commit y limpieza.
3. Ejecutar el job `c06-base` en CI y adjuntar evidencia al SHA evaluado.
4. Repetir aceptación con checkout limpio tras integrar los cambios y actualizar
   esta auditoría con los artefactos CI y los runs pesados aprobados.

```text
C-06 base: PASS / VERIFIED LOCAL
C-06 search: BLOCKED
C-06 Wazuh: BLOCKED BY INFRASTRUCTURE / E2E NOT RUN
C-06 global: IN_PROGRESS / PARTIALLY VERIFIED
```

### Addendum Railway — 2026-09-25

Se ejecutó un piloto aislado y ya eliminado de Wazuh `4.14.7` en Railway. Los
servicios Manager, Indexer y Dashboard alcanzaron `RUNNING`; OpenSearch Indexer
inicializó seguridad, creó/mapeó `wazuh-alerts-4.x-2026.09.25` y reportó health
`GREEN`. Filebeat cargó el pipeline Wazuh. Evidencia de despliegues y logs:
`artifacts/integration/c06-railway-2026-09-25/`.

Esto acredita un smoke de arranque y salud del Indexer en la configuración
adaptada. No acredita que el marcador sintético se haya leído de vuelta mediante
la API del índice: Railway SSH no abrió y la sonda privada no ejecutó el comando
esperado. Tampoco acredita el sizing oficial (volumen Railway 5 GB frente a 50
GB requeridos) ni `vm.max_map_count=262144`. Wazuh E2E sigue BLOCKED; C-06 global
sigue IN_PROGRESS. El piloto no cambió los criterios de aceptación.
