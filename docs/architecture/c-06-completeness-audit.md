# Auditoría de completitud C-06

Fecha de verificación: 2026-09-22. Esta auditoría distingue implementación de
ejecución real. El resultado global es **PARTIALLY VERIFIED**; C-06 no puede
cerrarse como completo.

## Evidencia ejecutada

| Comprobación | Resultado |
| --- | --- |
| `docker info` | PASS — Docker 29.4.3, 12 CPU, 3.46 GiB reportados al engine |
| `pnpm run test:integration` | PASS — 6 tests, incluyendo PostgreSQL y Redis reales |
| `pnpm --filter @qapaq/testing typecheck` | PASS |
| `pnpm run lint` | PASS |
| `pnpm run format:check` | PASS |
| `pnpm run boundaries` | PASS |
| `prisma migrate deploy` directo | PASS — sin migraciones pendientes |
| MinIO S3 CRUD con hash | NOT_RUN |
| OpenSearch autenticado con TLS | NOT_RUN |
| Wazuh Manager → pipeline → Indexer | NOT_RUN |

La infraestructura local de PostgreSQL, Redis y MinIO aparece saludable en
Compose. La suite existente valida `SELECT 1` y `PING`; no valida todavía todas
las operaciones exigidas por C-06.

## Matriz contra los criterios de aceptación

| Criterio | Estado | Hallazgo |
| --- | --- | --- |
| API y estados del entorno | PARCIAL | Existe `IntegrationEnvironment`; `start()` marca `healthy` antes de ejecutar todos los health checks. |
| Perfiles base/search/wazuh/full | PARCIAL | `base` inicia PostgreSQL/Redis/MinIO; search y Wazuh quedan placeholders `BLOCKED`. |
| Imágenes con tag y digest | NO CUMPLE | Los seis digests de `integration-environment.lock.json` son `null`. |
| Preflight Docker/CPU/memoria | PARCIAL | Comprueba daemon, CPU, arquitectura y memoria; faltan disco, red, volumen, puertos, Compose e imágenes. |
| Identidad y labels | PARCIAL | Testcontainers usa labels; Compose local persistente no queda aislado por `runId`. |
| PostgreSQL health/operación | PARCIAL | `SELECT 1` real; faltan `server_version`, schema aislado y lifecycle de schema. |
| Redis health/operación | PARCIAL | `PING` real; faltan `INFO`, prefijo, expiración, autenticación y cleanup de clave. |
| MinIO health/operación | NO CUMPLE | Solo existe health HTTP; faltan autenticación S3, bucket, escritura, lectura, SHA-256, metadata y borrado. |
| OpenSearch QAPAQ | NO CUMPLE | No hay contenedor ni cliente de integración; solo bloqueo documentado. |
| Wazuh Manager/Indexer | NO CUMPLE | No hay composición desde el harness, health, TLS, autenticación ni smoke de transporte. |
| Evento Wazuh E2E | NO CUMPLE | No se genera marcador ni se consulta el Indexer después del pipeline real. |
| Evidencia | PARCIAL | API y writer existen; no se adjuntan logs de fallo ni evidencia automática del ciclo completo. |
| Teardown | PARCIAL | Detiene contenedores del runtime; no verifica recursos restantes ni señales SIGINT/SIGTERM. |
| Aislamiento paralelo | PARCIAL | Hay `runId` y puertos dinámicos en Testcontainers; no existen pruebas de dos entornos completos. |
| CI | NO CUMPLE | `.github/workflows/ci.yml` no ejecuta los perfiles de integración C-06. |
| TLS y secretos | PARCIAL | No se persisten credenciales en evidencia; OpenSearch/Wazuh TLS no están ejecutados. |

## Bloqueos exactos

1. Los digests reales deben resolverse desde Docker/registry y fijarse en el lock.
2. El perfil `base` requiere al menos 4 GiB para Docker; el engine actual
   reporta aproximadamente 3.46 GiB.
3. `search` necesita una configuración TLS autenticada de OpenSearch QAPAQ.
4. `wazuh`/`full` necesitan el Compose oficial Wazuh v4.14.7, certificados,
   credenciales sintéticas, al menos 16 GiB para el perfil pesado y una prueba
   real Manager → Indexer.
5. CI necesita un job de integración base y un job pesado separado, con runner y
   retención de evidencia aprobados.

## Conclusión

C-06 tiene una base de harness reutilizable y una validación real parcial de
PostgreSQL/Redis. No cumple todavía los criterios de cierre global porque faltan
MinIO CRUD, OpenSearch, Wazuh E2E, digests, preflight completo, cleanup
verificado y ejecución en CI. El estado correcto es:

```text
C-06 base: PARTIALLY VERIFIED
C-06 search: BLOCKED
C-06 Wazuh: BLOCKED BY INFRASTRUCTURE / NOT IMPLEMENTED
C-06 global: PARTIALLY VERIFIED
```

La secuencia se verifica además en
`platform/testing/test/pipeline-completeness.spec.ts`. Ese test valida el orden
del flujo y exige que los tramos sin implementación permanezcan `BLOCKED` o
`NOT_RUN`; no convierte la ausencia de OpenSearch/Wazuh en un PASS artificial.
