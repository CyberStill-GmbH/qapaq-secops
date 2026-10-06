variable "project" {
  description = "Project name used in resource names and tags."
  type        = string
}

variable "environment" {
  description = "Environment name used in resource names and tags."
  type        = string
}

variable "account_id" {
  description = "AWS account ID used to make globally unique S3 bucket names."
  type        = string
}

variable "github_repository" {
  description = "GitHub owner/repository allowed to assume the image-publisher role."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must use the owner/repository format."
  }
}

variable "github_repository_owner_id" {
  description = "Immutable GitHub owner ID used in the OIDC subject claim."
  type        = string
}

variable "github_repository_id" {
  description = "Immutable GitHub repository ID used in the OIDC subject claim."
  type        = string
}
