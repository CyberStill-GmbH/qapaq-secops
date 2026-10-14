variable "project" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "security_group_id" {
  type = string
}

variable "node_type" {
  type = string
}

variable "engine_version" {
  type = string
}

variable "replica_count" {
  description = "Replica nodes in addition to the primary; one or more enables Multi-AZ automatic failover."
  type        = number

  validation {
    condition     = var.replica_count >= 1 && var.replica_count <= 5 && floor(var.replica_count) == var.replica_count
    error_message = "replica_count must be a whole number from 1 to 5."
  }
}
