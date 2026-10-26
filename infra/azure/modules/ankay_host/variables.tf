variable "resource_group_name" { type = string }
variable "location" { type = string }
variable "name_base" { type = string }
variable "tags" { type = map(string) }

variable "subnet_id" {
  description = "Subnet privada dedicada de Ankay; debe tener una UDR 0/0 hacia Azure Firewall. No compartirla con PostgreSQL."
  type        = string
}

variable "confirm_dedicated_subnet" {
  description = "Debe ser true solo si subnet_id se creó para Ankay y esta asociación de UDR no afecta otros workloads."
  type        = bool
  validation {
    condition     = var.confirm_dedicated_subnet
    error_message = "Ankay requiere una subnet dedicada antes de asociar su ruta forzada al firewall."
  }
}

variable "private_ip_address" {
  description = "IPv4 privada estática del host dentro de subnet_id."
  type        = string
  validation {
    condition     = can(cidrhost("${var.private_ip_address}/32", 0))
    error_message = "private_ip_address debe ser una dirección IPv4."
  }
}

variable "edge_subnet_cidr" {
  description = "Origen privado del edge QAPAQ (en el root actual, la IP del host SIEM como /32) permitido hacia el frontend Ankay."
  type        = string
  validation {
    condition     = can(cidrhost(var.edge_subnet_cidr, 0))
    error_message = "edge_subnet_cidr debe ser un CIDR válido."
  }
}

variable "qapaq_api_subnet_cidr" {
  description = "Origen privado del QAPAQ Core (en el root actual, la IP del host SIEM como /32) permitido hacia el webhook Ankay."
  type        = string
  validation {
    condition     = can(cidrhost(var.qapaq_api_subnet_cidr, 0))
    error_message = "qapaq_api_subnet_cidr debe ser un CIDR válido."
  }
}

variable "qapaq_api_private_ip" {
  description = "IP privada del endpoint API para el callback Ankay→QAPAQ; usar una IP estable o proxy interno."
  type        = string
  validation {
    condition     = can(cidrhost("${var.qapaq_api_private_ip}/32", 0))
    error_message = "qapaq_api_private_ip debe ser una dirección IPv4 privada estable."
  }
}

variable "firewall_private_ip" {
  description = "IP privada del Azure Firewall de salida. La subnet debe enrutar 0/0 por ese firewall y su policy debe denegar por defecto."
  type        = string
  validation {
    condition     = can(cidrhost("${var.firewall_private_ip}/32", 0))
    error_message = "firewall_private_ip debe ser una dirección IPv4."
  }
}

variable "firewall_policy_reference" {
  description = "Referencia revisada de la policy Azure Firewall con allowlist de destinos. Texto de control; no configura el firewall."
  type        = string
  validation {
    condition     = length(trimspace(var.firewall_policy_reference)) > 0
    error_message = "La salida queda bloqueada hasta documentar la policy de firewall revisada."
  }
}

variable "wazuh_manager_private_ip" {
  description = "IP privada del manager Wazuh para salida del agente por TCP/1514. Vacía hasta que exista manager Azure."
  type        = string
  default     = ""
  validation {
    condition     = var.wazuh_manager_private_ip == "" || can(cidrhost("${var.wazuh_manager_private_ip}/32", 0))
    error_message = "wazuh_manager_private_ip debe quedar vacío o ser una IPv4."
  }
}

variable "admin_username" {
  type    = string
  default = "qapaqops"
}

variable "admin_ssh_public_key" {
  description = "Clave pública del operador para recuperación fuera de banda. No se abre SSH en el NSG."
  type        = string
  validation {
    condition     = can(regex("^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) ", var.admin_ssh_public_key))
    error_message = "Proporciona una clave SSH pública; nunca una clave privada."
  }
}

variable "vm_size" {
  description = "SKU aprobada tras revisar costo/uso de memoria de OpenSearch; sin default para evitar un SKU costoso implícito."
  type        = string
}

variable "ubuntu_image_version" {
  description = "Versión exacta de Canonical Ubuntu 24.04 LTS disponible en la región; no se permite latest."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{8}(\\.[0-9]+)?$", var.ubuntu_image_version))
    error_message = "Fija una versión numérica concreta de la imagen Ubuntu 24.04 LTS; latest no es reproducible."
  }
}

variable "data_disk_size_gb" {
  description = "Disco persistente para OpenSearch y archivos de Shuffle."
  type        = number
  default     = 128
  validation {
    condition     = var.data_disk_size_gb >= 64 && var.data_disk_size_gb <= 4096
    error_message = "El disco persistente debe estar entre 64 y 4096 GiB."
  }
}

variable "container_registry_id" {
  description = "Resource ID del ACR privado que contiene todas las imágenes fijadas."
  type        = string
}

variable "container_registry_login_server" {
  description = "FQDN del ACR usado para validar los digests de los servicios."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9]{5,50}\\.azurecr\\.io$", var.container_registry_login_server))
    error_message = "Usa el login server completo de Azure Container Registry."
  }
}

variable "container_images" {
  description = "Digests OCI previamente verificados en ACR: cinco servicios Compose y la imagen de worker que Orborus ejecuta dinámicamente."
  type        = map(string)
  validation {
    condition = length(var.container_images) == 6 && alltrue([
      for key in ["shuffle-security", "frontend", "backend", "orborus", "opensearch", "worker"] : contains(keys(var.container_images), key)
      ]) && alltrue([
      for image in values(var.container_images) : can(regex("^[a-z0-9]{5,50}\\.azurecr\\.io/[a-zA-Z0-9._/-]+@sha256:[0-9a-f]{64}$", image))
    ])
    error_message = "Fija shuffle-security, frontend, backend, orborus, opensearch y worker a imágenes ACR por digest SHA-256 completo. Worker es una imagen dinámica, no un servicio Compose."
  }
}

variable "key_vault_id" {
  description = "Resource ID del Key Vault existente; la identidad recibe lectura solo en secretos explícitamente nombrados."
  type        = string
}

variable "key_vault_uri" {
  description = "URI HTTPS del Key Vault con Private Endpoint/DNS alcanzable desde la subnet dedicada."
  type        = string
  validation {
    condition     = can(regex("^https://[A-Za-z0-9-]+\\.vault\\.azure\\.net/?$", var.key_vault_uri))
    error_message = "key_vault_uri debe ser el endpoint HTTPS oficial del Key Vault."
  }
}

variable "key_vault_private_ip" {
  description = "IP del Private Endpoint del Key Vault; autoriza solo HTTPS desde Ankay para cargar secretos runtime."
  type        = string
  validation {
    condition     = can(cidrhost("${var.key_vault_private_ip}/32", 0))
    error_message = "key_vault_private_ip debe ser la IPv4 privada del endpoint Key Vault."
  }
}

variable "secret_names" {
  description = "Mapa de variables de entorno a nombres preexistentes de Key Vault. Solo nombres; nunca valores."
  type        = map(string)
  validation {
    condition = length(var.secret_names) >= 1 && alltrue([
      for key, value in var.secret_names : can(regex("^[A-Z][A-Z0-9_]{0,127}$", key)) && can(regex("^[A-Za-z0-9-]{1,127}$", value))
    ])
    error_message = "Cada nombre de variable debe ser válido y mapear a un nombre simple de secreto Key Vault."
  }
}

variable "docker_package_versions" {
  description = "Versiones apt exactas para Docker Engine/Compose y Azure CLI."
  type        = map(string)
  validation {
    condition = length(var.docker_package_versions) == 6 && alltrue([
      for key in ["docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin", "azure-cli"] : contains(keys(var.docker_package_versions), key)
    ]) && alltrue([for value in values(var.docker_package_versions) : can(regex("^[A-Za-z0-9:.+~_-]{1,80}$", value))])
    error_message = "Fija exactamente las seis versiones apt de Docker y Azure CLI."
  }
}

variable "compose_health_timeout_seconds" {
  description = "Tiempo máximo para esperar healthy checks de todos los servicios del Compose."
  type        = number
  default     = 900
  validation {
    condition     = var.compose_health_timeout_seconds >= 60 && var.compose_health_timeout_seconds <= 3600
    error_message = "El timeout de salud debe estar entre 60 y 3600 segundos."
  }
}

variable "compose_yaml" {
  description = "Compose revisado y sin secretos con exactamente shuffle-security, frontend, backend, orborus y opensearch. El worker va en SHUFFLE_WORKER_IMAGE de Orborus, no como servicio. Se guarda en custom_data/state."
  type        = string
}

variable "compose_sha256" {
  description = "SHA-256 revisado del archivo compose_yaml, para evitar que el host arranque un manifiesto mutable."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.compose_sha256))
    error_message = "compose_sha256 debe ser un SHA-256 hex completo."
  }
}

variable "frontend_port" {
  type    = number
  default = 3001
}

variable "backend_port" {
  type    = number
  default = 5001
}

variable "api_port" {
  type    = number
  default = 443
}
