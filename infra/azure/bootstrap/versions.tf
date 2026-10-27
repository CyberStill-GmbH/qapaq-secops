terraform {
  required_version = ">= 1.8.0, < 2.0.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.62"
    }
  }

  # First run uses local state to create the storage backend; migrate that state
  # only after the storage account, container and RBAC exist.
  backend "azurerm" {
    use_azuread_auth = true
  }
}
