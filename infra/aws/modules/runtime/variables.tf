variable "project" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "account_id" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "app_subnet_ids" {
  type = list(string)
}

variable "app_route_table_id" {
  type = string
}

variable "security_group_ids" {
  type = map(string)
}

variable "enable_https" {
  type = bool
}

variable "alb_certificate_arn" {
  type = string
}

variable "image_digests" {
  description = "Immutable SHA-256 digests from the verified image manifest."
  type        = map(string)

  validation {
    condition = alltrue([
      for digest in values(var.image_digests) : can(regex("^sha256:[0-9a-f]{64}$", digest))
    ])
    error_message = "Every runtime image must use a sha256 digest from the verified image manifest."
  }
}

variable "image_manifest_commit" {
  description = "Full source SHA whose verified image manifest supplied these immutable digests."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.image_manifest_commit))
    error_message = "image_manifest_commit must be the full SHA recorded in the verified image manifest."
  }
}

variable "desired_counts" {
  type = map(number)

  validation {
    condition     = alltrue([for count in values(var.desired_counts) : count >= 0 && floor(count) == count])
    error_message = "Desired service counts must be non-negative whole numbers."
  }
}

variable "api_environment" {
  description = "Approved non-secret production API environment values. Do not put secret values here."
  type        = map(string)
  default     = {}
}

variable "krakend_environment" {
  description = "Approved non-secret KrakenD runtime values. Secret values are not accepted here."
  type        = map(string)
  default     = {}
}

variable "health_check_grace_period_seconds" {
  type    = number
  default = 60
}
