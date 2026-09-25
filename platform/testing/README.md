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
el test de aceptación `base-environment.integration.spec.ts` inicia dos
entornos concurrentes con Testcontainers: valida PostgreSQL (server version y
schema CRUD aislado), Redis (PING/INFO/SET/GET/TTL/DEL aislado) y MinIO (S3
autenticado, bucket/object CRUD, SHA-256 metadata). Comprueba ownership,
aislamiento y ausencia de contenedores remanentes al terminar.

El 2026-09-24 la suite completa pasó 10 pruebas en 4 archivos; el perfil `base`
pasó en dos entornos paralelos y generó dos evidencias con cleanup `PASS`. La
captura de stdout y la matriz de evidencia están en
[`docs/project-management/c-06`](../../docs/project-management/c-06/README.md).
OpenSearch requiere completar su configuración TLS aprobada. Wazuh requiere
ejecutar Compose oficial con capacidad suficiente; esos perfiles permanecen
`BLOCKED`.

Las imágenes y tags provienen de la baseline de [toolchain y capacidad](../../docs/architecture/toolchain-and-capacity.md)
y se declaran en `integration-environment.lock.json`. El perfil `postgres`
requiere su digest fijado y verificado. Los perfiles que aún tengan digests
`null` no producen evidencia reproducible para CI.

La evidencia se escribe en `artifacts/integration/<runId>/` después de aplicar
redacción. El teardown solo elimina recursos que llevan las tres etiquetas del
run actual. Los requisitos de disco y memoria se aplican por perfil: `base`
requiere 3 GiB y 5 GiB libres (límites calibrados en ejecución real); `search`
requiere 8 GiB y 20 GiB; Wazuh/full mantienen los límites de sus preflight y
setup documentados. No se interpretan como dimensionamiento de producción.
