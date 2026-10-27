locals {
  github_subject  = "repo:CyberStill-GmbH/qapaq-secops:environment:azure-demo-eus2"
  github_issuer   = "https://token.actions.githubusercontent.com"
  github_audience = "api://AzureADTokenExchange"
  deployment_role_id = uuidv5(
    "url",
    "qapaq-secops:demo-eus2:secret-seeder:group-deployment",
  )
  vault_role_id = uuidv5(
    "url",
    "qapaq-secops:demo-eus2:secret-seeder:vault-secrets",
  )
}

resource "azurerm_user_assigned_identity" "this" {
  name                = "id-${var.name_base}-kv-seeder"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = merge(var.tags, { purpose = "eus2-key-vault-secret-seeding" })
}

resource "azurerm_federated_identity_credential" "github" {
  name                      = "github-azure-demo-eus2-kv-seeder"
  user_assigned_identity_id = azurerm_user_assigned_identity.this.id
  issuer                    = local.github_issuer
  subject                   = local.github_subject
  audience                  = [local.github_audience]
}

# Group deployments are required by `az deployment group create`. This custom role
# grants only deployment lifecycle/metadata actions and resource-group metadata read.
resource "azurerm_role_definition" "group_deployment" {
  role_definition_id = local.deployment_role_id
  name               = "QAPAQ EUS2 Secret Seeder Deployment"
  scope              = var.resource_group_id
  description        = "Create and inspect ARM deployments in the EUS2 QAPAQ resource group for the protected create-only Key Vault seeder workflow."

  permissions {
    actions = [
      "Microsoft.Resources/deployments/validate/action",
      "Microsoft.Resources/deployments/write",
      "Microsoft.Resources/deployments/read",
      "Microsoft.Resources/deployments/operations/read",
      "Microsoft.Resources/deployments/operationStatuses/read",
      "Microsoft.Resources/subscriptions/resourceGroups/read",
    ]
    not_actions      = []
    data_actions     = []
    not_data_actions = []
  }

  assignable_scopes = [var.resource_group_id]
}

# Assign the Key Vault control-plane actions at the exact vault scope. Do not add
# dataActions/getSecret: this identity can create/read ARM metadata, never fetch values.
resource "azurerm_role_definition" "vault_secret_metadata" {
  role_definition_id = local.vault_role_id
  name               = "QAPAQ EUS2 Secret Seeder Vault"
  scope              = var.resource_group_id
  description        = "Read Key Vault metadata and create/read ARM secret resources in the single EUS2 QAPAQ vault. No data-plane access."

  permissions {
    actions = [
      "Microsoft.KeyVault/vaults/read",
      "Microsoft.KeyVault/vaults/secrets/read",
      "Microsoft.KeyVault/vaults/secrets/write",
    ]
    not_actions      = []
    data_actions     = []
    not_data_actions = []
  }

  assignable_scopes = [var.resource_group_id]
}

resource "azurerm_role_assignment" "group_deployment" {
  scope              = var.resource_group_id
  role_definition_id = azurerm_role_definition.group_deployment.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.this.principal_id
  principal_type     = "ServicePrincipal"

  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "vault_secret_metadata" {
  scope              = var.key_vault_id
  role_definition_id = azurerm_role_definition.vault_secret_metadata.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.this.principal_id
  principal_type     = "ServicePrincipal"

  skip_service_principal_aad_check = true
}
