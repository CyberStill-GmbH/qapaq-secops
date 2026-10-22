variable "resource_group_name" {
  description = "Resource group existente del entorno Azure."
  type        = string
}

variable "location" {
  description = "Región de la VM; debe coincidir con la VNet y los discos."
  type        = string
}

variable "name_base" {
  description = "Prefijo corto y estable para los recursos del host SIEM."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,17}$", var.name_base))
    error_message = "name_base debe ser un prefijo DNS/ARM simple de hasta 18 caracteres."
  }
}

variable "virtual_network_name" {
  description = "VNet existente; el módulo crea una subnet privada dedicada al SIEM."
  type        = string
}

variable "firewall_private_ip" {
  description = "IP privada IPv4 del Azure Firewall existente que recibe la ruta 0/0 de la subnet SIEM. No tiene valor predeterminado: sin firewall el módulo no puede planificarse."
  type        = string

  validation {
    condition     = can(cidrhost("${var.firewall_private_ip}/32", 0))
    error_message = "firewall_private_ip debe ser una IPv4 válida del Azure Firewall existente."
  }
}

variable "firewall_policy_reference" {
  description = "ID/nombre de la Azure Firewall Policy revisada para el SIEM. La policy externa debe denegar por defecto y permitir solo los destinos de release/runtime aprobados."
  type        = string

  validation {
    condition     = length(trimspace(var.firewall_policy_reference)) > 0
    error_message = "La salida del SIEM queda bloqueada hasta declarar la policy de Azure Firewall revisada."
  }
}

variable "private_endpoint_subnet_cidr" {
  description = "CIDR exacto de la subnet privada que aloja Private Endpoints de Blob y Key Vault requeridos durante bootstrap/runtime."
  type        = string

  validation {
    condition     = can(cidrhost(var.private_endpoint_subnet_cidr, 0))
    error_message = "private_endpoint_subnet_cidr debe ser un CIDR válido y específico."
  }
}

variable "postgres_subnet_cidr" {
  description = "CIDR exacto de la subnet PostgreSQL privada; solo se autoriza TCP/5432 a este rango."
  type        = string

  validation {
    condition     = can(cidrhost(var.postgres_subnet_cidr, 0))
    error_message = "postgres_subnet_cidr debe ser un CIDR válido y específico."
  }
}

variable "address_prefix" {
  description = "CIDR libre y no solapado para la subnet privada del SIEM."
  type        = string

  validation {
    condition     = can(cidrhost(var.address_prefix, 0)) && tonumber(split("/", var.address_prefix)[1]) <= 27
    error_message = "La subnet SIEM debe ser un CIDR válido de /27 o mayor."
  }
}

variable "vm_size" {
  description = "SKU de VM validado con la carga Wazuh y la cuota de la suscripción."
  type        = string
}

variable "admin_username" {
  description = "Usuario Linux de administración local; SSH no se abre en el NSG."
  type        = string
  default     = "qapaqadmin"

  validation {
    condition     = can(regex("^[a-z_][a-z0-9_-]{0,31}$", var.admin_username))
    error_message = "admin_username debe ser un usuario Linux válido."
  }
}

variable "admin_ssh_public_key" {
  description = "Clave pública SSH para acceso por un canal privado aprobado (por ejemplo, Azure Bastion). No se crea acceso SSH público."
  type        = string
  sensitive   = false

  validation {
    condition     = can(regex("^(ssh-ed25519|ssh-rsa) [A-Za-z0-9+/=]+", var.admin_ssh_public_key))
    error_message = "Proporciona una clave pública SSH OpenSSH válida; nunca una clave privada."
  }
}

variable "ubuntu_image_version" {
  description = "Versión exacta de la imagen Canonical Ubuntu 24.04 LTS. No usar latest."
  type        = string

  validation {
    condition     = can(regex("^24\\.04\\.[0-9]+$", var.ubuntu_image_version))
    error_message = "Fija una versión exacta Ubuntu 24.04 de Canonical; latest no está permitido."
  }
}

variable "os_disk_size_gb" {
  description = "Tamaño del disco de sistema."
  type        = number
  default     = 64

  validation {
    condition     = var.os_disk_size_gb >= 64
    error_message = "El disco de sistema debe ser de al menos 64 GiB."
  }
}

variable "data_disk_size_gb" {
  description = "Disco durable para estado de Wazuh. Debe presupuestarse según retención y volumen."
  type        = number

  validation {
    condition     = var.data_disk_size_gb >= 128
    error_message = "El disco durable debe ser de al menos 128 GiB."
  }
}

variable "data_disk_storage_account_type" {
  description = "Tipo de almacenamiento administrado para datos Wazuh."
  type        = string
  default     = "Premium_LRS"

  validation {
    condition     = contains(["Premium_LRS", "StandardSSD_LRS", "Premium_ZRS", "StandardSSD_ZRS"], var.data_disk_storage_account_type)
    error_message = "Usa un tipo de disco administrado SSD explícito."
  }
}

variable "dashboard_ingress_cidrs" {
  description = "CIDR de origen aprobado para HTTPS. Vacío significa que 443 queda denegado."
  type        = set(string)
  default     = []

  validation {
    condition     = alltrue([for cidr in var.dashboard_ingress_cidrs : can(cidrhost(cidr, 0)) && cidr != "0.0.0.0/0" && cidr != "::/0"])
    error_message = "Cada CIDR de ingreso al Dashboard debe ser válido y distinto de cualquier origen de Internet."
  }
}

variable "agent_ingress_cidrs" {
  description = "CIDR de redes de agentes aprobadas; vacío mantiene cerrados 1514/TCP y 1515/TCP."
  type        = set(string)
  default     = []

  validation {
    condition     = alltrue([for cidr in var.agent_ingress_cidrs : can(cidrhost(cidr, 0)) && cidr != "0.0.0.0/0" && cidr != "::/0"])
    error_message = "Cada CIDR de agente debe ser válido. No se permite 0.0.0.0/0."
  }
}

variable "key_vault_id" {
  description = "ID del Key Vault ya protegido por red privada."
  type        = string
}

variable "key_vault_uri" {
  description = "URI HTTPS del Key Vault privado, por ejemplo https://<vault>.vault.azure.net."
  type        = string

  validation {
    condition     = can(regex("^https://[A-Za-z0-9-]+\\.vault\\.azure\\.net/?$", var.key_vault_uri))
    error_message = "key_vault_uri debe ser una URI HTTPS de Azure Key Vault sin credenciales ni query string."
  }
}

variable "core_secret_names" {
  description = "Mapa variable de entorno → nombre de secreto preexistente en Key Vault. Solo nombres; nunca valores."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for key, name in var.core_secret_names :
      can(regex("^[A-Z][A-Z0-9_]{0,127}$", key)) && can(regex("^[A-Za-z0-9-]{1,127}$", name))
    ])
    error_message = "Los nombres de variables y secretos deben usar caracteres permitidos y no pueden contener valores."
  }

  validation {
    condition     = !contains(keys(var.core_secret_names), "QAPAQ_ENTRA_CLIENT_SECRET_REF")
    error_message = "QAPAQ_ENTRA_CLIENT_SECRET_REF es una referencia no secreta y pertenece en core_environment; el valor real QAPAQ_ENTRA_CLIENT_SECRET pertenece en core_secret_names."
  }
}

variable "wazuh_secret_names" {
  description = "Mapa nombre de archivo seguro → secreto preexistente para la instalación Wazuh. Solo referencias, nunca valores."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for filename, name in var.wazuh_secret_names :
      can(regex("^[A-Za-z0-9._-]{1,100}$", filename)) && can(regex("^[A-Za-z0-9-]{1,127}$", name))
    ])
    error_message = "Los nombres de archivo y secreto deben ser simples y no contener rutas ni valores."
  }
}

variable "core_environment" {
  description = "Configuración no secreta de qapaq-core."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for key, value in var.core_environment :
      can(regex("^[A-Z][A-Z0-9_]{0,127}$", key)) &&
      !can(regex("[\\r\\n]", value)) &&
      (
        key == "QAPAQ_ENTRA_CLIENT_SECRET_REF"
        ? (
          can(regex("^secret://keyvault/[A-Za-z0-9][A-Za-z0-9-]{0,126}$", value)) &&
          lookup(var.core_secret_names, "QAPAQ_ENTRA_CLIENT_SECRET", "") == trimprefix(value, "secret://keyvault/")
        )
        : !can(regex("(PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|CREDENTIAL|DATABASE_URL|CONNECTION_STRING)", key))
      )
    ])
    error_message = "core_environment admite QAPAQ_ENTRA_CLIENT_SECRET_REF solo como secret://keyvault/<nombre> y debe coincidir con core_secret_names.QAPAQ_ENTRA_CLIENT_SECRET; las claves sensibles restantes y los valores multilínea están prohibidos."
  }
}

variable "container_registry_id" {
  description = "ID del ACR existente, limitado a AcrPull para la identidad de la VM."
  type        = string
}

variable "artifact_container_scope_id" {
  description = "Scope de contenedor Blob privado que contiene el bundle, limitado a Storage Blob Data Reader."
  type        = string
}

variable "evidence_container_scope_id" {
  description = "Scope de contenedor Blob privado de evidencia, limitado a Storage Blob Data Contributor."
  type        = string
  default     = null
}

variable "bootstrap_bundle_blob_url" {
  description = "URL HTTPS sin SAS a un blob privado con el bundle inmutable Wazuh + QAPAQ."
  type        = string

  validation {
    condition     = can(regex("^https://[A-Za-z0-9.-]+\\.blob\\.core\\.windows\\.net/[^?]+$", var.bootstrap_bundle_blob_url))
    error_message = "Usa una URL de blob HTTPS sin SAS ni query string; el acceso se hace con identidad administrada."
  }
}

variable "bootstrap_bundle_sha256" {
  description = "SHA-256 del bundle completo, calculado y publicado por CI."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.bootstrap_bundle_sha256))
    error_message = "bootstrap_bundle_sha256 debe contener 64 dígitos hexadecimales minúsculos."
  }
}

variable "tags" {
  description = "Etiquetas comunes."
  type        = map(string)
  default     = {}
}
