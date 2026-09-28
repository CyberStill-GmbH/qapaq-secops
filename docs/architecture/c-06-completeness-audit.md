# Auditoría de completitud C-06

Fecha de cierre: 2026-09-25. Base verificada en CI: commit limpio
`1c4d7cd7047e6047c8b3b27f1de81cef55879822`. E2E complementario en Railway:
commit `9adbbe33c2961f83fb92d30fd683a9da0541e6c8`. Estado global:
**DONE** con excepción de capacidad de pruebas aceptada para este cierre.
Railway acreditó OpenSearch TLS/CRUD y Wazuh Manager → pipeline → Indexer con
marcador consultado por API. El sizing oficial del Compose Wazuh no se alcanzó;
la aceptación de esta entrega usa la capacidad disponible para el piloto.

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
| CI C-06 | PASS | Run `36154234794`; dos entornos concurrentes, ambos cleanup PASS, artifacts ligados al SHA limpio |
| OpenSearch QAPAQ + TLS | PASS Railway | 3.7.0, CA propia, TLS validado, health GREEN, CRUD y cleanup PASS |
| Wazuh Manager → pipeline → Indexer | PASS Railway | 4.14.7, syslog sintético, regla 100501 y marcador recuperado por API |
| Suite/CI del perfil base | PASS | Checkout limpio, dos entornos concurrentes, health, aislamiento y cleanup |
| Capacidad vs. sizing oficial Wazuh | EXCEPCIÓN ACEPTADA | Se aceptó el entorno de pruebas disponible para este cierre; no se declara que cumpla el mínimo oficial |
| Perfiles locales `search`, `wazuh`, `full` | LIMITACIÓN ACEPTADA | La aceptación E2E fue remota en Railway; el harness local aún no los orquesta |

## Ejecución y trazabilidad

El comando local `pnpm run test:integration --reporter=verbose` terminó con
10/10 pruebas aprobadas. La suite remota C-06 pasó el 2026-09-25 en un checkout
limpio: dos entornos concurrentes registraron PostgreSQL 18.6, Redis 8.10.1 y
MinIO S3 con digest, health, aislamiento y cleanup. Ambos JSON están versionados
en `docs/project-management/c-06/assets/2026-09-25-c06-ci-run-{a,b}.json`.
El job C-04 PostgreSQL y el gate general también pasaron en el mismo run.

Artefactos e imágenes se describen en el
[plan y ejecución de C-06](../project-management/c-06/README.md). La vista
ejecutiva de las dos evidencias y el stdout real están insertadas allí.

## Bloqueos cuantificados

El setup oficial local de Wazuh requiere al menos 4 CPU, 8 GiB Docker y 50 GiB
libres. La máquina reportó 12 CPU, 3.5 GiB Docker y 11 GiB libres. El script
terminó en su preflight antes de mutar el workspace o descargar imágenes. Para
este cierre se aceptó la capacidad disponible del piloto como excepción de
pruebas. OpenSearch TLS/auth se probó por separado con CA propia.

## Decisión de cierre y trabajo posterior

La decisión de producto para este cierre acepta la capacidad disponible en el
entorno de pruebas Railway aunque no alcance el sizing oficial del Compose
Wazuh. Esta excepción queda acotada a pruebas de integración; no cambia los
requisitos de despliegue. Se da por cerrado el alcance funcional con CI `base`,
OpenSearch TLS/CRUD/cleanup y Wazuh E2E observados con evidencia guardada. Como
mejora posterior se puede incorporar el perfil local TLS `search`, automatizar
la composición oficial Wazuh y repetirla en un host con capacidad de referencia.

```text
C-06 base: PASS / VERIFIED LOCAL + CI CLEAN
C-06 base CI: PASS
C-06 OpenSearch TLS + CRUD + cleanup: PASS
C-06 Wazuh synthetic Manager -> pipeline -> Indexer: PASS
C-06 available test capacity: ACCEPTED EXCEPTION (decision 2026-09-25)
C-06 global: DONE (capacity exception recorded)
```

La evidencia Railway final está en
`../project-management/c-06/assets/2026-09-25-c06-railway-full-e2e.json` y su
imagen asociada. El addendum de smoke y los estados `BLOCKED` de las entradas
históricas siguientes describen la corrida previa; la corrida E2E posterior y
la excepción registrada arriba son las vigentes para el cierre.

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
