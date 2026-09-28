# Daily Scrum — Informe de avance — 2026-09-24

Preparado el 2026-09-24 con corte de código en `main` (`8901a1b`, integrado el
2026-09-23 a las 21:09, hora de Lima). Sprint 1 — Base ejecutable y contratos
(2026-09-19 a 2026-10-02). Facilitador: Cesar Adrian Guevara Salcedo.

Este informe alimenta el registro continuo de [Daily Scrum](../daily-scrum.md) y
sigue sus estados y la Definition of Done. La última punta de `main` no tiene un
run CI citado en este informe: el run exitoso `35945693397` corresponde a
`c213073`, no al SHA exacto `8901a1b`.

## Resumen ejecutivo

`main` integra la primera implementación del comando público `commitAdmission`
para C-04 y la generación de evidencia PostgreSQL en CI. El run `35945693397`
terminó `success` para `c213073`; el job produjo evidencia redactada con imagen
PostgreSQL fijada por digest, cinco pruebas y limpieza. C-04 continúa
`IN_PROGRESS`: la prueba y el comando avanzaron, pero su matriz de siete criterios
no está completa. C-06 también permanece `IN_PROGRESS`, con perfiles `search` y
`wazuh` aún sin aceptación real. No se verifican nuevos commits fechados el
2026-09-24; el último merge de `main` fue el 2026-09-23.

## Avance por componente

| ID | Estado | Avance / evidencia al corte |
| --- | --- | --- |
| C-01 | `DONE` | Workspace y toolchain reproducibles, según el registro previo. |
| C-02 | `DONE` | API, worker y web con lifecycle, health y composición separados. |
| C-03 | `DONE` | Configuración tipada, `SecretProvider` y fallo seguro. |
| C-04 | `IN_PROGRESS` | `commitAdmission` incorpora admisión transaccional, recibo idempotente y CAS del checkpoint. La suite PostgreSQL visible tiene cuatro casos; el run CI documentado registra cinco pruebas. Persisten casos de rechazo, rollback exhaustivo, identidad/reintentos y límites. |
| C-05 | `DONE` | Contrato SecurityEvent y corpus documentados previamente. |
| C-06 | `IN_PROGRESS` | PostgreSQL por digest y job C-04 en CI; PostgreSQL/Redis local reportados. Faltan MinIO CRUD, digests restantes, TLS/OpenSearch y flujo Wazuh E2E. El perfil `base` requiere al menos 4 GiB y el engine local registra cerca de 3 GiB. |
| C-07 | `DONE` | Límites de dependencias y entrypoints verificados previamente. |
| C-08 | `IN_PROGRESS` | No consta una consulta real a Wazuh/Indexer autorizado; accesos externos por confirmar. |
| C-09 | `IN_PROGRESS` | CI y gate habilitados, pero la protección obligatoria de `main` sigue por confirmar. |

## Evidencia del avance reciente

- `8901a1b` integra C-04 y los cambios en CI/harness; `b25b59c` agrega el
  comando transaccional y `82f4a25` instrumenta PostgreSQL y la evidencia CI.
- El job `c04-postgres` arranca PostgreSQL por digest, ejecuta la suite y adjunta
  un artifact redactado con versión, commit y estado de cleanup.
- El run [35945693397](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/35945693397)
  terminó `success` en el commit `c213073`; incluye cinco pruebas y el gate CI.
  No se atribuye ese resultado al SHA exacto de la punta de `main`.
- El lock fija PostgreSQL 18.6; Redis, MinIO, OpenSearch y las imágenes Wazuh
  siguen con digest `null`, lo que impide afirmar reproducibilidad de esos
  perfiles.

## Bloqueos y riesgos vigentes

| Elemento | Dueño | Siguiente acción |
| --- | --- | --- |
| Tenant, permisos, Wazuh/Indexer y `secretRefs` sin confirmar | Franco Clavo Santander | Acordar dueño y fecha antes del 2026-09-25. |
| Memoria local insuficiente para el perfil `base`; TLS y servicios pendientes para `search`/`wazuh` | Infraestructura + Cesar | Confirmar capacidad, configuración y secuencia de pruebas. |
| Protección de rama `main` por confirmar | Cesar + Franco | Definir PR obligatorio y checks requeridos. |
| Matriz C-04 parcialmente probada | Cesar | Ampliar pruebas de rechazo, idempotencia, CAS y rollback con artifact por commit. |

## Foco hasta el siguiente Daily

Mantener WIP máximo de dos componentes: C-04 y C-06. Completar la evidencia
reproducible C-04; mantener el perfil PostgreSQL de C-06 operativo y dejar
registrados los prerrequisitos de los demás perfiles. Escalar los accesos de
Microsoft 365/Wazuh antes del 2026-09-25 y confirmar la política de protección de
`main`.

Cambio al Sprint Backlog: no se registra cambio aceptado de alcance.

Confianza en el Sprint Goal: **ÁMBAR**. La base ejecutable y CI avanzaron; el
cierre depende de cobertura C-04, capacidad de integración y accesos autorizados.

Nota de marca: los informes encontrados en el repositorio son Markdown y no
incluyen un archivo gráfico de logo Qapaq. El PDF asociado utiliza un wordmark
vectorial tipográfico para identificar el producto; no se presenta como un
recurso oficial del repositorio.
