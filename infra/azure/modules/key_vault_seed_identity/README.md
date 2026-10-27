# Módulo `key_vault_seed_identity`

Solo `demo-eus2`. Identidad OIDC exclusiva del workflow create-only que carga secretos en Key Vault mediante despliegues ARM. Sus dos roles personalizados están fijados al resource group y al Key Vault exactos de EUS2, sin acceso al plano de datos.

<!-- BEGIN_TF_DOCS -->

## Requirements

| Name      | Version            |
| --------- | ------------------ |
| terraform | >= 1.8.0, < 2.0.0  |
| azurerm   | >= 4.81.0, < 5.0.0 |

## Providers

| Name    | Source            |
| ------- | ----------------- |
| azurerm | hashicorp/azurerm |

## Modules

No modules.

## Resources

| Name                                                                                                                                                          | Type     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [azurerm_federated_identity_credential.github](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/federated_identity_credential) | resource |
| [azurerm_role_assignment.group_deployment](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/role_assignment)                   | resource |
| [azurerm_role_assignment.vault_secret_metadata](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/role_assignment)              | resource |
| [azurerm_role_definition.group_deployment](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/role_definition)                   | resource |
| [azurerm_role_definition.vault_secret_metadata](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/role_definition)              | resource |
| [azurerm_user_assigned_identity.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/user_assigned_identity)                 | resource |

## Inputs

| Name                | Description                                                                          | Type          | Default | Required |
| ------------------- | ------------------------------------------------------------------------------------ | ------------- | ------- | :------: |
| key_vault_id        | Exact Key Vault resource scope where ARM secret metadata/write actions are assigned. | `string`      | n/a     |   yes    |
| location            | Identity region; fixed to the EUS2 deployment region.                                | `string`      | n/a     |   yes    |
| name_base           | Deterministic QAPAQ environment prefix from the Azure root.                          | `string`      | n/a     |   yes    |
| resource_group_id   | Exact EUS2 QAPAQ demo resource group scope.                                          | `string`      | n/a     |   yes    |
| resource_group_name | Exact EUS2 QAPAQ demo resource group name.                                           | `string`      | n/a     |   yes    |
| tags                | Resource tags inherited from the Azure root.                                         | `map(string)` | n/a     |   yes    |

## Outputs

| Name      | Description                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| client_id | Client ID for the protected azure-demo-eus2 GitHub Environment variable AZURE_EUS2_SECRET_SEEDER_CLIENT_ID. |

<!-- END_TF_DOCS -->
