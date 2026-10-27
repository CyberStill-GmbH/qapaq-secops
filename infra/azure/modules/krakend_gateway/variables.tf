variable "resource_group_name" { type = string }
variable "location" { type = string }
variable "name_base" { type = string }
variable "tags" { type = map(string) }
variable "virtual_network_id" { type = string }
variable "subnet_id" { type = string }
variable "subnet_cidr" {
  description = "CIDR de la subnet ACA exclusiva; debe ser /27 o mayor y no compartir dirección con SIEM."
  type        = string

  validation {
    condition     = can(cidrhost(var.subnet_cidr, 0)) && tonumber(split("/", var.subnet_cidr)[1]) <= 27
    error_message = "subnet_cidr debe ser una red IPv4 /27 o mayor para ACA Workload Profiles."
  }
}
variable "siem_indexer_proxy_ip" {
  description = "IP privada estable del proxy TLS read-only en SIEM, fuera de la subnet ACA."
  type        = string

  validation {
    condition     = can(cidrhost("${var.siem_indexer_proxy_ip}/32", 0))
    error_message = "siem_indexer_proxy_ip debe ser una IPv4 válida. El root debe mantenerla fuera de la subnet ACA."
  }
}
variable "siem_bootstrap_extension_id" {
  description = "ID de la extensión de bootstrap SIEM; KrakenD no arranca antes de que el proxy Indexer valide y siembre las dos referencias existentes."
  type        = string

  validation {
    condition     = can(regex("^/subscriptions/[0-9a-fA-F-]{36}/resourceGroups/[^/]+/providers/Microsoft.Compute/virtualMachines/[^/]+/extensions/[^/]+$", var.siem_bootstrap_extension_id))
    error_message = "siem_bootstrap_extension_id debe referenciar la extensión de bootstrap de la VM SIEM."
  }
}
variable "firewall_private_ip" {
  description = "IP privada de Azure Firewall para la UDR de salida del entorno ACA."
  type        = string

  validation {
    condition     = can(cidrhost("${var.firewall_private_ip}/32", 0))
    error_message = "firewall_private_ip debe ser una IPv4 válida."
  }
}
variable "log_analytics_workspace_id" { type = string }
variable "container_registry_id" { type = string }
variable "container_registry_login_server" { type = string }
variable "key_vault_id" { type = string }
variable "key_vault_uri" { type = string }

variable "image" {
  description = "Imagen QAPAQ KrakenD en el ACR del entorno, fijada a digest inmutable."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]+\\.azurecr\\.io/qapaq-secops-krakend@sha256:[0-9a-f]{64}$", var.image))
    error_message = "La imagen debe apuntar al repositorio qapaq-secops-krakend del ACR y fijarse a un digest SHA-256."
  }
}

variable "tenant_id" {
  description = "Tenant Entra que emite los tokens de workload del QAPAQ Core."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.tenant_id))
    error_message = "tenant_id debe ser un GUID Entra válido."
  }
}

variable "client_scope" {
  description = "Scope OAuth client-credentials de la API recurso, p. ej. api://<api-client-id>/.default."
  type        = string

  validation {
    condition     = can(regex("^api://[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/\\.default$", var.client_scope))
    error_message = "client_scope debe ser api://<client-id>/.default para la aplicación de QAPAQ Core."
  }
}

variable "core_client_id" {
  description = "Client ID de la única aplicación QAPAQ Core autorizada a consumir el gateway."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.core_client_id))
    error_message = "core_client_id debe ser el GUID de la aplicación Entra QAPAQ Core."
  }
}

variable "indexer_reader_secret_name" {
  description = "Nombre en Key Vault del JSON de identidad read-only de Wazuh; KrakenD consume solo basic_auth_b64."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9-]{1,127}$", var.indexer_reader_secret_name))
    error_message = "indexer_reader_secret_name debe ser un nombre Key Vault, nunca un valor secreto."
  }
}

variable "indexer_proxy_ca_secret_name" {
  description = "Nombre en Key Vault de la CA del proxy TLS privado del Indexer."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9-]{1,127}$", var.indexer_proxy_ca_secret_name))
    error_message = "indexer_proxy_ca_secret_name debe ser un nombre Key Vault, nunca un certificado/valor."
  }
}
