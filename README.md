# QAPAQ SecOps

Monolito modular para la vertical Microsoft 365 → Wazuh → QAPAQ SecurityEvent →
operación SOC. La documentación canónica está en [`docs/`](docs/README.md).

## Requisitos locales

- Node.js 24.21.0 y pnpm 12.4.2;
- Docker Desktop con Compose;
- 12 vCPU, 32 GiB RAM y 200 GiB disponibles para el perfil completo con Wazuh.

## Inicio

```powershell
corepack enable
pnpm install --frozen-lockfile
Copy-Item .env.example .env.local
pnpm run infra:setup-wazuh
pnpm run infra:up
pnpm run build
pnpm run test:unit
pnpm run test:integration
pnpm run test:e2e
```

`infra:setup-wazuh` clona el tag oficial fijado bajo `.local/`, genera certificados
y levanta Manager, Wazuh Indexer basado en OpenSearch y Wazuh Dashboard basado en
OpenSearch Dashboards. QAPAQ usa el cliente oficial OpenSearch contra el Wazuh
Indexer; no mantiene un segundo clúster. Las credenciales locales permanecen fuera
de Git.

Si Docker Desktop entra en un ciclo de cierre por sockets AF_UNIX obsoletos, usar
`pnpm run infra:repair-docker`. El procedimiento conserva respaldos y no elimina
imágenes ni volúmenes; consultar el
[runbook local](docs/development/local-environment.md#recuperación-de-docker-desktop-en-windows).

## Entrypoints C-02 sin servicios externos

API y worker requieren un perfil explícito. C-02 no necesita Docker ni secretos:

```powershell
$env:QAPAQ_PROFILE = 'test'
pnpm --filter @qapaq/api... build
node apps/api/dist/main.js
# En otra terminal: GET http://127.0.0.1:3100/health/ready
```

Para desarrollo, usar `pnpm dev:api`, `pnpm dev:worker` o `pnpm dev:web`.
Para verificar artefactos desde la raíz: `pnpm smoke:api`, `pnpm smoke:worker`,
`pnpm smoke:web` y `pnpm test:e2e` (requiere el build web y Chromium de Playwright).
No hay login ni datos operativos en la shell inicial.

Semántica de health, lifecycle, configuración pública, evidencia y límites:
[entrega C-02](docs/development/c-02-entrypoints.md).

## Orden del workspace

- `apps/`: entrypoints API, worker y web;
- `modules/`: capacidades de negocio, con acceso solo por su superficie pública;
- `platform/`: configuración, base de datos, auditoría, observabilidad y testing;
- `packages/contracts`: contratos versionados compartidos;
- `infra/local`: infraestructura QAPAQ local complementaria a Wazuh;
- `scripts/dev`: automatización del entorno;
- `tests/e2e`: recorridos reales entre procesos.

No crear carpetas vacías ni un paquete `shared`. Cada nuevo componente debe estar
vinculado a un PBI, tener owner, contrato y specs según el
[plan de componentes](docs/project-management/component-delivery-plan.md).
