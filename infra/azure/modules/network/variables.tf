variable "resource_group_name" { type = string }
variable "location" { type = string }
variable "name_base" { type = string }
variable "address_space" { type = string }
variable "tags" { type = map(string) }
variable "enable_siem_firewall" {
  description = "Reserva la subnet AzureFirewallSubnet /26 cuando se habilita el host SIEM."
  type        = bool
  default     = false
}

variable "ankay_subnet_address_prefix" {
  description = "CIDR de la subnet exclusiva de Ankay; null mantiene el host Ankay deshabilitado. El root reserva el segundo /27 del address space."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.ankay_subnet_address_prefix == null || can(cidrhost(var.ankay_subnet_address_prefix, 0))
    error_message = "ankay_subnet_address_prefix debe ser null o un CIDR válido."
  }
}

variable "krakend_subnet_address_prefix" {
  description = "CIDR dedicado al ACA Environment privado de KrakenD; null lo mantiene apagado. Workload Profiles requiere al menos /27."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.krakend_subnet_address_prefix == null || (can(cidrhost(var.krakend_subnet_address_prefix, 0)) && tonumber(split("/", var.krakend_subnet_address_prefix)[1]) <= 27)
    error_message = "krakend_subnet_address_prefix debe ser null o un CIDR /27 o mayor."
  }
}
