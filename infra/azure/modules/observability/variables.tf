variable "resource_group_name" { type = string }
variable "location" { type = string }
variable "name_base" { type = string }
variable "container_apps_subnet_id" { type = string }
variable "tags" { type = map(string) }
variable "enable_runtime" {
  description = "Create a Container Apps Environment only when its runtime is enabled."
  type        = bool
  default     = false
}
