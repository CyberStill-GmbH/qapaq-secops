mock_provider "azurerm" {
  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      client_id    = "00000000-0000-4000-8000-000000000001"
      principal_id = "00000000-0000-4000-8000-000000000002"
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-qapaqsecopsdemoeus-3a2405f3/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-qapaqsecopsdemoeus-kv-seeder"
    }
  }
}

variables {
  resource_group_id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-qapaqsecopsdemoeus-3a2405f3"
  resource_group_name = "rg-qapaqsecopsdemoeus-3a2405f3"
  location            = "eastus2"
  name_base           = "qapaqsecopsdemoeus"
  key_vault_id        = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-qapaqsecopsdemoeus-3a2405f3/providers/Microsoft.KeyVault/vaults/kv-qapaqsecopsd-3a2405f3"
  tags                = { project = "qapaq-secops", environment = "demo-eus2" }
}

run "seeder_identity_is_environment_bound_and_minimum_scope" {
  command = apply

  assert {
    condition = (
      azurerm_federated_identity_credential.github.issuer == "https://token.actions.githubusercontent.com" &&
      azurerm_federated_identity_credential.github.subject == "repo:CyberStill-GmbH/qapaq-secops:environment:azure-demo-eus2" &&
      toset(azurerm_federated_identity_credential.github.audience) == toset(["api://AzureADTokenExchange"])
    )
    error_message = "The seeder must trust only the exact protected EUS2 GitHub Environment OIDC subject."
  }

  assert {
    condition = (
      length(azurerm_role_definition.group_deployment.assignable_scopes) == 1 &&
      contains(azurerm_role_definition.group_deployment.assignable_scopes, var.resource_group_id) &&
      length(azurerm_role_definition.group_deployment.permissions[0].actions) == 6 &&
      alltrue([
        for action in [
          "Microsoft.Resources/deployments/validate/action",
          "Microsoft.Resources/deployments/write",
          "Microsoft.Resources/deployments/read",
          "Microsoft.Resources/deployments/operations/read",
          "Microsoft.Resources/deployments/operationStatuses/read",
          "Microsoft.Resources/subscriptions/resourceGroups/read",
        ] : contains(azurerm_role_definition.group_deployment.permissions[0].actions, action)
      ]) &&
      length(azurerm_role_definition.group_deployment.permissions[0].data_actions) == 0
    )
    error_message = "The seeder deployment role must contain only the documented ARM deployment actions at the target resource group."
  }

  assert {
    condition = (
      azurerm_role_assignment.group_deployment.scope == var.resource_group_id &&
      length(azurerm_role_definition.vault_secret_metadata.assignable_scopes) == 1 &&
      contains(azurerm_role_definition.vault_secret_metadata.assignable_scopes, var.resource_group_id) &&
      azurerm_role_assignment.vault_secret_metadata.scope == var.key_vault_id &&
      length(azurerm_role_definition.vault_secret_metadata.permissions[0].actions) == 3 &&
      alltrue([
        for action in [
          "Microsoft.KeyVault/vaults/read",
          "Microsoft.KeyVault/vaults/secrets/read",
          "Microsoft.KeyVault/vaults/secrets/write",
        ] : contains(azurerm_role_definition.vault_secret_metadata.permissions[0].actions, action)
      ]) &&
      length(azurerm_role_definition.vault_secret_metadata.permissions[0].data_actions) == 0
    )
    error_message = "Vault actions must be scoped to the exact EUS2 vault and exclude data-plane secret access."
  }

  assert {
    condition     = output.client_id == "00000000-0000-4000-8000-000000000001"
    error_message = "The module may expose only the managed identity client ID needed by GitHub Actions."
  }
}

run "rejects_a_different_vault" {
  command = plan

  variables {
    key_vault_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-qapaqsecopsdemoeus-3a2405f3/providers/Microsoft.KeyVault/vaults/other-vault"
  }

  expect_failures = [var.key_vault_id]
}
