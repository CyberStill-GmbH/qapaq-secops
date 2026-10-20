locals {
  name_base = substr(replace(lower("${var.project}-${var.environment}"), "-", ""), 0, 18)
  suffix    = substr(sha256("${var.subscription_id}:${var.project}:${var.environment}"), 0, 8)
  storage_name = substr(
    "${substr(replace(lower(var.project), "-", ""), 0, 12)}${var.environment}${local.suffix}",
    0,
    24,
  )
  key_vault_name = "kv-${substr(local.name_base, 0, 12)}-${local.suffix}"
  acr_name       = substr("${substr(local.name_base, 0, 44)}${local.suffix}", 0, 50)
}

resource "azurerm_resource_group" "this" {
  name     = "rg-${local.name_base}-${local.suffix}"
  location = var.location
  tags     = var.tags
}

module "network" {
  source              = "./modules/network"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  name_base           = local.name_base
  address_space       = var.address_space
  tags                = var.tags
}

module "observability" {
  source                   = "./modules/observability"
  resource_group_name      = azurerm_resource_group.this.name
  location                 = azurerm_resource_group.this.location
  name_base                = local.name_base
  container_apps_subnet_id = module.network.container_apps_subnet_id
  tags                     = var.tags
}

module "data" {
  source                         = "./modules/data"
  resource_group_name            = azurerm_resource_group.this.name
  location                       = azurerm_resource_group.this.location
  name_base                      = local.name_base
  suffix                         = local.suffix
  storage_name                   = local.storage_name
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
  source              = "./modules/identity_registry"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  name_base           = local.name_base
  suffix              = local.suffix
  acr_name            = local.acr_name
  github_repository   = var.github_repository
  github_environment  = var.github_environment
  environment         = var.environment
  key_vault_id        = module.data.key_vault_id
  storage_account_id  = module.data.storage_account_id
  tags                = var.tags
}

module "runtime" {
  source                                   = "./modules/runtime"
  resource_group_name                      = azurerm_resource_group.this.name
  environment                              = var.environment
  name_base                                = local.name_base
  tags                                     = var.tags
  container_images                         = var.container_images
  enable_runtime                           = var.enable_runtime
  key_vault_secret_ids                     = var.key_vault_secret_ids
  container_app_environment_id             = module.observability.container_app_environment_id
  container_app_environment_default_domain = module.observability.container_app_environment_default_domain
  runtime_identity_id                      = module.identity_registry.runtime_identity_id
  container_registry_login_server          = module.identity_registry.container_registry_login_server
  postgres_fqdn                            = module.data.postgres_fqdn
  app_database_name                        = module.data.app_database_name
  queue_database_name                      = module.data.queue_database_name

  depends_on = [module.identity_registry, module.data]
}
