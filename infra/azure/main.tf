locals {
  name_base = substr(replace(lower("${var.project}-${var.environment}"), "-", ""), 0, 18)
  suffix    = substr(sha256("${var.subscription_id}:${var.project}:${var.environment}"), 0, 8)
  storage_name = substr(
    "${substr(replace(lower(var.project), "-", ""), 0, 12)}${var.environment}${local.suffix}",
    0,
    24,
  )
  release_storage_name = substr(
    "${substr(replace(lower(var.project), "-", ""), 0, min(8, length(replace(lower(var.project), "-", ""))))}${var.environment}rel${local.suffix}",
    0,
    24,
  )
  key_vault_name = "kv-${substr(local.name_base, 0, 12)}-${local.suffix}"
  acr_name       = substr("${substr(local.name_base, 0, 44)}${local.suffix}", 0, 50)
}

data "azurerm_resource_group" "this" {
  name = "rg-${local.name_base}-${local.suffix}"
}

module "network" {
  source                      = "./modules/network"
  resource_group_name         = data.azurerm_resource_group.this.name
  location                    = data.azurerm_resource_group.this.location
  name_base                   = local.name_base
  address_space               = var.address_space
  ankay_subnet_address_prefix = var.ankay_host == null ? null : cidrsubnet(var.address_space, 11, 1)
  tags                        = var.tags
}

module "observability" {
  source                   = "./modules/observability"
  resource_group_name      = data.azurerm_resource_group.this.name
  location                 = data.azurerm_resource_group.this.location
  name_base                = local.name_base
  container_apps_subnet_id = module.network.container_apps_subnet_id
  enable_runtime           = var.enable_runtime
  tags                     = var.tags
}

module "data" {
  source                         = "./modules/data"
  resource_group_name            = data.azurerm_resource_group.this.name
  location                       = data.azurerm_resource_group.this.location
  name_base                      = local.name_base
  suffix                         = local.suffix
  storage_name                   = local.storage_name
  release_storage_name           = local.release_storage_name
  key_vault_name                 = local.key_vault_name
  tenant_id                      = var.tenant_id
  postgres_admin_login           = var.postgres_admin_login
  postgres_admin_password        = var.postgres_admin_password
  postgres_sku_name              = var.postgres_sku_name
  postgres_storage_mb            = var.postgres_storage_mb
  postgres_backup_retention_days = var.postgres_backup_retention_days
  postgres_subnet_id             = module.network.postgres_subnet_id
  postgres_private_dns_zone_id   = module.network.postgres_private_dns_zone_id
  private_endpoints_subnet_id    = module.network.private_endpoints_subnet_id
  key_vault_private_dns_zone_id  = module.network.key_vault_private_dns_zone_id
  blob_private_dns_zone_id       = module.network.blob_private_dns_zone_id
  tags                           = var.tags

  depends_on = [module.network]
}

module "identity_registry" {
  source                           = "./modules/identity_registry"
  resource_group_name              = data.azurerm_resource_group.this.name
  location                         = data.azurerm_resource_group.this.location
  name_base                        = local.name_base
  suffix                           = local.suffix
  acr_name                         = local.acr_name
  github_repository                = var.github_repository
  github_owner_id                  = var.github_owner_id
  github_repository_id             = var.github_repository_id
  github_environment               = var.github_environment
  environment                      = var.environment
  key_vault_id                     = module.data.key_vault_id
  raw_container_id                 = module.data.raw_container_id
  siem_release_container_id        = module.data.siem_release_container_id
  legacy_siem_release_container_id = module.data.legacy_siem_release_container_id
  tags                             = var.tags
}

module "runtime" {
  source                                   = "./modules/runtime"
  resource_group_name                      = data.azurerm_resource_group.this.name
  environment                              = var.environment
  name_base                                = local.name_base
  tags                                     = var.tags
  container_images                         = var.container_images
  enable_runtime                           = var.enable_runtime
  key_vault_secret_ids                     = var.key_vault_secret_ids
  container_app_environment_id             = var.enable_runtime ? module.observability.container_app_environment_id : ""
  container_app_environment_default_domain = var.enable_runtime ? module.observability.container_app_environment_default_domain : ""
  runtime_identity_id                      = module.identity_registry.runtime_identity_id
  container_registry_login_server          = module.identity_registry.container_registry_login_server
  postgres_fqdn                            = module.data.postgres_fqdn
  app_database_name                        = module.data.app_database_name
  queue_database_name                      = module.data.queue_database_name

  depends_on = [module.identity_registry, module.data]
}

# Wazuh QAPAQ is a dedicated VM, not one of the generic Container Apps above. Keep it
# disabled until the operator supplies an audited firewall, immutable release bundle,
# approved ingress CIDRs, Key Vault secret references, and a private SSH recovery key.
module "siem_host" {
  count  = var.siem_host == null ? 0 : 1
  source = "./modules/siem_host"

  resource_group_name          = data.azurerm_resource_group.this.name
  location                     = data.azurerm_resource_group.this.location
  name_base                    = local.name_base
  virtual_network_name         = module.network.virtual_network_name
  firewall_private_ip          = try(var.siem_host.firewall_private_ip, "")
  firewall_policy_reference    = try(var.siem_host.firewall_policy_reference, "")
  private_endpoint_subnet_cidr = cidrsubnet(var.address_space, 12, 257)
  postgres_subnet_cidr         = cidrsubnet(var.address_space, 12, 256)
  address_prefix               = try(var.siem_host.address_prefix, "")
  vm_size                      = try(var.siem_host.vm_size, "")
  admin_ssh_public_key         = try(var.siem_host.admin_ssh_public_key, "")
  ubuntu_image_version         = try(var.siem_host.ubuntu_image_version, "")
  data_disk_size_gb            = try(var.siem_host.data_disk_size_gb, 128)
  dashboard_ingress_cidrs      = try(var.siem_host.dashboard_ingress_cidrs, toset([]))
  agent_ingress_cidrs          = try(var.siem_host.agent_ingress_cidrs, toset([]))
  key_vault_id                 = module.data.key_vault_id
  key_vault_uri                = module.data.key_vault_uri
  core_secret_names            = try(var.siem_host.core_secret_names, {})
  wazuh_secret_names           = try(var.siem_host.wazuh_secret_names, {})
  core_environment             = try(var.siem_host.core_environment, {})
  container_registry_id        = module.identity_registry.container_registry_id
  artifact_container_scope_id  = module.data.siem_release_container_id
  evidence_container_scope_id  = module.data.raw_container_id
  bootstrap_bundle_blob_url    = try(var.siem_host.bootstrap_bundle_blob_url, "")
  bootstrap_bundle_sha256      = try(var.siem_host.bootstrap_bundle_sha256, "")
  tags                         = var.tags

  depends_on = [module.network, module.data, module.identity_registry]
}

# Ankay es un host privado de Shuffle separado del SIEM. Su subnet solo existe cuando
# el operador aporta configuración completa, y comparte la UDR de salida al firewall.
module "ankay_host" {
  count  = var.ankay_host == null ? 0 : 1
  source = "./modules/ankay_host"

  resource_group_name             = data.azurerm_resource_group.this.name
  location                        = data.azurerm_resource_group.this.location
  name_base                       = local.name_base
  subnet_id                       = module.network.ankay_subnet_id
  confirm_dedicated_subnet        = true
  private_ip_address              = try(var.ankay_host.private_ip_address, "")
  edge_subnet_cidr                = "${try(module.siem_host[0].private_ip_address, "0.0.0.0")}/32"
  qapaq_api_subnet_cidr           = "${try(module.siem_host[0].private_ip_address, "0.0.0.0")}/32"
  qapaq_api_private_ip            = try(module.siem_host[0].private_ip_address, "0.0.0.0")
  wazuh_manager_private_ip        = try(module.siem_host[0].private_ip_address, "")
  firewall_private_ip             = try(var.ankay_host.firewall_private_ip, "")
  firewall_policy_reference       = try(var.ankay_host.firewall_policy_reference, "")
  admin_ssh_public_key            = try(var.ankay_host.admin_ssh_public_key, "")
  vm_size                         = try(var.ankay_host.vm_size, "")
  ubuntu_image_version            = try(var.ankay_host.ubuntu_image_version, "")
  data_disk_size_gb               = try(var.ankay_host.data_disk_size_gb, 128)
  container_registry_id           = module.identity_registry.container_registry_id
  container_registry_login_server = module.identity_registry.container_registry_login_server
  container_images                = try(var.ankay_host.container_images, {})
  compose_yaml                    = try(var.ankay_host.compose_yaml, "")
  compose_sha256                  = try(var.ankay_host.compose_sha256, "")
  tags                            = var.tags

  depends_on = [module.network, module.identity_registry, module.siem_host]
}
