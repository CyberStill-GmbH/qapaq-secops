# Infraestructura local

`compose.yaml` levanta PostgreSQL, Redis y object storage para QAPAQ. El indexador
y el dashboard no aparecen aquí porque pertenecen al stack oficial Wazuh.

`scripts/dev/setup-wazuh.ps1` fija `wazuh/wazuh-docker` v4.14.7 bajo
`.local/wazuh-docker` y levanta el perfil single-node completo:

- Wazuh Manager;
- Wazuh Indexer basado en OpenSearch;
- Wazuh Dashboard, basado en OpenSearch Dashboards y conectado al Indexer.

Con el stack iniciado en el host Docker, abre el [Dashboard de Wazuh](https://localhost)
(HTTPS, puerto 443). El certificado local puede producir una advertencia del
navegador. La URL solo vale en el host donde corre Docker; el dashboard no está
publicado en AWS. El hostname público solicitado para AWS es
`https://wazuh.qapaq.secops.com`; sigue pendiente desplegar Wazuh y resolver la
zona DNS. Consulta [URLs y permisos requeridos](../../docs/integrations/urls-permisos-microsoft-wazuh.md)
para las APIs y el estado de acceso remoto.

QAPAQ consulta el Wazuh Indexer mediante una credencial de solo lectura que se
creará al implementar C-08/C-10. Las credenciales por defecto del stack oficial no
se copian al repositorio ni se aceptan para un ambiente compartido.

El host Docker necesita al menos 4 cores, 8 GiB y 50 GiB para Wazuh single-node;
el perfil QAPAQ completo conserva la referencia de 12 vCPU, 32 GiB y 200 GiB.
En WSL2, `vm.max_map_count` debe ser al menos 262144 para el Indexer.

## Relación con C-06

Las pruebas reutilizables no dependen de este Compose fijo: `platform/testing`
crea recursos con `runId`, puertos dinámicos y etiquetas de ownership. Usa el
perfil `base` para PostgreSQL, Redis y MinIO; este archivo se conserva para el
entorno local persistente del equipo. OpenSearch de QAPAQ y Wazuh Indexer se
mantienen separados. El perfil `wazuh` usa únicamente el Compose oficial
preparado por `scripts/dev/setup-wazuh.ps1`.

Antes de ejecutar una suite real:

```powershell
docker info
pnpm run test:integration
```

Si Docker no responde, el resultado correcto es `BLOCKED`, no un PASS por mocks.

## Observabilidad local C-15

El overlay opt-in `compose.observability.yaml` inicia Loki, Prometheus,
OpenTelemetry Collector y Grafana OSS para desarrollo local. Publica endpoints solo
en `127.0.0.1`; antes de levantarlo configura `GRAFANA_ADMIN_PASSWORD` en el
entorno o en `.env.local` (archivo ignorado por Git). No reutilices esta
configuración en ambientes compartidos o productivos.

```powershell
docker compose --env-file .env.local -f infra/local/compose.observability.yaml --profile observability up -d --wait loki prometheus otel-collector grafana
pwsh -NoProfile -File scripts/dev/test-observability-stack.ps1
docker compose --env-file .env.local -f infra/local/compose.observability.yaml --profile observability stop grafana otel-collector prometheus loki
```

El smoke envía datos sintéticos por OTLP y verifica su consulta en Loki y
Prometheus, targets del scraper y health de Grafana. Espera el `/ready` de Loki
porque su proceso puede figurar iniciado antes de que el ring de ingesters acepte
datos. El overlay no conecta todavía los productores de API/worker/gateway de
QAPAQ; no enviar credenciales, eventos reales ni PII.
