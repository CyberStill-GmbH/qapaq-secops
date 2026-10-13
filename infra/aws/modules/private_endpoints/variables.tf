variable "project" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "app_subnet_ids" {
  type = list(string)
}

variable "app_route_table_ids" {
  type = list(string)
}

variable "runtime_security_group_ids" {
  description = "Stable names mapped to runtime security group IDs."
  type        = map(string)
}

variable "ecr_image_pull_security_group_ids" {
  description = "Security groups for ECS runtimes that need HTTPS access to ECR image layers in S3."
  type        = map(string)
}
