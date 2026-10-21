terraform {
  required_version = ">= 1.8.0, < 2.0.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.62"
    }
  }

  # El backend azurerm se configura por init -backend-config. Crear y proteger
  # primero el storage de estado fuera de este stack.
  backend "azurerm" {}
}

provider "azurerm" {
  subscription_id     = var.subscription_id
  storage_use_azuread = true
  features {}
}
