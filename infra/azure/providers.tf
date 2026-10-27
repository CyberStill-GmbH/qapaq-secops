provider "azurerm" {
  subscription_id = var.subscription_id
  # Fijar el tenant evita que credenciales OIDC/CLI de otro tenant planifiquen contra este state.
  tenant_id = var.tenant_id
  # Storage con claves compartidas deshabilitadas: el plano de datos usa solo Entra ID.
  storage_use_azuread = true

  features {}
}
