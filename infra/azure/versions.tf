terraform {
  # 1.11 es el mínimo para variables `ephemeral` y argumentos write-only; CI fija 1.16.5.
  required_version = ">= 1.11.0, < 2.0.0"

  required_providers {
    azurerm = {
      source = "hashicorp/azurerm"
      # 4.81 es la versión del lock y el mínimo que exige `modules/key_vault_seed_identity`.
      version = "~> 4.81"
    }
  }

  # Cada workflow inyecta resource_group_name, storage_account_name, container_name y key
  # con -backend-config porque cada entorno tiene su propio state. El backend azurerm
  # bloquea el state con un lease del blob; no requiere tabla ni recurso adicional.
  backend "azurerm" {
    use_azuread_auth = true
  }
}
