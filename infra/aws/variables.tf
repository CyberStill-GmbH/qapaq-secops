variable "aws_region" {
  description = "AWS region for demo resources. The S3 state backend is configured separately."
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Project tag applied to every resource."
  type        = string
  default     = "qapaq-secops"
}

variable "environment" {
  description = "Deployment environment."
  type        = string
  default     = "demo"
}

variable "github_repository" {
  description = "GitHub repository allowed to assume the demo image-publisher role."
  type        = string
  default     = "CyberStill-GmbH/qapaq-secops"
}

variable "github_repository_owner_id" {
  description = "Immutable GitHub owner ID used in the OIDC subject claim."
  type        = string
  default     = "220633794"

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_owner_id))
    error_message = "github_repository_owner_id must be a numeric GitHub ID."
  }
}

variable "github_repository_id" {
  description = "Immutable GitHub repository ID used in the OIDC subject claim."
  type        = string
  default     = "1374673243"

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "github_repository_id must be a numeric GitHub ID."
  }
}

variable "vpc_cidr" {
  description = "CIDR range for the demo VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "az_count" {
  description = "Number of Availability Zones used by the network."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "The demo network requires two or three Availability Zones."
  }
}

variable "availability_zones" {
  description = "Optional explicit Availability Zones. When empty, the first az_count available zones are used."
  type        = list(string)
  default     = []

  validation {
    condition     = length(var.availability_zones) == 0 || length(var.availability_zones) == var.az_count
    error_message = "Provide exactly az_count Availability Zones or leave the list empty."
  }
}

variable "public_subnet_cidrs" {
  description = "Optional public subnet CIDRs, one per selected AZ. Empty uses generated /24 ranges."
  type        = list(string)
  default     = []

  validation {
    condition = length(var.public_subnet_cidrs) == 0 || length(var.public_subnet_cidrs) == (
      length(var.availability_zones) > 0 ? length(var.availability_zones) : var.az_count
    )
    error_message = "Provide one public subnet CIDR per selected Availability Zone, or leave the list empty."
  }
}

variable "app_subnet_cidrs" {
  description = "Optional private application subnet CIDRs, one per selected AZ. Empty uses generated /24 ranges."
  type        = list(string)
  default     = []

  validation {
    condition = length(var.app_subnet_cidrs) == 0 || length(var.app_subnet_cidrs) == (
      length(var.availability_zones) > 0 ? length(var.availability_zones) : var.az_count
    )
    error_message = "Provide one app subnet CIDR per selected Availability Zone, or leave the list empty."
  }
}

variable "data_subnet_cidrs" {
  description = "Optional isolated private data subnet CIDRs, one per selected AZ. Empty uses generated /24 ranges."
  type        = list(string)
  default     = []

  validation {
    condition = length(var.data_subnet_cidrs) == 0 || length(var.data_subnet_cidrs) == (
      length(var.availability_zones) > 0 ? length(var.availability_zones) : var.az_count
    )
    error_message = "Provide one data subnet CIDR per selected Availability Zone, or leave the list empty."
  }
}

variable "allowed_admin_cidrs" {
  description = "Trusted IPv4 CIDRs allowed to reach the Wazuh Dashboard over HTTPS. Empty keeps the dashboard inaccessible."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for cidr in var.allowed_admin_cidrs : can(cidrnetmask(cidr)) && cidr != "0.0.0.0/0"
    ])
    error_message = "Admin CIDRs must be valid IPv4 networks and cannot include 0.0.0.0/0."
  }
}

variable "enable_https" {
  description = "Enable ALB HTTPS ingress. Listener and certificate resources are added in a later phase."
  type        = bool
  default     = false
}

variable "krakend_port" {
  description = "KrakenD listener port."
  type        = number
  default     = 8080
}

variable "api_port" {
  description = "QAPAQ API listener port."
  type        = number
  default     = 3000
}

variable "postgres_port" {
  description = "PostgreSQL listener port."
  type        = number
  default     = 5432
}

variable "redis_port" {
  description = "Redis/Valkey listener port."
  type        = number
  default     = 6379
}

variable "wazuh_indexer_port" {
  description = "Wazuh Indexer HTTPS listener port."
  type        = number
  default     = 9200
}

variable "wazuh_dashboard_port" {
  description = "Wazuh Dashboard HTTPS listener port."
  type        = number
  default     = 443
}
