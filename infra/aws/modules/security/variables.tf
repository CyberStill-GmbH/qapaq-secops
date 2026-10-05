variable "project" {
  type = string
}

variable "environment" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "allowed_admin_cidrs" {
  type = list(string)
}

variable "enable_https" {
  type = bool
}

variable "krakend_port" {
  type = number
}

variable "api_port" {
  type = number
}

variable "postgres_port" {
  type = number
}

variable "redis_port" {
  type = number
}

variable "wazuh_indexer_port" {
  type = number
}

variable "wazuh_dashboard_port" {
  type = number
}
