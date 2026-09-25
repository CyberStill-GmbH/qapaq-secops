# C-06 — entorno real de integración

Estado global: **IN_PROGRESS / PARTIALLY VERIFIED** (verificación local del
perfil `base`: **PASS**, 2026-09-24). El harness se encuentra en
`platform/testing`; sus perfiles pendientes conservan el estado `BLOCKED` y no
producen PASS implícito.

## Alcance y perfiles

| Perfil | Servicios | Criterio de ejecución | Estado al 2026-09-24 |
| --- | --- | --- | --- |
| `postgres` | PostgreSQL | Digest bloqueado, query y teardown | Implementado; suite real existente |
| `base` | PostgreSQL, Redis y MinIO | Operaciones reales, aislamiento, evidencia y limpieza | PASS local; dos entornos concurrentes probados |
| `search` | `base` + OpenSearch QAPAQ | TLS/autenticación QAPAQ y CRUD/health real | BLOCKED; configuración TLS y digest no disponibles |
| `wazuh` | Topología oficial Wazuh | Manager → pipeline → Indexer, setup oficial y smoke | BLOCKED; preflight de recursos no cumple |
| `full` | `search` + `wazuh` | Flujo completo con capacidad aprobada | BLOCKED |

`IntegrationEnvironment` expone `preflight()`, `start()`, `health()`,
`collectEvidence()` y `stop()`. Cada ejecución usa `runId`, labels de ownership y
nombres de recursos aislados. Las credenciales se mantienen en runtime. El
`start()` no declara `healthy` antes de completar los health checks.

## Evidencia reproducible del perfil base

La suite `platform/testing/test/base-environment.integration.spec.ts` ejecuta
dos entornos reales a la vez y comprueba puertos, bucket y etiquetas distintos;
PostgreSQL `server_version` y CRUD de schema aislado; Redis `PING`, `INFO`,
`SET/GET/TTL/DEL` con namespace propio; y MinIO mediante S3 autenticado con
`CreateBucket`, `Put/Get/Head/Delete` y metadata SHA-256. Al terminar, verifica
que no quedan contenedores con ownership de esos runs y escribe evidencia
sanitizada por run.

Referencias de ejecución:

- Commit inspeccionado: `74200a0e41d9abe9693b162ca2fba4264b2b35f0`.
- Runs locales: `c06-99424f90-f079-4248-9a13-d4d8f6fb1b09` y
  `c06-98fd2686-8e77-4db3-b89f-812f19a9bfa3`; ambos `PASS`, cleanup `PASS`, cero
  recursos restantes. Se registra `workingTreeDirty: true`; estos artifacts no
  representan un checkout limpio ni un resultado de CI.
- OCI digests completos están en `platform/testing/integration-environment.lock.json`
  y en `artifacts/integration/<runId>/environment-evidence.json`.
- Suite completa: 4 archivos y 10 pruebas aprobados; salida preservada en
  `artifacts/integration/c06-validation-2026-09-24/vitest-integration.log`.
- El workflow contiene `c06-base`, pero aún no existe una ejecución remota de
  ese job que permita afirmar PASS de CI.

El umbral `base` del harness se fijó en 3 GiB de Docker y host, y 5 GiB libres en
disco, pues la prueba completa pasó en el engine local medido en 3.46 GiB y con
11.1 GiB disponibles. Esto calibra únicamente el perfil base comprobado; no
rebaja los prerequisitos del Compose oficial Wazuh ni la capacidad de referencia
del entorno full.

## Requisitos de ejecución

```powershell
pnpm --filter @qapaq/testing typecheck
pnpm run test:integration --reporter=verbose
```

Docker debe estar iniciado y disponible para Testcontainers. El lock contiene
tags y digests para los servicios que se lanzan. `artifacts/integration/` es
salida local ignorada por Git; se debe conservar el JSON asociado al run si se
requiere trazar la prueba.

## Perfiles no aceptados y cierre global

OpenSearch de QAPAQ permanece separado de Wazuh Indexer: no se infieren
credenciales, certificados, índices ni puertos compartidos. Para aceptar
`search` hace falta TLS/autenticación aprobados, imagen fijada por digest, y
health/operaciones reales. Para Wazuh debe usarse la composición oficial
`v4.14.7`, generar/verificar sus certificados y observar el flujo real Manager
→ pipeline → Indexer con datos sintéticos autorizados.

La comprobación local de `scripts/dev/setup-wazuh.ps1` se detuvo antes de clonar,
descargar o iniciar servicios: Docker reportó 3.5 GiB, 12 CPU y el disco 11 GiB;
el script exige 8 GiB, 4 CPU y 50 GiB. No se intentó `-PullOnly`, que ocuparía
espacio adicional sin permitir el arranque. La captura derivada de la salida se
encuentra en
[`2026-09-24-c06-wazuh-preflight.png`](../project-management/c-06/assets/2026-09-24-c06-wazuh-preflight.png).

Por tanto, C-06 global continúa `IN_PROGRESS`: la aceptación de `base` es real y
reproducible localmente; OpenSearch/TLS, Wazuh E2E y el run remoto de CI siguen
pendientes. La matriz de cierre y los pasos ejecutados están en
[`Plan y ejecución C-06`](../project-management/c-06/README.md).
