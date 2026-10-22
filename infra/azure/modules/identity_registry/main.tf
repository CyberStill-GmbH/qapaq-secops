resource "azurerm_user_assigned_identity" "runtime" {
  name                = "id-${var.name_base}-runtime"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags
}


resource "azurerm_user_assigned_identity" "github_publisher" {
  name                = "id-${var.name_base}-github-publisher"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags
}


resource "azurerm_federated_identity_credential" "github" {
  name                = "github-${var.environment}"
  resource_group_name = var.resource_group_name
  parent_id           = azurerm_user_assigned_identity.github_publisher.id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = "https://token.actions.githubusercontent.com"
  subject = format(
    "repo:%s@%s/%s@%s:environment:%s",
    split("/", var.github_repository)[0],
    var.github_owner_id,
    split("/", var.github_repository)[1],
    var.github_repository_id,
    var.github_environment,
  )
}


resource "azurerm_container_registry" "this" {
  name                          = var.acr_name
  resource_group_name           = var.resource_group_name
  location                      = var.location
  sku                           = "Basic"
  admin_enabled                 = false
  public_network_access_enabled = true
  anonymous_pull_enabled        = false
  zone_redundancy_enabled       = false
  tags                          = var.tags
}


resource "azurerm_role_assignment" "acr_pull" {
  scope                = azurerm_container_registry.this.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.runtime.principal_id
  principal_type       = "ServicePrincipal"
}


resource "azurerm_role_assignment" "acr_push" {
  scope                = azurerm_container_registry.this.id
  role_definition_name = "AcrPush"
  principal_id         = azurerm_user_assigned_identity.github_publisher.principal_id
  principal_type       = "ServicePrincipal"
}


resource "azurerm_role_assignment" "key_vault_reader" {
  scope                = var.key_vault_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.runtime.principal_id
  principal_type       = "ServicePrincipal"
}


resource "azurerm_role_assignment" "raw_blob_writer" {
  scope                = var.raw_container_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.runtime.principal_id
  principal_type       = "ServicePrincipal"
}
