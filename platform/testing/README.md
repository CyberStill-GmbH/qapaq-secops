# C-06 — entorno real de integración

`@qapaq/testing` contiene el harness reutilizable para pruebas de plataforma. No
se importa desde aplicaciones ni desde dominio y no inicia contenedores al
importarse.

## API

`IntegrationEnvironment` expone `preflight()`, `start()`, `health()`,
`collectEvidence()` y `stop()`. Cada ejecución recibe un `runId` UUID, etiquetas
de ownership (`qapaq.test`, `qapaq.test.run-id` y `qapaq.test.owner`) y nombres
derivados de esa identidad. Las credenciales solo viven en el runtime.

Los perfiles son `postgres` (PostgreSQL fijado por digest para C-04), `base`
(PostgreSQL, Redis y MinIO), `search` (base más el
componente OpenSearch pendiente de TLS aprobado), `wazuh` (topología Wazuh
pendiente de Compose oficial y capacidad) y `full` (search+wazuh). Un perfil
pendiente queda `BLOCKED`; nunca se informa como PASS.

## Ejecución

```text
pnpm run test:integration
pnpm --filter @qapaq/testing typecheck
```

Cuando Docker no está disponible, las suites reales se marcan como omitidas y
el preflight conserva el resultado `BLOCKED`. En una máquina con Docker activo,
los tests de PostgreSQL y Redis usan Testcontainers con puertos dinámicos y
realizan `SELECT 1` y `PING`; MinIO se valida mediante su health endpoint en el
runtime. OpenSearch y Wazuh requieren completar su configuración TLS y su
topología oficial antes de aceptar esos perfiles.

Las imágenes y tags provienen de la baseline de [toolchain y capacidad](../../docs/architecture/toolchain-and-capacity.md)
y se declaran en `integration-environment.lock.json`. El perfil `postgres`
requiere su digest fijado y verificado. Los perfiles que aún tengan digests
`null` no producen evidencia reproducible para CI.

La evidencia se escribe en `artifacts/integration/<runId>/` después de aplicar
redacción. El teardown solo elimina recursos que llevan las tres etiquetas del
run actual.
