# Módulo `identity_registry`

Identidades administradas del runtime y del publicador GitHub, credenciales federadas OIDC con subject basado en IDs inmutables, Azure Container Registry sin usuario admin, asignaciones RBAC de mínimo alcance y auditoría de ACR en Log Analytics.

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

| Name                                                                                                                                                                     | Type     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| [azurerm_container_registry.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/container_registry)                                    | resource |
| [azurerm_federated_identity_credential.github](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/federated_identity_credential)            | resource |
| [azurerm_federated_identity_credential.github_additional](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/federated_identity_credential) | resource |
| [azurerm_monitor_diagnostic_setting.acr_audit](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/monitor_diagnostic_setting)               | resource |
| [azurerm_role_assignment.acr_pull](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/role_assignment)                                      | resource |
| [azurerm_role_assignment.acr_push](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/role_assignment)                                      | resource |
| [azurerm_role_assignment.key_vault_reader](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/role_assignment)                              | resource |
| [azurerm_role_assignment.raw_blob_writer](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/role_assignment)                               | resource |
| [azurerm_role_assignment.siem_artifact_publisher](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/role_assignment)                       | resource |
| [azurerm_role_assignment.siem_release_legacy_publisher](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/role_assignment)                 | resource |
| [azurerm_user_assigned_identity.github_publisher](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/user_assigned_identity)                | resource |
| [azurerm_user_assigned_identity.runtime](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/user_assigned_identity)                         | resource |

## Inputs

| Name                             | Description                                                                                | Type          | Default | Required |
| -------------------------------- | ------------------------------------------------------------------------------------------ | ------------- | ------- | :------: |
| acr_name                         | Nombre global del Azure Container Registry.                                                | `string`      | n/a     |   yes    |
| additional_github_environments   | GitHub Environments extra autorizados para la misma identidad publicadora.                 | `set(string)` | n/a     |   yes    |
| environment                      | Entorno; nombra la credencial federada principal.                                          | `string`      | n/a     |   yes    |
| github_environment               | GitHub Environment principal autorizado para el publicador.                                | `string`      | n/a     |   yes    |
| github_owner_id                  | ID numérico inmutable del owner GitHub usado en el subject OIDC.                           | `string`      | n/a     |   yes    |
| github_repository                | Repositorio GitHub en formato owner/repo.                                                  | `string`      | n/a     |   yes    |
| github_repository_id             | ID numérico inmutable del repositorio GitHub usado en el subject OIDC.                     | `string`      | n/a     |   yes    |
| key_vault_id                     | Key Vault donde el runtime recibe Key Vault Secrets User.                                  | `string`      | n/a     |   yes    |
| legacy_siem_release_container_id | Contenedor de releases heredado; mantiene su asignación para no forzar destroy.            | `string`      | n/a     |   yes    |
| location                         | Región de identidades y ACR.                                                               | `string`      | n/a     |   yes    |
| log_analytics_workspace_id       | Workspace que recibe los eventos de auditoría de ACR.                                      | `string`      | n/a     |   yes    |
| name_base                        | Base compacta de nombres derivada de project y environment.                                | `string`      | n/a     |   yes    |
| raw_container_id                 | Contenedor security-event-raw; único alcance de escritura Blob del runtime.                | `string`      | n/a     |   yes    |
| resource_group_name              | Resource group precreado por bootstrap.                                                    | `string`      | n/a     |   yes    |
| siem_release_container_id        | Contenedor de releases donde el publicador GitHub escribe bundles.                         | `string`      | n/a     |   yes    |
| suffix                           | Sufijo determinista del entorno. Se conserva en la interfaz para nombres globales futuros. | `string`      | n/a     |   yes    |
| tags                             | Etiquetas comunes de gobierno y costo.                                                     | `map(string)` | n/a     |   yes    |

## Outputs

| Name                            | Description                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------- |
| container_registry_id           | ID del ACR; alcance de las asignaciones AcrPull.                                  |
| container_registry_login_server | Login server del ACR.                                                             |
| github_publisher_client_id      | Client ID que GitHub Actions usa por OIDC para AcrPush y publicación de releases. |
| runtime_identity_client_id      | Client ID de la identidad administrada del runtime.                               |
| runtime_identity_id             | ID de la identidad administrada del runtime de Container Apps.                    |

<!-- END_TF_DOCS -->
