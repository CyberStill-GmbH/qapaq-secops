variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "name" {
  description = "Prefijo de todos los recursos."
  type        = string
  default     = "qapaq-soc-dev"
}

variable "vpc_cidr" {
  type    = string
  default = "10.89.0.0/24"
}

variable "allowed_admin_cidrs" {
  description = "CIDR con acceso a SSH (22) y HTTPS (443). Nunca 0.0.0.0/0."
  type        = list(string)

  validation {
    condition     = length(var.allowed_admin_cidrs) > 0 && !contains(var.allowed_admin_cidrs, "0.0.0.0/0")
    error_message = "allowed_admin_cidrs es obligatorio y no puede ser 0.0.0.0/0."
  }
}

variable "agent_cidrs" {
  description = "CIDR de agentes Wazuh (1514/1515). Vacío: sin agentes externos."
  type        = list(string)
  default     = []
}

variable "instance_type" {
  description = "x86_64: las imágenes del API y del migrador están fijadas a linux/amd64."
  type        = string
  default     = "r7i.large"
}

variable "root_volume_gb" {
  type    = number
  default = 100
}

variable "ssh_public_key" {
  description = "Clave pública ed25519 del operador (la privada nunca entra al repositorio)."
  type        = string
}

variable "route53_zone_id" {
  type    = string
  default = "Z0865473RDUFXSD2G9KN"
}

variable "domain_name" {
  type    = string
  default = "app.jappi.net.pe"
}

variable "budget_email" {
  description = "Correo para el aviso de presupuesto. Vacío: sin suscriptor."
  type        = string
  default     = ""
}

variable "monthly_budget_usd" {
  type    = number
  default = 150
}
