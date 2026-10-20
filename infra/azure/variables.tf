variable "subscription_id" {
  description = "ID de la suscripción Azure destino; no se fija una suscripción por defecto."
  type        = string
}

variable "tenant_id" {
  description = "Tenant Entra que autentica las identidades administradas y GitHub OIDC."
  type        = string
}

variable "location" {
  description = "Región Azure con menor latencia geográfica estimada desde Perú; verificar SKU/cuotas y residencia antes del apply."
  type        = string
  default     = "chilecentral"
}

variable "project" {
  description = "Prefijo lógico de recursos Azure."
  type        = string
  default     = "qapaq-secops"
}

variable "environment" {
  description = "Nombre aislado del entorno Azure."
  type        = string
  default     = "demo"
}

variable "address_space" {
  description = "Address space VNet."
  type        = string
  default     = "10.80.0.0/16"
}

variable "github_repository" {
  description = "Repositorio autorizado para publicar imágenes por federación OIDC."
  type        = string
  default     = "CyberStill-GmbH/qapaq-secops"
}

variable "github_environment" {
  description = "GitHub Environment que restringe el subject OIDC del publicador Azure."
  type        = string
  default     = "azure-demo"
}

variable "postgres_admin_login" {
  description = "Login de bootstrap PostgreSQL; no se usa desde API ni workers."
  type        = string
  default     = "qapaqbootstrap"
}

variable "postgres_admin_password" {
  description = "Contraseña de bootstrap. Inyectar desde un gestor seguro al plan/apply; Terraform state la conserva."
  type        = string
  sensitive   = true
  nullable    = false
}

variable "postgres_sku_name" {
  description = "SKU de PostgreSQL Flexible Server. Debe aprobarse con el presupuesto y pruebas de carga."
  type        = string
  default     = "B_Standard_B2s"
}

variable "postgres_storage_mb" {
  description = "Almacenamiento inicial PostgreSQL."
  type        = number
  default     = 32768
}

variable "postgres_backup_retention_days" {
  description = "Retención de backups automáticos de PostgreSQL."
  type        = number
  default     = 14

  validation {
    condition     = var.postgres_backup_retention_days >= 7 && var.postgres_backup_retention_days <= 35
    error_message = "PostgreSQL Flexible Server admite entre 7 y 35 días de retención."
  }
}

variable "container_images" {
  description = "Digests OCI verificados desde ACR para edge, web, gateway, api y worker. Deben fijarse antes de habilitar el runtime."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for image in values(var.container_images) : can(regex("^[^@]+@sha256:[0-9a-f]{64}$", image))
    ])
    error_message = "Cada imagen debe fijarse a un digest OCI sha256 completo; no se permiten tags flotantes."
  }
}

variable "enable_runtime" {
  description = "Crea Container Apps solo al contar con cinco digests verificados y compatibilidad de runtime aprobada."
  type        = bool
  default     = false
}

variable "key_vault_secret_ids" {
  description = "Secretos precreados en Key Vault, por servicio y nombre lógico. Nunca se aceptan valores secretos en tfvars."
  type        = map(map(string))
  default     = {}
}

variable "tags" {
  description = "Etiquetas comunes de gobierno y costo."
  type        = map(string)
  default = {
    project     = "qapaq-secops"
    environment = "demo"
    managed_by  = "terraform"
    cloud       = "azure"
    data_class  = "security-sensitive"
  }
}

variable "cost_budget_amount" {
  description = "Presupuesto mensual de alerta a nivel suscripción, en la moneda de facturación de Azure. No apaga recursos."
  type        = number
  default     = 200

  validation {
    condition     = var.cost_budget_amount > 0
    error_message = "El presupuesto mensual debe ser mayor que cero."
  }
}

variable "cost_alert_emails" {
  description = "Destinatarios autorizados para avisos de presupuesto Azure."
  type        = list(string)
  default     = ["cguevara@qapaq.pe"]

  validation {
    condition     = length(var.cost_alert_emails) > 0 && alltrue([for email in var.cost_alert_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", email))])
    error_message = "Define al menos un correo válido para recibir alertas de costo."
  }
}

variable "cost_budget_start_date" {
  description = "Inicio UTC del período de evaluación del presupuesto mensual."
  type        = string
  default     = "2026-10-01T00:00:00Z"
}

variable "cost_budget_end_date" {
  description = "Fin UTC del presupuesto; renovar antes de esta fecha si el entorno continúa."
  type        = string
  default     = "2030-10-01T00:00:00Z"
}
