# Módulo `observability`

Log Analytics Workspace central (logs de plataforma y auditoría) y Container Apps Environment con perfil `Consumption` de Workload Profiles, que solo se crea con `enable_runtime = true`.

El entorno usa Workload Profiles porque la subnet delegada es `/27`; un entorno Consumption-only exige `/23`.

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

| Name                                                                                                                                                | Type     |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [azurerm_container_app_environment.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/container_app_environment) | resource |
| [azurerm_log_analytics_workspace.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/log_analytics_workspace)     | resource |

## Inputs

| Name                     | Description                                                                         | Type          | Default | Required |
| ------------------------ | ----------------------------------------------------------------------------------- | ------------- | ------- | :------: |
| container_apps_subnet_id | Subnet /27 delegada a Microsoft.App/environments.                                   | `string`      | n/a     |   yes    |
| location                 | Región del workspace y del Container Apps Environment.                              | `string`      | n/a     |   yes    |
| name_base                | Base compacta de nombres derivada de project y environment.                         | `string`      | n/a     |   yes    |
| resource_group_name      | Resource group precreado por bootstrap.                                             | `string`      | n/a     |   yes    |
| tags                     | Etiquetas comunes de gobierno y costo.                                              | `map(string)` | n/a     |   yes    |
| enable_runtime           | Crea el Container Apps Environment solo cuando el runtime genérico está habilitado. | `bool`        | `false` |    no    |

## Outputs

| Name                                     | Description                                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| container_app_environment_default_domain | Dominio interno de service discovery de Container Apps; null con enable_runtime = false. |
| container_app_environment_id             | ID del Container Apps Environment; null con enable_runtime = false.                      |
| log_analytics_workspace_id               | Workspace central de logs de plataforma y auditoría.                                     |

<!-- END_TF_DOCS -->
