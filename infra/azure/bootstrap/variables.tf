variable "subscription_id" {
  description = "Azure subscription for the isolated QAPAQ demo."
  type        = string
}

variable "tenant_id" {
  description = "Microsoft Entra tenant that owns the GitHub federated identity."
  type        = string
}

variable "location" {
  description = "Bootstrap and demo resource region."
  type        = string
  default     = "chilecentral"
}

variable "project" {
  description = "Must match infra/azure so the same target resource-group name is derived."
  type        = string
  default     = "qapaq-secops"
}

variable "environment" {
  description = "Must match infra/azure."
  type        = string
  default     = "demo"
}

variable "github_repository" {
  description = "GitHub repository allowed to request the Azure OIDC token."
  type        = string
  default     = "CyberStill-GmbH/qapaq-secops"
}

variable "github_owner_id" {
  description = "Immutable GitHub owner ID included in the repository OIDC subject."
  type        = string
  default     = "220633794"

  validation {
    condition     = can(regex("^[0-9]+$", var.github_owner_id))
    error_message = "GitHub owner ID must be numeric."
  }
}

variable "github_repository_id" {
  description = "Immutable GitHub repository ID included in the OIDC subject."
  type        = string
  default     = "1374673243"

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "GitHub repository ID must be numeric."
  }
}

variable "github_environment" {
  description = "GitHub environment in the OIDC subject. Must remain approval-protected and main-only."
  type        = string
  default     = "azure-demo"
}

variable "github_additional_environment" {
  description = "Optional second GitHub environment allowed to use the existing federated identity."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.github_additional_environment == null || can(regex(
      "^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$",
      var.github_additional_environment,
    ))
    error_message = "The optional additional GitHub environment must be 1-80 letters, digits, underscores, or hyphens and start with a letter or digit."
  }
}

variable "state_storage_account_name" {
  description = "Globally unique Azure Storage Account name for Terraform state. Lowercase letters and digits only, 3-24 chars."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.state_storage_account_name))
    error_message = "Storage Account names must contain 3-24 lowercase letters or digits."
  }
}

variable "state_container_name" {
  description = "Private blob container for Terraform state."
  type        = string
  default     = "tfstate"

  validation {
    condition     = can(regex("^[a-z0-9-]{3,63}$", var.state_container_name))
    error_message = "State container names must contain 3-63 lowercase letters, digits, or hyphens."
  }
}

variable "state_key" {
  description = "Blob path for the Azure demo root state."
  type        = string
  default     = "qapaq-secops/demo/terraform.tfstate"
}

variable "tags" {
  description = "Governance labels for bootstrap resources."
  type        = map(string)
  default = {
    project     = "qapaq-secops"
    environment = "demo"
    managed_by  = "terraform-bootstrap"
    cloud       = "azure"
    data_class  = "infrastructure-state"
  }
}
