variable "resource_group_id" {
  description = "Exact EUS2 QAPAQ demo resource group scope."
  type        = string

  validation {
    condition     = can(regex("/resourcegroups/rg-qapaqsecopsdemoeus-3a2405f3$", lower(var.resource_group_id)))
    error_message = "The seeder identity is restricted to rg-qapaqsecopsdemoeus-3a2405f3."
  }
}

variable "resource_group_name" {
  description = "Exact EUS2 QAPAQ demo resource group name."
  type        = string

  validation {
    condition     = var.resource_group_name == "rg-qapaqsecopsdemoeus-3a2405f3"
    error_message = "The seeder identity is restricted to rg-qapaqsecopsdemoeus-3a2405f3."
  }
}

variable "location" {
  description = "Identity region; fixed to the EUS2 deployment region."
  type        = string

  validation {
    condition     = lower(var.location) == "eastus2"
    error_message = "The secret seeder identity is only valid in East US 2."
  }
}

variable "name_base" {
  description = "Deterministic QAPAQ environment prefix from the Azure root."
  type        = string
}

variable "key_vault_id" {
  description = "Exact Key Vault resource scope where ARM secret metadata/write actions are assigned."
  type        = string

  validation {
    condition     = can(regex("/resourcegroups/rg-qapaqsecopsdemoeus-3a2405f3/providers/microsoft.keyvault/vaults/kv-qapaqsecopsd-3a2405f3$", lower(var.key_vault_id)))
    error_message = "The seeder identity may only target kv-qapaqsecopsd-3a2405f3 in the EUS2 QAPAQ resource group."
  }
}

variable "tags" {
  description = "Resource tags inherited from the Azure root."
  type        = map(string)
}
