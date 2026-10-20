variable "resource_group_name" { type = string }
variable "location" { type = string }
variable "name_base" { type = string }
variable "suffix" { type = string }
variable "storage_name" { type = string }
variable "key_vault_name" { type = string }
variable "tenant_id" { type = string }
variable "postgres_admin_login" { type = string }
variable "postgres_admin_password" {
  type      = string
  sensitive = true
}
variable "postgres_sku_name" { type = string }
variable "postgres_storage_mb" { type = number }
variable "postgres_backup_retention_days" { type = number }
variable "postgres_subnet_id" { type = string }
variable "postgres_private_dns_zone_id" { type = string }
variable "private_endpoints_subnet_id" { type = string }
variable "key_vault_private_dns_zone_id" { type = string }
variable "blob_private_dns_zone_id" { type = string }
variable "tags" { type = map(string) }
