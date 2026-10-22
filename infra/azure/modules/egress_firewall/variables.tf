variable "resource_group_name" { type = string }
variable "location" { type = string }
variable "name_base" { type = string }
variable "firewall_subnet_id" { type = string }
variable "source_cidrs" {
  description = "Private workload subnets allowed to use the explicitly listed HTTPS destinations."
  type        = set(string)

  validation {
    condition     = length(var.source_cidrs) > 0 && alltrue([for cidr in var.source_cidrs : can(cidrhost(cidr, 0))])
    error_message = "At least one valid private source CIDR is required."
  }
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
  ]

  validation {
    condition     = length(var.allowed_fqdns) > 0 && alltrue([for fqdn in var.allowed_fqdns : can(regex("^(\\*\\.)?[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$", fqdn))])
    error_message = "allowed_fqdns must contain valid explicit FQDNs or a subdomain wildcard."
  }
}
variable "tags" { type = map(string) }
