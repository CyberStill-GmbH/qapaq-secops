# Entorno C-06 de integración

El harness vive en [`platform/testing`](../../platform/testing/README.md) y solo
se usa en desarrollo, pruebas y CI. No debe importarse desde `apps/`,
`modules/` ni desde un bundle de producción.

## Flujo operativo

1. Crear `IntegrationEnvironment` con el perfil mínimo de la suite.
2. Ejecutar `preflight()` y detenerse si el resultado es `BLOCKED` o `FAIL`.
3. Ejecutar `start()`; los contenedores usan puertos dinámicos y etiquetas del
   `runId`.
4. Ejecutar `health()` y las operaciones reales de la suite.
5. Ejecutar `collectEvidence()` antes de `stop()` si hubo un fallo.
6. Ejecutar `stop()` en `finally`, SIGINT, SIGTERM y timeout.

Los perfiles son:

| Perfil | Servicios | Estado de aceptación |
| --- | --- | --- |
| `postgres` | PostgreSQL por digest | Para evidencia C-04; requiere Docker y suite real |
| `base` | PostgreSQL, Redis, MinIO | Harness implementado; requiere Docker |
| `search` | `base` + OpenSearch QAPAQ | Bloqueado hasta TLS/configuración aprobada |
| `wazuh` | Manager + Indexer oficiales | Bloqueado hasta Compose/capacidad |
| `full` | `search` + `wazuh` | Bloqueado por las dependencias anteriores |

## Comandos

```powershell
pnpm --filter @qapaq/testing typecheck
pnpm run test:integration
```

Con Docker accesible, la suite de servicios ejecuta consultas reales contra
PostgreSQL y Redis. MinIO se valida desde el runtime. La topología Wazuh se
prepara con `pnpm run infra:setup-wazuh`, que usa el checkout oficial fijado en
v4.14.7 y nunca copia credenciales al repositorio.

## Evidencia y bloqueos

Cada ejecución puede escribir:

```text
artifacts/integration/<runId>/environment-evidence.json
```

La evidencia incluye commit, árbol sucio, perfil, imágenes, health y cleanup;
redacta passwords, tokens, access keys, connection strings y claves privadas.
El perfil `postgres` consume el digest fijado en
[`integration-environment.lock.json`](../../platform/testing/integration-environment.lock.json),
arranca por ese digest y lo verifica con `docker image inspect`. La suite C-04 se
ejecuta en el job `c04-postgres` y adjunta resultado, commit, versión/digest y
cleanup. Los otros perfiles aún necesitan sus propios digests antes de declarar
evidencia reproducible en CI.

El 2026-09-23 se aisló el caché roto de Secrets Engine con
`scripts/dev/repair-docker-desktop.ps1` y Docker Desktop volvió a exponer el
engine Linux. El perfil `postgres` pasó preflight, health, suite C-04 y cleanup;
su evidencia local es `c06-96005944-b033-45be-98ad-86661b4a1b09`. El engine
dispone de unos 3 GiB: cumple el mínimo de 2 GiB del perfil `postgres`, mientras
el perfil `base` conserva su mínimo de 4 GiB. La suite de integración C-06 de
PostgreSQL/Redis pasó por separado; object storage y Wazuh no quedan certificados
por esta ejecución.
