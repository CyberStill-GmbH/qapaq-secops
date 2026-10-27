# KrakenD privado para ingesta Wazuh

Módulo opt-in para el contrato Azure QAPAQ Core → KrakenD → proxy TLS de Indexer. El root lo deja apagado (`krakend_gateway = null`) hasta tener imagen por digest y referencias de secretos preexistentes. No crea ni cambia DNS público.

## Contrato de red y API

- Despliega un Azure Container Apps Environment con internal load balancer, `public_network_access = Disabled`, subnet dedicada `/27` o mayor y DNS privado del dominio administrado de ACA.
- La app permite ingress externo **solo dentro del VNet**: Core corre en la VM SIEM, fuera del environment ACA. Solo publica HTTPS `GET /wazuh/_cluster/health` y `POST /wazuh/_search`; ambas rutas requieren token Entra RS256 validado por issuer/JWKS/audience, el app role de aplicación `Qapaq.Wazuh.Read` y `appid` (token v1) o `azp` (token v2) coincidente con `core_client_id`.
- KrakenD reescribe la búsqueda a `POST /wazuh-alerts-*/_search` en el proxy TLS del SIEM. El NSG del SIEM permite TCP/9200 únicamente desde la subnet ACA cuando se habilita este módulo. Nginx debe conservar su allowlist exacta; el Indexer continúa escuchando en loopback.
- El módulo no define `/api/*`, el host del Core, ni `127.0.0.1`. El root inyecta al servicio Core su URL HTTPS privada, scope y `QAPAQ_INGESTION_SOURCE=wazuh`; su cliente usa `EntraClientCredentialsTokenSource` existente.
- `client_scope` define la aplicación recurso/audience; `core_client_id` identifica al único caller autorizado. No se infiere uno del otro. Terraform exige que `core_client_id` coincida con `QAPAQ_ENTRA_CLIENT_ID` configurado en Core.
- El issuer predeterminado usa el claim v1 que fija el entorno QAPAQ existente (`https://sts.windows.net/<tenant>/`); JWKS se resuelve desde el endpoint Microsoft v2. Revisar issuer, audience, `roles`, `appid`/`azp` con tokens sintéticos antes de habilitar.

## Gate de habilitación

Terraform no lee ni crea los valores de Key Vault. Antes del plan deben existir:

1. Un digest OCI inmutable de `qapaq-secops-krakend` publicado en el ACR EUS2 aprobado.
2. Un secreto Key Vault indicado por `indexer_reader_secret_name`, cuyo valor sea **solo** el texto Base64 de `qapaq_reader:<password>` (no JSON). Se inyecta en `WAZUH_BASIC_AUTH_B64`.
3. Un secreto Key Vault indicado por `indexer_proxy_ca_secret_name`, cuyo valor sea el certificado CA/PEM que valida el TLS del proxy Indexer.
4. Una aplicación recurso Entra cuya audience sea `api://<resource-client-id>`, con app role `Qapaq.Wazuh.Read` cuyo `allowedMemberTypes` sea solo `Application`. Asignar ese rol exclusivamente al service principal QAPAQ Core definido por `core_client_id`. El Core usa client credentials, su `QAPAQ_ENTRA_CLIENT_SECRET` ya referenciado y scope `api://<resource-client-id>/.default`. Terraform valida el caller permitido pero no crea el app role ni su asignación: son un gate Entra previo.
5. Un proxy Indexer operativo en la VM: solo `GET /_cluster/health` y `POST /wazuh-alerts-*/_search`, TLS verificado y usuario de solo lectura. **Actualmente** `wazuh/access/apply-access.sh` publica en AWS Secrets Manager y el bootstrap `siem_host` no instala ese proxy; esa ruta de aprovisionamiento Azure y seed de KV es un gate externo. No habilitar este módulo hasta cerrar ese gate. No se amplían los permisos KV de escritura de la identidad runtime para simularlo.

La identidad asignada a KrakenD obtiene `AcrPull` sobre el ACR y `Key Vault Secrets User` sobre esos dos secretos exactos. Ningún valor secreto entra en Terraform, outputs, Git o logs.

## Logs de acceso

El access log permanece desactivado. KrakenD Community Edition usa el logger Gin predeterminado, que agrega el query string a la ruta, y no permite configurar un formato seguro que lo omita. Activarlo podría escribir datos de query sensibles en stdout. Se mantienen logs de aplicación en INFO y métricas de ruta/estado/latencia sin query, token, body ni headers. Para access logs de auditoría se requiere primero un middleware sanitizador probado o una edición que permita declarar un formato allowlist; no habilitar el logger predeterminado.

## Escala, costo y límites

- 2 réplicas mínimas, 4 máximas; cada una reserva 0.5 vCPU y 1 GiB. El piso configurado es 1 vCPU y 2 GiB de capacidad de aplicación; el máximo es 2 vCPU y 4 GiB. Dos réplicas mínimas impiden scale-to-zero.
- El gasto final depende de región, consumo activo/idle, egress, Firewall ya requerido por el host SIEM y retención/ingesta de Log Analytics. No es un precio fijo ni un límite mensual; no hay apagado automático. Cotizar el perfil en Azure Pricing Calculator antes de un plan remoto.
- Sin zone redundancy y sin garantía HA regional. Esto mejora la disponibilidad de la app frente a una réplica, pero no vuelve HA el SIEM single-node, PostgreSQL, Firewall, DNS ni el VNet.
- La UDR de la subnet ACA fuerza egress a Azure Firewall. La policy agrega allowlists de plataforma/ACR/Entra/Key Vault limitadas al CIDR de ACA y las service tags documentadas por Microsoft. Verificar resolución DNS privada y rutas de Managed Identity en un plan/aplicación aislados.

## Verificación previa a uso

CI valida el contrato de rutas, la configuración de KrakenD y el módulo Terraform sin credenciales cloud. Eso no prueba la red efectiva, la existencia de los secretos, la validez del token, ni el estado del Indexer. Después de un apply autorizado, comprobar desde Core: resolución DNS privada; TLS válido; `GET /wazuh/_cluster/health` 200; `POST /wazuh/_search` 200; rutas no permitidas 403; sin acceso público; y polling con eventos sintéticos en QAPAQ. Revisar redacción de logs, métricas y costo antes de declarar la fuente operativa.

<!-- BEGIN_TF_DOCS -->

## Requirements

| Name      | Version           |
| --------- | ----------------- |
| terraform | >= 1.8.0, < 2.0.0 |
| azurerm   | ~> 4.62           |

## Providers

| Name    | Source            |
| ------- | ----------------- |
| azurerm | hashicorp/azurerm |

## Modules

No modules.

## Resources

| Name                                                                                                                                                                        | Type     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [azurerm_container_app.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/container_app)                                                 | resource |
| [azurerm_container_app_environment.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/container_app_environment)                         | resource |
| [azurerm_private_dns_a_record.wildcard](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/private_dns_a_record)                               | resource |
| [azurerm_private_dns_zone.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/private_dns_zone)                                           | resource |
| [azurerm_private_dns_zone_virtual_network_link.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/private_dns_zone_virtual_network_link) | resource |
| [azurerm_role_assignment.acr_pull](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/role_assignment)                                         | resource |
| [azurerm_role_assignment.key_vault_secret_read](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/role_assignment)                            | resource |
| [azurerm_route_table.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/route_table)                                                     | resource |
| [azurerm_subnet_route_table_association.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/subnet_route_table_association)               | resource |
| [azurerm_user_assigned_identity.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/user_assigned_identity)                               | resource |

## Inputs

| Name                         | Description                                                                                        | Type     | Default | Required |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | -------- | ------- | :------: |
| client_scope                 | Scope OAuth client-credentials de la API recurso, p. ej. api://<api-client-id>/.default.           | `string` | n/a     |   yes    |
| core_client_id               | Client ID de la única aplicación QAPAQ Core autorizada a consumir el gateway.                      | `string` | n/a     |   yes    |
| firewall_private_ip          | IP privada de Azure Firewall para la UDR de salida del entorno ACA.                                | `string` | n/a     |   yes    |
| image                        | Imagen QAPAQ KrakenD en el ACR del entorno, fijada a digest inmutable.                             | `string` | n/a     |   yes    |
| indexer_proxy_ca_secret_name | Nombre en Key Vault de la CA del proxy TLS privado del Indexer.                                    | `string` | n/a     |   yes    |
| indexer_reader_secret_name   | Nombre en Key Vault del JSON de identidad read-only de Wazuh; KrakenD consume solo basic_auth_b64. | `string` | n/a     |   yes    |
| siem_indexer_proxy_ip        | IP privada estable del proxy TLS read-only en SIEM, fuera de la subnet ACA.                        | `string` | n/a     |   yes    |
| subnet_cidr                  | CIDR de la subnet ACA exclusiva; debe ser /27 o mayor y no compartir dirección con SIEM.           | `string` | n/a     |   yes    |
| tenant_id                    | Tenant Entra que emite los tokens de workload del QAPAQ Core.                                      | `string` | n/a     |   yes    |

## Outputs

| Name                          | Description                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| environment_static_ip         | IP privada del Internal Load Balancer administrado por ACA.                                      |
| gateway_base_url              | URL HTTPS que consume qapaq-core desde la VM SIEM; no apunta a loopback.                         |
| gateway_fqdn                  | FQDN HTTPS privado de KrakenD dentro de la VNet.                                                 |
| managed_identity_principal_id | Identidad del runtime con AcrPull y acceso read-only a los dos secretos Key Vault referenciados. |

<!-- END_TF_DOCS -->
