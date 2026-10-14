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
  description = "Serve the ALB through an ACM certificate and redirect HTTP requests to HTTPS."
  type        = bool
  default     = true
}

variable "public_api_hostname" {
  description = "Public DNS hostname for the application ALB, such as api.example.com."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = !var.enable_https || (
      var.public_api_hostname != null &&
      length(split(".", var.public_api_hostname)) >= 2 &&
      can(regex("^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])$", var.public_api_hostname)) &&
      !can(regex("\\.vercel\\.app$", var.public_api_hostname))
    )
    error_message = "HTTPS requires a public API hostname you control; Vercel's shared hostname cannot be used for this ACM certificate."
  }
}

variable "public_route53_zone_name" {
  description = "DNS name of the public Route 53 hosted zone that owns public_api_hostname."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = !var.enable_https || (
      var.public_route53_zone_name != null &&
      length(split(".", trimsuffix(var.public_route53_zone_name, "."))) >= 2 &&
      can(regex("^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])\\.?$", var.public_route53_zone_name))
    )
    error_message = "HTTPS requires the DNS name of the public Route 53 zone for public_api_hostname."
  }
}

variable "public_root_route53_zone_name" {
  description = "DNS name of the root Route 53 zone delegated by the domain registrar."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.public_root_route53_zone_name == null || (
      length(split(".", trimsuffix(var.public_root_route53_zone_name, "."))) >= 2 &&
      can(regex("^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])\\.?$", var.public_root_route53_zone_name))
    )
    error_message = "public_root_route53_zone_name must be a valid DNS zone name."
  }
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

variable "wazuh_version" {
  description = "Pinned Wazuh version for the official single-host installer."
  type        = string
  default     = "4.14.8"
}

variable "wazuh_instance_type" {
  description = "EC2 instance type for the Wazuh all-in-one demo host."
  type        = string
  default     = "t3.xlarge"
}

variable "wazuh_volume_size_gb" {
  description = "Encrypted gp3 root volume for Wazuh services and indexed data."
  type        = number
  default     = 100

  validation {
    condition     = var.wazuh_volume_size_gb >= 50
    error_message = "Wazuh needs at least 50 GiB; 100 GiB is configured for the demo."
  }
}

variable "postgres_engine_version" {
  description = "Amazon RDS for PostgreSQL engine version; keep aligned with local/test PostgreSQL where AWS supports it."
  type        = string
  default     = "18.6"
}

variable "postgres_instance_class" {
  description = "Small Single-AZ DB instance class for the temporary demo."
  type        = string
  default     = "db.t4g.micro"
}

variable "postgres_allocated_storage_gb" {
  description = "Encrypted gp3 storage allocated to the demo database."
  type        = number
  default     = 20

  validation {
    condition     = var.postgres_allocated_storage_gb >= 20
    error_message = "RDS PostgreSQL gp3 storage must be at least 20 GiB."
  }
}

variable "postgres_backup_retention_days" {
  description = "RDS automated backup retention; zero disables backups, one is the minimum enabled retention."
  type        = number
  default     = 1

  validation {
    condition     = var.postgres_backup_retention_days >= 0 && var.postgres_backup_retention_days <= 7
    error_message = "Demo backup retention must be between 0 and 7 days."
  }
}

variable "postgres_deletion_protection" {
  description = "Protect the RDS instance from deletion; disabled by default to keep short-lived demo teardown simple."
  type        = bool
  default     = false
}

variable "postgres_skip_final_snapshot" {
  description = "Skip a final snapshot on destroy. Set false and provide an identifier if demo data must be retained."
  type        = bool
  default     = true
}

variable "postgres_final_snapshot_identifier" {
  description = "Final snapshot identifier required when postgres_skip_final_snapshot is false."
  type        = string
  default     = null
  nullable    = true
}



variable "runtime_image_manifest_commit" {
  description = "Full commit SHA recorded in the verified image manifest used by the demo task definitions."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.runtime_image_manifest_commit))
    error_message = "runtime_image_manifest_commit must be the full 40-character commit SHA from the verified image manifest."
  }
}

variable "runtime_image_digests" {
  description = "Verified image digests copied from the Fase 2C manifest; mutable tags are not accepted."
  type = object({
    api     = string
    worker  = string
    krakend = string
  })

  validation {
    condition = alltrue([
      for digest in values(var.runtime_image_digests) : can(regex("^sha256:[0-9a-f]{64}$", digest))
    ])
    error_message = "Each runtime image reference must be a sha256 digest copied from the verified manifest."
  }
}

variable "ecs_desired_counts" {
  description = "Fargate task counts for the demo runtime."
  type = object({
    krakend = number
    api     = number
    worker  = number
  })
  default = {
    krakend = 1
    api     = 1
    worker  = 1
  }
}

variable "runtime_api_environment" {
  description = "Non-secret production API values supplied from approved deployment configuration; no credentials."
  type        = map(string)
  default     = {}
}

variable "runtime_krakend_environment" {
  description = "Non-secret KrakenD values supplied from approved deployment configuration; no credentials."
  type        = map(string)
  default     = {}
}

variable "ecs_health_check_grace_period_seconds" {
  description = "Grace period for ALB health checks while the KrakenD task starts."
  type        = number
  default     = 60
}
