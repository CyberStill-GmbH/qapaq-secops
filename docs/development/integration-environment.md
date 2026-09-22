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
Los digests se resuelven con `docker image inspect`; si el daemon o el registry
no están disponibles, permanecen pendientes y la ejecución no puede declararse
reproducible para CI.

En el host actual Docker Desktop no expone `dockerDesktopLinuxEngine`, por lo que
la ejecución base queda `BLOCKED BY INFRASTRUCTURE`. El preflight no descarga
imágenes ni intenta arrancar Wazuh cuando falta capacidad.
