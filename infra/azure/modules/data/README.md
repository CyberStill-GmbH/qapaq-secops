# Módulo `data`

Estado persistente del SOC: PostgreSQL Flexible Server privado con las bases `qapaq_secops` y `qapaq_jobs`, Storage de evidencia privado, Storage dedicado a releases SIEM, Key Vault con RBAC, Private Endpoints y diagnostic settings de auditoría.

La contraseña de administrador entra como variable `ephemeral` y se envía con `administrator_password_wo`, así que no se persiste. Todos los recursos con datos tienen `prevent_destroy`.

<!-- BEGIN_TF_DOCS -->

## Requirements

Hereda las restricciones de versión del root (`infra/azure/versions.tf`).

## Providers

| Name    | Source            |
| ------- | ----------------- |
| azurerm | hashicorp/azurerm |

## Modules

No modules.

## Resources

| Name                                                                                                                                                                                                  | Type     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [azurerm_key_vault.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/key_vault)                                                                                   | resource |
| [azurerm_monitor_diagnostic_setting.audit](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/monitor_diagnostic_setting)                                                | resource |
| [azurerm_postgresql_flexible_server.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/postgresql_flexible_server)                                                 | resource |
| [azurerm_postgresql_flexible_server_configuration.require_secure_transport](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/postgresql_flexible_server_configuration) | resource |
| [azurerm_postgresql_flexible_server_configuration.ssl_min_protocol_version](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/postgresql_flexible_server_configuration) | resource |
| [azurerm_postgresql_flexible_server_database.app](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/postgresql_flexible_server_database)                                | resource |
| [azurerm_postgresql_flexible_server_database.queue](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/postgresql_flexible_server_database)                              | resource |
| [azurerm_private_endpoint.blob](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/private_endpoint)                                                                     | resource |
| [azurerm_private_endpoint.key_vault](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/private_endpoint)                                                                | resource |
| [azurerm_private_endpoint.siem_release_blob](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/private_endpoint)                                                        | resource |
| [azurerm_storage_account.evidence](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/storage_account)                                                                   | resource |
| [azurerm_storage_account.siem_release](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/storage_account)                                                               | resource |
| [azurerm_storage_container.raw](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/storage_container)                                                                    | resource |
| [azurerm_storage_container.siem_release](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/storage_container)                                                           | resource |
| [azurerm_storage_container.siem_release_public](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/storage_container)                                                    | resource |

## Inputs

| Name                            | Description                                                                                | Type          | Default | Required |
| ------------------------------- | ------------------------------------------------------------------------------------------ | ------------- | ------- | :------: |
| blob_private_dns_zone_id        | Zona privatelink.blob.core.windows.net.                                                    | `string`      | n/a     |   yes    |
| key_vault_name                  | Nombre global del Key Vault.                                                               | `string`      | n/a     |   yes    |
| key_vault_private_dns_zone_id   | Zona privatelink.vaultcore.azure.net.                                                      | `string`      | n/a     |   yes    |
| location                        | Región Azure de los recursos de datos.                                                     | `string`      | n/a     |   yes    |
| log_analytics_workspace_id      | Workspace que recibe los logs de auditoría de Key Vault, Blob y PostgreSQL.                | `string`      | n/a     |   yes    |
| name_base                       | Base compacta de nombres derivada de project y environment.                                | `string`      | n/a     |   yes    |
| postgres_admin_login            | Login de bootstrap de PostgreSQL.                                                          | `string`      | n/a     |   yes    |
| postgres_admin_password         | Contraseña de bootstrap; se envía como argumento write-only y nunca se persiste. (efímera) | `string`      | n/a     |   yes    |
| postgres_admin_password_version | Versión de la contraseña; incrementarla reenvía el valor a Azure.                          | `number`      | n/a     |   yes    |
| postgres_backup_retention_days  | Días de retención de backups automáticos (7-35).                                           | `number`      | n/a     |   yes    |
| postgres_private_dns_zone_id    | Zona DNS privada de PostgreSQL ya enlazada a la VNet.                                      | `string`      | n/a     |   yes    |
| postgres_sku_name               | SKU de PostgreSQL Flexible Server.                                                         | `string`      | n/a     |   yes    |
| postgres_storage_mb             | Almacenamiento de PostgreSQL en MB.                                                        | `number`      | n/a     |   yes    |
| postgres_subnet_id              | Subnet delegada a Microsoft.DBforPostgreSQL/flexibleServers.                               | `string`      | n/a     |   yes    |
| private_endpoints_subnet_id     | Subnet para Private Endpoints de Key Vault y Blob.                                         | `string`      | n/a     |   yes    |
| release_storage_name            | Nombre global del Storage Account dedicado a bundles de release SIEM.                      | `string`      | n/a     |   yes    |
| resource_group_name             | Resource group precreado por bootstrap donde viven los datos del entorno.                  | `string`      | n/a     |   yes    |
| storage_name                    | Nombre global del Storage Account de evidencia.                                            | `string`      | n/a     |   yes    |
| suffix                          | Sufijo determinista de 8 caracteres que hace únicos los nombres globales.                  | `string`      | n/a     |   yes    |
| tags                            | Etiquetas comunes de gobierno y costo.                                                     | `map(string)` | n/a     |   yes    |
| tenant_id                       | Tenant Entra que autoriza el acceso RBAC al Key Vault.                                     | `string`      | n/a     |   yes    |

## Outputs

| Name                              | Description                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| app_database_name                 | Base de datos de la aplicación SOC.                                                    |
| key_vault_id                      | ID del Key Vault con RBAC y acceso público deshabilitado.                              |
| key_vault_name                    | Nombre del Key Vault.                                                                  |
| key_vault_private_ip              | IP privada del Private Endpoint del Key Vault.                                         |
| key_vault_uri                     | URI del plano de datos del Key Vault.                                                  |
| legacy_siem_release_container_id  | Contenedor siem-release heredado en la cuenta de evidencia; se conserva sin uso nuevo. |
| postgres_fqdn                     | FQDN privado de PostgreSQL Flexible Server.                                            |
| queue_database_name               | Base reservada para estado de jobs; no implica una cola activa.                        |
| raw_container_id                  | ID del contenedor security-event-raw; alcance RBAC de escritura del runtime.           |
| raw_container_name                | Nombre del contenedor de eventos raw.                                                  |
| siem_release_container_id         | ID del contenedor siem-release en la cuenta dedicada de artefactos.                    |
| siem_release_container_name       | Nombre del contenedor de artefactos de release.                                        |
| siem_release_storage_account_id   | ID del Storage Account dedicado a artefactos de release.                               |
| siem_release_storage_account_name | Nombre del Storage Account dedicado a artefactos de release.                           |
| storage_account_id                | ID del Storage Account privado de evidencia.                                           |
| storage_account_name              | Nombre del Storage Account privado de evidencia.                                       |

<!-- END_TF_DOCS -->
