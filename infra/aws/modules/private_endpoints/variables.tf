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
  type = list(string)
}
