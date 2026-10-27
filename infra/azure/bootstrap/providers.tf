provider "azurerm" {
  subscription_id = var.subscription_id
  # Fijar el tenant evita crear la identidad OIDC o el state en un tenant equivocado.
  tenant_id           = var.tenant_id
  storage_use_azuread = true

  features {}
}
