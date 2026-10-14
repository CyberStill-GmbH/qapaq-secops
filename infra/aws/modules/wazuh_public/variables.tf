variable "project" { type = string }
variable "environment" { type = string }
variable "region" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_id" { type = string }
variable "public_proxy_security_group_id" { type = string }
variable "wazuh_security_group_id" { type = string }
variable "api_origin" { type = string }
variable "api_tls_server_name" {
  description = "API hostname present in the ALB certificate, used to validate upstream TLS."
  type        = string
}

variable "wazuh_version" {
  description = "Wazuh release installed by the official assisted installer."
  type        = string
}

variable "instance_type" { type = string }
variable "volume_size_gb" { type = number }
