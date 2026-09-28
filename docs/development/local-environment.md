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

Las aplicaciones leen únicamente variables `QAPAQ_*` mediante
`@qapaq/configuration`. `QAPAQ_PROFILE` es obligatorio. Los valores de secretos del
Compose local permanecen separados de sus referencias
`secret://environment/<VARIABLE>`; el adaptador de entorno está prohibido en
producción. La lista completa y sus límites está en
[`platform/configuration/README.md`](../../platform/configuration/README.md).

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

### Diagnóstico y recuperación

Antes de reiniciar, guarda el trabajo activo en contenedores y captura el error:

```powershell
wsl --status
wsl --list --verbose
docker desktop status
docker info
Get-PSDrive -Name C | Select-Object Used,Free
docker desktop diagnose
```

`docker desktop diagnose` puede tardar varios minutos; conserva el ID/ruta de
diagnóstico para el ticket de Infraestructura. Si el cliente de Docker no responde,
usa Docker Desktop → Troubleshoot → Get support. No adjuntes `.env`, credenciales,
tokens ni archivos de volúmenes a un ticket.

Si el síntoma es el fallo conocido de los sockets `dockerInference`/`engine.sock`,
con Docker Desktop cerrado ejecuta desde PowerShell:

```powershell
pwsh -NoProfile -File scripts/dev/repair-docker-desktop.ps1
```

El script detiene Docker/WSL, mueve ambos directorios de socket a nombres con
timestamp bajo `%LOCALAPPDATA%` (no los borra), respalda `settings-store.json`,
desactiva Docker AI/Inference —no usados por QAPAQ— y vuelve a iniciar Docker. Si
`docker info` no responde en 90 segundos, detente y adjunta los logs/diagnósticos;
no repitas el script en bucle. `wsl --shutdown` detiene todas las distribuciones
WSL2 activas y la VM ligera; guarda antes cualquier trabajo WSL. No desregistra
distribuciones ni borra sus discos.

Valida daemon, red y operación del runtime antes de reintentar la suite:

```powershell
docker desktop status
docker info --format 'Server={{.ServerVersion}} CPUs={{.NCPU}} Memory={{.MemTotal}}'
docker run --rm hello-world
pnpm run test:integration
```

### Caché de build y espacio WSL/Docker

No confundir caché BuildKit con sockets Docker ni con datos del Indexer/volúmenes.
Una caché grande normalmente no explica que `docker info` no conecte; primero
recupera el daemon. Con Docker sano, inspecciona el uso y limpia solo caché de
compilación si es necesario:

```powershell
docker system df -v
docker builder prune
```

`docker builder prune` elimina caché de build no usada y puede hacer más lentas las
compilaciones siguientes; revisa su confirmación interactiva. No uses limpieza
masiva para “arreglar WSL”: `docker system prune -a --volumes`, `docker volume
prune`, Docker Desktop **Clean up data / Factory reset**, `wsl --unregister` ni
borrar/compactar manualmente `ext4.vhdx` pueden eliminar estado persistente. La VM
puede conservar memoria asignada hasta `wsl --shutdown`; esto reinicia la VM, no es
una operación para purgar datos. Si el disco virtual sigue sin espacio tras
limpiar caché de build, escala a Infraestructura antes de tocar VHDX o la
distribución `docker-desktop-data`.

El repair script deja directorios `*.stale-<timestamp>` y backups de settings para
diagnóstico. No los elimines hasta confirmar arranques estables y que no contienen
evidencia requerida. Si el error reaparece o Docker no expone el engine Linux tras
la reparación, detener cambios locales y escalar a Platform/Infraestructura con
el Diagnostic ID y hora exacta.

Referencias: [troubleshooting de Docker Desktop](https://docs.docker.com/desktop/troubleshoot-and-support/troubleshoot/topics/),
[recolección de diagnósticos](https://docs.docker.com/desktop/troubleshoot-and-support/troubleshoot/),
[limpieza de caché de build](https://docs.docker.com/engine/manage-resources/pruning/),
[comandos básicos de WSL](https://learn.microsoft.com/en-us/windows/wsl/basic-commands),
[administración del disco WSL](https://learn.microsoft.com/en-us/windows/wsl/disk-space),
[configuración de Docker Desktop](https://docs.docker.com/desktop/settings-and-maintenance/settings/) y
[despliegue Docker de Wazuh](https://documentation.wazuh.com/current/deployment-options/docker/wazuh-container.html).
