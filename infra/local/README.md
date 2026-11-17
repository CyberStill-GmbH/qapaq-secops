# Infraestructura local (stack Docker de QAPAQ SecOps)

Réplica local del nodo AWS ([docs/02](../../docs/02-arquitectura.md)) para desarrollar el dashboard,
el edge, la API y Ankay. Pensada para Docker Desktop en Windows (WSL2). Operación del nodo
real: [docs/06](../../docs/06-operacion.md).

## Piezas

| Archivo                            | Qué levanta                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose.yaml`                     | PostgreSQL 18.6, Redis y object storage para el API y las pruebas de integración (`pnpm infra:up`, `.env.local`)                                                                            |
| `wazuh-docker` single-node         | Manager, indexer y dashboard oficiales. `scripts/dev/setup-wazuh.ps1` lo clona en `.local/wazuh-docker`                                                                                     |
| `compose.wazuh-dashboard-qapaq.yaml` | Override: imágenes 4.14.8, dashboard QAPAQ (`wazuh-dashboard/Dockerfile`, IP fija `172.30.89.10`) y edge nginx en `https://localhost`                                                         |
| `compose.ankay.yaml`         | Ankay y su puente SSO bajo `https://localhost/ankay/`                                                                                                                           |
| `compose.qapaq-engine.yaml`          | Gateway de token estático para que el API lea `wazuh-alerts-*` (trabajo en curso de otro agente)                                                                                            |
| `edge/`                            | Configuración del edge local, certificados autofirmados y scripts: `apply-indexer-security.sh` (proxy auth), `bootstrap-wazuh-index-patterns.sh`, `setup-ingestion.sh`, `setup-database.sh` |

Diferencias con AWS: el API corre en el host (puerto 3089, `edge/api.local.env`), certificado
autofirmado, sin ALB/WAF ni bloque ACME. Los secretos locales (`*.local.env`, `edge/gateway/`,
`edge/respond-sso/`) están en `.gitignore`.

## Arranque

```powershell
pnpm install
bash infra/local/wazuh-dashboard/build-plugins.sh        # zips de qapaq_ops y qapaq_i18n en plugins-dist/
.\scripts\dev\setup-wazuh.ps1                            # clona wazuh-docker en .local/
$env:QAPAQ_REPO = 'C:/Users/<yo>/Documents/GitHub/qapaq-secops'
# desde .local/wazuh-docker/single-node:
docker compose -f docker-compose.yml -f $env:QAPAQ_REPO/infra/local/compose.wazuh-dashboard-qapaq.yaml up -d --build
bash infra/local/edge/apply-indexer-security.sh
bash infra/local/edge/bootstrap-wazuh-index-patterns.sh
pnpm dev:api                                             # API en el host con edge/api.local.env
```

Ankay: `bash ankay/build.sh <out> qapaq/respond-frontend:2.3.0` y añadir
`-f $env:QAPAQ_REPO/infra/local/compose.ankay.yaml` al `up` (pasos del SSO en la cabecera de
ese archivo).

## Requisitos y problemas conocidos

- Docker host con al menos 4 núcleos, 8 GiB y 50 GiB; en WSL2, `vm.max_map_count` ≥ 262144.
- Docker Desktop colgado: `scripts/dev/repair-docker-desktop.ps1`.
- `host-gateway` añade una IPv6 inalcanzable: el edge usa el alias IPv4 `qapaq-api-host:192.168.65.254`.
- Cambiar la IP del dashboard obliga a reaplicar `apply-indexer-security.sh` (es la única en la que
  confía el indexer).
- `setup-wazuh.ps1` fija `wazuh-docker` **v4.14.7** mientras el override usa imágenes 4.14.8
  (**por verificar** que no haya diferencias en la configuración generada).
- Si Docker no responde, el resultado de `pnpm run test:integration` es `BLOCKED`, no un PASS.
