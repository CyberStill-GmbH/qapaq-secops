variable "resource_group_name" {
  description = "Resource group precreado por bootstrap donde viven los datos del entorno."
  type        = string
}

variable "location" {
  description = "Región Azure de los recursos de datos."
  type        = string
}

variable "name_base" {
  description = "Base compacta de nombres derivada de project y environment."
  type        = string
}

variable "suffix" {
  description = "Sufijo determinista de 8 caracteres que hace únicos los nombres globales."
  type        = string
}

variable "storage_name" {
  description = "Nombre global del Storage Account de evidencia."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.storage_name))
    error_message = "Los Storage Accounts admiten 3-24 minúsculas o dígitos."
  }
}

variable "release_storage_name" {
  description = "Nombre global del Storage Account dedicado a bundles de release SIEM."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.release_storage_name))
    error_message = "Los Storage Accounts admiten 3-24 minúsculas o dígitos."
  }
}

variable "key_vault_name" {
  description = "Nombre global del Key Vault."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$", var.key_vault_name))
    error_message = "Key Vault admite 3-24 caracteres alfanuméricos o guiones, empezando con letra."
  }
}

variable "tenant_id" {
  description = "Tenant Entra que autoriza el acceso RBAC al Key Vault."
  type        = string
}

variable "postgres_admin_login" {
  description = "Login de bootstrap de PostgreSQL."
  type        = string
}

variable "postgres_admin_password" {
  description = "Contraseña de bootstrap; se envía como argumento write-only y nunca se persiste."
  type        = string
  sensitive   = true
  ephemeral   = true
  nullable    = false
}

variable "postgres_admin_password_version" {
  description = "Versión de la contraseña; incrementarla reenvía el valor a Azure."
  type        = number
}

variable "postgres_sku_name" {
  description = "SKU de PostgreSQL Flexible Server."
  type        = string
}

variable "postgres_storage_mb" {
  description = "Almacenamiento de PostgreSQL en MB."
  type        = number
}

variable "postgres_backup_retention_days" {
  description = "Días de retención de backups automáticos (7-35)."
  type        = number
}

variable "postgres_subnet_id" {
  description = "Subnet delegada a Microsoft.DBforPostgreSQL/flexibleServers."
  type        = string
}

variable "postgres_private_dns_zone_id" {
  description = "Zona DNS privada de PostgreSQL ya enlazada a la VNet."
  type        = string
}

variable "private_endpoints_subnet_id" {
  description = "Subnet para Private Endpoints de Key Vault y Blob."
  type        = string
}

variable "key_vault_private_dns_zone_id" {
  description = "Zona privatelink.vaultcore.azure.net."
  type        = string
}

variable "blob_private_dns_zone_id" {
  description = "Zona privatelink.blob.core.windows.net."
  type        = string
}

variable "log_analytics_workspace_id" {
  description = "Workspace que recibe los logs de auditoría de Key Vault, Blob y PostgreSQL."
  type        = string
}

variable "tags" {
  description = "Etiquetas comunes de gobierno y costo."
  type        = map(string)
}
