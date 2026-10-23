variable "resource_group_name" { type = string }
variable "location" { type = string }
variable "name_base" { type = string }
variable "firewall_subnet_id" { type = string }
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
  description = "CIDR aprobados para HTTPS público al Dashboard. Vacío no crea regla DNAT HTTPS."
  type        = set(string)
  default     = []

  validation {
    condition     = alltrue([for cidr in var.dashboard_ingress_cidrs : can(cidrhost(cidr, 0)) && cidr != "0.0.0.0/0" && cidr != "::/0"])
    error_message = "Cada origen de Dashboard debe ser un CIDR válido y no puede abarcar todo Internet."
  }
}
variable "ingress_http_enabled" {
  description = "Publica HTTP solo para el challenge ACME HTTP-01 y la redirección HTTPS del edge."
  type        = bool
  default     = true
}
variable "allowed_fqdns" {
  description = "Explicit HTTPS egress allowlist for Ubuntu, Entra, Graph and VirusTotal."
  type        = set(string)
  default = [
    "archive.ubuntu.com",
    "azure.archive.ubuntu.com",
    "graph.microsoft.com",
    "login.microsoftonline.com",
    "packages.microsoft.com",
    "security.ubuntu.com",
    "api.virustotal.com",
    "acme-v02.api.letsencrypt.org",
  ]

  validation {
    condition     = length(var.allowed_fqdns) > 0 && alltrue([for fqdn in var.allowed_fqdns : can(regex("^(\\*\\.)?[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$", fqdn))])
    error_message = "allowed_fqdns must contain valid explicit FQDNs or a subdomain wildcard."
  }
}
variable "tags" { type = map(string) }
