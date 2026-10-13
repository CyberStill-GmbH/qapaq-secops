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
navegador. La URL solo vale en el host donde corre Docker; el dashboard de AWS
se publicará con una IP elástica y HTTPS de Let's Encrypt. Después del apply,
Terraform mostrará `wazuh_dashboard_url`; el primer arranque tarda varios minutos.
Consulta [URLs y permisos requeridos](../../docs/integrations/urls-permisos-microsoft-wazuh.md)
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

## Observabilidad

No hay stack local de Grafana/Loki/Prometheus: la plataforma usa CloudWatch para la
infraestructura AWS y el propio Wazuh Indexer/Dashboard para la telemetría de seguridad
(ver `docs/06-operacion.md`).
