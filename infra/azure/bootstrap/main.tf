locals {
  name_base = substr(replace(lower("${var.project}-${var.environment}"), "-", ""), 0, 18)
  suffix    = substr(sha256("${var.subscription_id}:${var.project}:${var.environment}"), 0, 8)

  target_resource_group_name = "rg-${local.name_base}-${local.suffix}"
  state_resource_group_name  = "rg-${local.name_base}-state-${local.suffix}"
  github_repository_parts    = split("/", var.github_repository)
  github_oidc_subject = format(
    "repo:%s@%s/%s@%s:environment:%s",
    local.github_repository_parts[0],
    var.github_owner_id,
    local.github_repository_parts[1],
    var.github_repository_id,
    var.github_environment,
  )
  delegated_role_definition_ids = [
    "7f951dda-4ed3-4680-a7ca-43fe172d538d", # AcrPull
    "8311e382-0749-4cb8-b61a-304f252e45ec", # AcrPush
    "4633458b-17de-408a-b874-0445c86b69e6", # Key Vault Secrets User
    "ba92f5b4-2d11-453d-a403-e96b0029c9fe", # Storage Blob Data Contributor
  ]
  delegated_role_definition_set = join(", ", local.delegated_role_definition_ids)
}

resource "azurerm_resource_group" "state" {
  name     = local.state_resource_group_name
  location = var.location
  tags     = var.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_account" "state" {
  name                            = var.state_storage_account_name
  resource_group_name             = azurerm_resource_group.state.name
  location                        = azurerm_resource_group.state.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  account_kind                    = "StorageV2"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  public_network_access_enabled   = true
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true
  allow_nested_items_to_be_public = false
  network_rules {
    default_action = "Deny"
    bypass         = ["AzureServices"]
    ip_rules       = var.state_storage_allowed_ipv4
  }
  blob_properties {
    versioning_enabled = true

    delete_retention_policy {
      days = 30
    }

    container_delete_retention_policy {
      days = 30
    }
  }
  tags = var.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container" "state" {
  name                  = var.state_container_name
  storage_account_id    = azurerm_storage_account.state.id
  container_access_type = "private"

  depends_on = [azurerm_role_assignment.operator_state_access]

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_role_assignment" "operator_state_access" {
  scope                = azurerm_storage_account.state.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = var.bootstrap_operator_object_id
  principal_type       = "User"
}

resource "azurerm_resource_group" "demo" {
  name     = local.target_resource_group_name
  location = var.location
  tags     = var.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_user_assigned_identity" "github_terraform" {
  name                = "id-${local.name_base}-github-tf-${local.suffix}"
  location            = var.location
  resource_group_name = azurerm_resource_group.state.name
  tags                = var.tags
}

resource "azurerm_federated_identity_credential" "github_terraform" {
  name                = "github-terraform-${var.environment}"
  resource_group_name = azurerm_resource_group.state.name
  parent_id           = azurerm_user_assigned_identity.github_terraform.id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = "https://token.actions.githubusercontent.com"
  subject             = local.github_oidc_subject
}

resource "azurerm_role_assignment" "demo_contributor" {
  scope                = azurerm_resource_group.demo.id
  role_definition_name = "Contributor"
  principal_id         = azurerm_user_assigned_identity.github_terraform.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "demo_rbac_admin" {
  scope                = azurerm_resource_group.demo.id
  role_definition_name = "Role Based Access Control Administrator"
  principal_id         = azurerm_user_assigned_identity.github_terraform.principal_id
  principal_type       = "ServicePrincipal"

  condition = format(
    "((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {%s} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAllValues:GuidNotEquals {%s})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {%s} AND @Resource[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'} AND @Resource[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAllValues:GuidNotEquals {%s}))",
    local.delegated_role_definition_set,
    azurerm_user_assigned_identity.github_terraform.principal_id,
    local.delegated_role_definition_set,
    azurerm_user_assigned_identity.github_terraform.principal_id,
  )
  condition_version = "2.0"
}

resource "azurerm_role_assignment" "state_blob_writer" {
  scope                = azurerm_storage_account.state.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.github_terraform.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "subscription_budget_writer" {
  scope                = "/subscriptions/${var.subscription_id}"
  role_definition_name = "Cost Management Contributor"
  principal_id         = azurerm_user_assigned_identity.github_terraform.principal_id
  principal_type       = "ServicePrincipal"
}
