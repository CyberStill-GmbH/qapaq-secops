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

  validation {
    condition     = can(cidrnetmask(var.address_space)) && can(regex("/16$", var.address_space))
    error_message = "address_space debe ser un CIDR IPv4 /16; los índices de subnet del módulo están calculados para ese tamaño."
  }
}

variable "github_repository" {
  description = "Repositorio autorizado para publicar imágenes por federación OIDC."
  type        = string
  default     = "CyberStill-GmbH/qapaq-secops"
}

variable "github_owner_id" {
  description = "Immutable GitHub owner ID included in the OIDC subject."
  type        = string
  default     = "220633794"
}

variable "github_repository_id" {
  description = "Immutable GitHub repository ID included in the OIDC subject."
  type        = string
  default     = "1374673243"
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
  description = "SKU por defecto de PostgreSQL Flexible Server. Los entornos pueden sobrescribirlo tras verificar disponibilidad regional."
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

variable "siem_host" {
  description = "Configuración completa para habilitar el host Wazuh QAPAQ. null mantiene el módulo apagado; al habilitarlo Terraform crea el firewall Azure con policy, bundle inmutable, clave pública y CIDR aprobados."
  type = object({
    address_prefix          = string
    vm_size                 = string
    admin_ssh_public_key    = string
    ubuntu_image_version    = string
    data_disk_size_gb       = number
    dashboard_ingress_cidrs = set(string)
    agent_ingress_cidrs     = set(string)
    core_secret_names       = map(string)
    wazuh_secret_names      = map(string)
    core_environment        = map(string)
    provider_ingestion      = optional(map(string), {})
    office365 = object({
      tenant_id  = string
      client_id  = string
      api_type   = string
      enable_dlp = bool
    })
    bootstrap_bundle_blob_url = string
    bootstrap_bundle_sha256   = string
  })
  default = null

  validation {
    condition = var.siem_host == null || (
      can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.siem_host.office365.tenant_id)) &&
      can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.siem_host.office365.client_id)) &&
      contains(["commercial", "gcc", "gcc-high"], var.siem_host.office365.api_type) &&
      contains(keys(var.siem_host.wazuh_secret_names), "office365-client-secret") &&
      contains(keys(var.siem_host.wazuh_secret_names), "wazuh-install-files.tar.b64") &&
      alltrue([
        for key, value in var.siem_host.provider_ingestion :
        contains(["sophos_enabled", "sophos_tenant_id", "sophos_data_region", "cato_enabled", "cato_account_id"], key) &&
        !can(regex("[\\r\\n]", value))
      ]) &&
      (
        lookup(var.siem_host.provider_ingestion, "sophos_enabled", "false") != "true" ||
        (can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", lookup(var.siem_host.provider_ingestion, "sophos_tenant_id", ""))) &&
          can(regex("^[a-z0-9-]{2,32}$", lookup(var.siem_host.provider_ingestion, "sophos_data_region", ""))) &&
          contains(keys(var.siem_host.wazuh_secret_names), "sophos-client-id") &&
        contains(keys(var.siem_host.wazuh_secret_names), "sophos-client-secret"))
      ) &&
      (
        lookup(var.siem_host.provider_ingestion, "cato_enabled", "false") != "true" ||
        (can(regex("^[0-9]{1,20}$", lookup(var.siem_host.provider_ingestion, "cato_account_id", ""))) &&
        contains(keys(var.siem_host.wazuh_secret_names), "cato-api-key"))
      )
    )
    error_message = "siem_host requiere IDs GUID de Office 365 válidos, api_type admitido y referencias Key Vault para `office365-client-secret` y `wazuh-install-files.tar.b64`."
  }
}

variable "ankay_host" {
  description = "Configuración de Ankay Qapaq/Shuffle en VM privada separada. null mantiene el host apagado. Requiere SIEM, seis digests ACR, Compose sin secretos y referencias a secretos precreados en Key Vault; comparte el firewall Azure del SIEM."
  type = object({
    private_ip_address      = string
    admin_ssh_public_key    = string
    vm_size                 = string
    ubuntu_image_version    = string
    data_disk_size_gb       = optional(number, 128)
    container_images        = map(string)
    compose_yaml            = string
    compose_sha256          = string
    secret_names            = map(string)
    docker_package_versions = map(string)
  })
  default  = null
  nullable = true

  validation {
    condition     = var.ankay_host == null || var.siem_host != null
    error_message = "Ankay Qapaq requiere que siem_host esté configurado para compartir el edge y callback protegido de QAPAQ."
  }

  validation {
    condition = var.ankay_host == null || (
      length(var.ankay_host.secret_names) >= 1 &&
      alltrue([for key, value in var.ankay_host.secret_names : can(regex("^[A-Z][A-Z0-9_]{0,127}$", key)) && can(regex("^[A-Za-z0-9-]{1,127}$", value))])
    )
    error_message = "ankay_host.secret_names debe mapear variables de entorno a nombres existentes de Key Vault; nunca incluyas valores secretos."
  }

  validation {
    condition = var.ankay_host == null || (
      length(var.ankay_host.docker_package_versions) == 6 &&
      alltrue([for key in ["docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin", "azure-cli"] : contains(keys(var.ankay_host.docker_package_versions), key)]) &&
      alltrue([for value in values(var.ankay_host.docker_package_versions) : can(regex("^[A-Za-z0-9:.+~_-]{1,80}$", value))])
    )
    error_message = "ankay_host.docker_package_versions debe fijar las seis versiones apt de Docker y Azure CLI."
  }
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
