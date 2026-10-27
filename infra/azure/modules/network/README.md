# Módulo `network`

VNet `/16` del entorno, subnets delegadas (Container Apps, PostgreSQL), subnet de Private Endpoints, subnets opcionales (Ankay, KrakenD, AzureFirewallSubnet) y zonas DNS privadas enlazadas para PostgreSQL, Key Vault y Blob.

Los prefijos de subnet se calculan con `cidrsubnet` sobre el `/16`: cambiar `address_space` en un entorno existente reemplaza la red completa.

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

| Name                                                                                                                                                                             | Type     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [azurerm_private_dns_zone.blob](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/private_dns_zone)                                                | resource |
| [azurerm_private_dns_zone.key_vault](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/private_dns_zone)                                           | resource |
| [azurerm_private_dns_zone.postgres](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/private_dns_zone)                                            | resource |
| [azurerm_private_dns_zone_virtual_network_link.blob](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/private_dns_zone_virtual_network_link)      | resource |
| [azurerm_private_dns_zone_virtual_network_link.key_vault](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/private_dns_zone_virtual_network_link) | resource |
| [azurerm_private_dns_zone_virtual_network_link.postgres](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/private_dns_zone_virtual_network_link)  | resource |
| [azurerm_subnet.ankay](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/subnet)                                                                   | resource |
| [azurerm_subnet.container_apps](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/subnet)                                                          | resource |
| [azurerm_subnet.firewall](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/subnet)                                                                | resource |
| [azurerm_subnet.krakend](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/subnet)                                                                 | resource |
| [azurerm_subnet.postgres](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/subnet)                                                                | resource |
| [azurerm_subnet.private_endpoints](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/subnet)                                                       | resource |
| [azurerm_virtual_network.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/virtual_network)                                                  | resource |

## Inputs

| Name                          | Description                                                                                                                        | Type          | Default | Required |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------- | :------: |
| address_space                 | CIDR IPv4 /16 de la VNet; los índices de subnet asumen ese tamaño.                                                                 | `string`      | n/a     |   yes    |
| location                      | Región de la VNet.                                                                                                                 | `string`      | n/a     |   yes    |
| name_base                     | Base compacta de nombres derivada de project y environment.                                                                        | `string`      | n/a     |   yes    |
| resource_group_name           | Resource group precreado por bootstrap.                                                                                            | `string`      | n/a     |   yes    |
| tags                          | Etiquetas comunes de gobierno y costo.                                                                                             | `map(string)` | n/a     |   yes    |
| ankay_subnet_address_prefix   | CIDR de la subnet exclusiva de Ankay; null mantiene el host Ankay deshabilitado. El root reserva el segundo /27 del address space. | `string`      | `null`  |    no    |
| enable_siem_firewall          | Reserva la subnet AzureFirewallSubnet /26 cuando se habilita el host SIEM.                                                         | `bool`        | `false` |    no    |
| krakend_subnet_address_prefix | CIDR dedicado al ACA Environment privado de KrakenD; null lo mantiene apagado. Workload Profiles requiere al menos /27.            | `string`      | `null`  |    no    |

## Outputs

| Name                          | Description                                                                |
| ----------------------------- | -------------------------------------------------------------------------- |
| ankay_subnet_id               | Subnet de Ankay; null si el host está deshabilitado.                       |
| blob_private_dns_zone_id      | Zona privatelink.blob.core.windows.net.                                    |
| container_apps_subnet_id      | Subnet /27 delegada a Microsoft.App/environments para el runtime genérico. |
| firewall_subnet_id            | AzureFirewallSubnet; null si el host SIEM está deshabilitado.              |
| key_vault_private_dns_zone_id | Zona privatelink.vaultcore.azure.net.                                      |
| krakend_subnet_id             | Subnet del ACA privado de KrakenD; null si está deshabilitado.             |
| postgres_private_dns_zone_id  | Zona DNS privada de PostgreSQL.                                            |
| postgres_subnet_id            | Subnet delegada a PostgreSQL Flexible Server.                              |
| private_endpoints_subnet_id   | Subnet de Private Endpoints (Key Vault y Blob).                            |
| virtual_network_id            | ID de la VNet del entorno.                                                 |
| virtual_network_name          | Nombre de la VNet del entorno.                                             |

<!-- END_TF_DOCS -->
