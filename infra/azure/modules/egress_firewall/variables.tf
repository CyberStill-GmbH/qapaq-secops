variable "resource_group_name" { type = string }
variable "location" { type = string }
variable "name_base" { type = string }
variable "firewall_subnet_id" { type = string }
variable "sku_tier" {
  description = "Basic basta para filtrar egress por FQDN y publicar el DNAT; Standard agrega Threat Intelligence en Deny y DNS proxy."
  type        = string
  default     = "Basic"

  validation {
    condition     = contains(["Basic", "Standard"], var.sku_tier)
    error_message = "sku_tier debe ser Basic o Standard."
  }
}
variable "management_subnet_id" {
  description = "AzureFirewallManagementSubnet; obligatoria solo con sku_tier Basic."
  type        = string
  default     = null
}
variable "log_analytics_workspace_id" {
  description = "Workspace de Azure Monitor que recibe los logs NAT estructurados del Firewall."
  type        = string
}
variable "source_cidrs" {
  description = "Private workload subnets allowed to use the explicitly listed HTTPS destinations."
  type        = set(string)

  validation {
    condition     = length(var.source_cidrs) > 0 && alltrue([for cidr in var.source_cidrs : can(cidrhost(cidr, 0))])
    error_message = "At least one valid private source CIDR is required."
  }
}
variable "ingress_lb_private_ip" {
  description = "IPv4 privada fija del Load Balancer interno que recibe el DNAT público del SIEM."
  type        = string
  default     = null

  validation {
    condition     = var.ingress_lb_private_ip == null || can(cidrhost("${var.ingress_lb_private_ip}/32", 0))
    error_message = "ingress_lb_private_ip debe ser una IPv4 válida."
  }
}
variable "dashboard_ingress_cidrs" {
  description = "CIDR de origen para HTTPS público al Dashboard. 0.0.0.0/0 admite todas las IPs; vacío no crea regla DNAT HTTPS."
  type        = set(string)
  default     = []

  validation {
    condition     = alltrue([for cidr in var.dashboard_ingress_cidrs : can(cidrhost(cidr, 0)) && cidr != "::/0"])
    error_message = "Cada origen de Dashboard debe ser un CIDR válido; IPv6 global no está habilitado."
  }
}
variable "ingress_http_enabled" {
  description = "Publica HTTP solo para el challenge ACME HTTP-01 y la redirección HTTPS del edge."
  type        = bool
  default     = true
}
variable "allowed_fqdns" {
  description = "Explicit HTTPS egress allowlist for Ubuntu, Entra, Graph, Teams Workflows and VirusTotal; the root adds provider APIs (Sophos, Cato, Anthropic) only when enabled."
  type        = set(string)
  default = [
    "archive.ubuntu.com",
    "azure.archive.ubuntu.com",
    "graph.microsoft.com",
    "login.microsoftonline.com",
    "packages.microsoft.com",
    "*.logic.azure.com",
    "*.api.powerplatform.com",
    "security.ubuntu.com",
    "api.virustotal.com",
    "acme-v02.api.letsencrypt.org",
  ]

  validation {
    condition     = length(var.allowed_fqdns) > 0 && alltrue([for fqdn in var.allowed_fqdns : can(regex("^(\\*\\.)?[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$", fqdn))])
    error_message = "allowed_fqdns must contain valid explicit FQDNs or a subdomain wildcard."
  }
}

variable "container_apps_source_cidrs" {
  description = "Subnets of private ACA environments routed through this firewall; empty means no ACA-specific rules."
  type        = set(string)
  default     = []
}

variable "container_apps_allowed_fqdns" {
  description = "Exact ACA platform/registry/Entra FQDNs allowed through the firewall, scoped to ACA source CIDRs."
  type        = set(string)
  default     = []
}

variable "container_apps_allowed_service_tags" {
  description = "Azure service tags required by private ACA with UDR, scoped to ACA source CIDRs."
  type        = set(string)
  default     = []
}
variable "tags" { type = map(string) }

variable "agent_public_cidrs" {
  description = "IPs públicas de las redes con agentes Wazuh (oficinas, egress de Cato). Vacío no publica 1514/1515."
  type        = set(string)
  default     = []

  validation {
    condition     = alltrue([for cidr in var.agent_public_cidrs : can(cidrhost(cidr, 0)) && cidr != "0.0.0.0/0" && cidr != "::/0"])
    error_message = "Cada origen de agentes debe ser un CIDR válido y no puede abarcar todo Internet."
  }
}
variable "agent_target_ip" {
  description = "IP privada fija de la VM SIEM que recibe registro (1515) y eventos (1514) de agentes."
  type        = string
  default     = null
}
