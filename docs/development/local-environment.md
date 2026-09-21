# Entorno local de desarrollo

Estado: baseline ejecutable del MVP.

## Toolchain fijado

- Node.js 24.21.0;
- pnpm 12.4.2;
- Docker Desktop con backend WSL2 y Docker Compose;
- Chromium de Playwright instalado por `pnpm exec playwright install chromium`;
- Python excluido del runtime del MVP por ADR-007.

La instalación reproducible parte de la raíz del repositorio:

```powershell
corepack enable
pnpm install --frozen-lockfile
Copy-Item .env.example .env.local
pnpm run infra:up
```

`infra:up` inicia PostgreSQL 18.6, Redis 8.10.1 y MinIO. El stack oficial Wazuh
se instala por separado porque aporta Manager, Wazuh Indexer basado en OpenSearch
y Wazuh Dashboard basado en OpenSearch Dashboards:

```powershell
pnpm run infra:setup-wazuh
```

No se debe añadir un segundo OpenSearch a `infra/local/compose.yaml`. QAPAQ accede
al Indexer de Wazuh mediante `@opensearch-project/opensearch` y una credencial de
solo lectura que se materializará al implementar el conector.

## Capacidad previa a Wazuh

El perfil oficial single-node requiere como mínimo 4 cores, 8 GiB de RAM y 50 GiB
de almacenamiento disponible. Antes de levantarlo se comprueba:

```powershell
docker info --format 'CPUs={{.NCPU}} MemBytes={{.MemTotal}}'
Get-PSDrive -Name C | Select-Object Used,Free
wsl -d docker-desktop -u root sysctl vm.max_map_count
```

`vm.max_map_count` debe ser al menos `262144`. Si el host no alcanza memoria o
disco, se permite precargar las imágenes sin iniciar el stack:

```powershell
pwsh -NoProfile -File scripts/dev/setup-wazuh.ps1 -PullOnly
```

La falta de capacidad mantiene la integración `BLOCKED`; no autoriza reemplazar
Wazuh, OpenSearch ni sus APIs con fakes.

## Comprobaciones

```powershell
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run boundaries
pnpm run test:unit
pnpm run test:integration
pnpm run test:e2e
pnpm run build
```

Los specs de integración crean PostgreSQL y Redis reales con Testcontainers. El
primer arranque puede descargar imágenes y tardar más; el timeout de preparación
no sustituye ninguna aserción.

## Recuperación de Docker Desktop en Windows

Docker Desktop puede quedar en un ciclo de cierre tras una salida abrupta si sus
sockets AF_UNIX quedan como reparse points inaccesibles. Los mensajes observados
son `initializing Inference manager` sobre `dockerInference` y, después,
`initializing Secrets Engine` sobre `engine.sock`.

La reparación debe aislar ambos directorios en el mismo ciclo, con Docker y WSL
detenidos. `scripts/dev/repair-docker-desktop.ps1` renombra los directorios con
timestamp, conserva un respaldo, desactiva las funciones de inferencia no usadas
por QAPAQ, reinicia Docker y valida el daemon con `docker info`. No elimina
imágenes, volúmenes ni datos y no ejecuta factory reset.

Después de reparar:

```powershell
docker desktop status
docker run --rm hello-world
pnpm run test:integration
```

Referencias: [troubleshooting de Docker Desktop](https://docs.docker.com/desktop/troubleshoot-and-support/troubleshoot/topics/),
[configuración de Docker Desktop](https://docs.docker.com/desktop/settings-and-maintenance/settings/)
y [despliegue Docker de Wazuh](https://documentation.wazuh.com/current/deployment-options/docker/wazuh-container.html).
