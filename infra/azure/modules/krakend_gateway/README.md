# KrakenD privado para ingesta Wazuh

Módulo opt-in para el contrato Azure QAPAQ Core → KrakenD → proxy TLS de Indexer. El root lo deja apagado (`krakend_gateway = null`) hasta tener imagen por digest y referencias de secretos preexistentes. No crea ni cambia DNS público.

## Contrato de red y API

- Despliega un Azure Container Apps Environment con internal load balancer, `public_network_access = Disabled`, subnet dedicada `/27` o mayor y DNS privado del dominio administrado de ACA.
- La app permite ingress externo **solo dentro del VNet**: Core corre en la VM SIEM, fuera del environment ACA. Solo publica HTTPS `GET /wazuh/_cluster/health` y `POST /wazuh/_search`; ambas rutas requieren token Entra RS256 validado por issuer, JWKS y audience.
- KrakenD reescribe la búsqueda a `POST /wazuh-alerts-*/_search` en el proxy TLS del SIEM. El NSG del SIEM permite TCP/9200 únicamente desde la subnet ACA cuando se habilita este módulo. Nginx debe conservar su allowlist exacta; el Indexer continúa escuchando en loopback.
- El módulo no define `/api/*`, el host del Core, ni `127.0.0.1`. El root inyecta al servicio Core su URL HTTPS privada, scope y `QAPAQ_INGESTION_SOURCE=wazuh`; su cliente usa `EntraClientCredentialsTokenSource` existente.
- El issuer predeterminado usa el claim v1 que fija el entorno QAPAQ existente (`https://sts.windows.net/<tenant>/`); JWKS se resuelve desde el endpoint Microsoft v2. Revisar issuer y audience con un token sintético de la app antes de habilitar.

## Gate de habilitación

Terraform no lee ni crea los valores de Key Vault. Antes del plan deben existir:

1. Un digest OCI inmutable de `qapaq-secops-krakend` publicado en el ACR EUS2 aprobado.
2. Un secreto Key Vault indicado por `indexer_reader_secret_name`, cuyo valor sea **solo** el texto Base64 de `qapaq_reader:<password>` (no JSON). Se inyecta en `WAZUH_BASIC_AUTH_B64`.
3. Un secreto Key Vault indicado por `indexer_proxy_ca_secret_name`, cuyo valor sea el certificado CA/PEM que valida el TLS del proxy Indexer.
4. Una aplicación Entra de QAPAQ Core que permita client credentials, `QAPAQ_ENTRA_CLIENT_SECRET` ya referenciado para el Core, y `api://<client-id>/.default` consistente con tenant/client configurados.
5. Un proxy Indexer operativo en la VM: solo `GET /_cluster/health` y `POST /wazuh-alerts-*/_search`, TLS verificado y usuario de solo lectura. **Actualmente** `wazuh/access/apply-access.sh` publica en AWS Secrets Manager y el bootstrap `siem_host` no instala ese proxy; esa ruta de aprovisionamiento Azure y seed de KV es un gate externo. No habilitar este módulo hasta cerrar ese gate. No se amplían los permisos KV de escritura de la identidad runtime para simularlo.

La identidad asignada a KrakenD obtiene `AcrPull` sobre el ACR y `Key Vault Secrets User` sobre esos dos secretos exactos. Ningún valor secreto entra en Terraform, outputs, Git o logs.

## Escala, costo y límites

- 2 réplicas mínimas, 4 máximas; cada una reserva 0.5 vCPU y 1 GiB. El piso configurado es 1 vCPU y 2 GiB de capacidad de aplicación; el máximo es 2 vCPU y 4 GiB. Dos réplicas mínimas impiden scale-to-zero.
- El gasto final depende de región, consumo activo/idle, egress, Firewall ya requerido por el host SIEM y retención/ingesta de Log Analytics. No es un precio fijo ni un límite mensual; no hay apagado automático. Cotizar el perfil en Azure Pricing Calculator antes de un plan remoto.
- Sin zone redundancy y sin garantía HA regional. Esto mejora la disponibilidad de la app frente a una réplica, pero no vuelve HA el SIEM single-node, PostgreSQL, Firewall, DNS ni el VNet.
- La UDR de la subnet ACA fuerza egress a Azure Firewall. La policy agrega allowlists de plataforma/ACR/Entra/Key Vault limitadas al CIDR de ACA y las service tags documentadas por Microsoft. Verificar resolución DNS privada y rutas de Managed Identity en un plan/aplicación aislados.

## Verificación previa a uso

CI valida el contrato de rutas, la configuración de KrakenD y el módulo Terraform sin credenciales cloud. Eso no prueba la red efectiva, la existencia de los secretos, la validez del token, ni el estado del Indexer. Después de un apply autorizado, comprobar desde Core: resolución DNS privada; TLS válido; `GET /wazuh/_cluster/health` 200; `POST /wazuh/_search` 200; rutas no permitidas 403; sin acceso público; y polling con eventos sintéticos en QAPAQ. Revisar redacción de logs, métricas y costo antes de declarar la fuente operativa.
