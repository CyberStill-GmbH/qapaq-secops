locals {
  name_base           = substr(replace(lower("${var.project}-${var.environment}"), "-", ""), 0, 18)
  suffix              = substr(sha256("${var.subscription_id}:${var.project}:${var.environment}"), 0, 8)
  compact_environment = replace(lower(var.environment), "-", "")
  compact_project     = replace(lower(var.project), "-", "")
  storage_name = substr(
    "${substr(local.compact_project, 0, min(12, 24 - length(local.compact_environment) - length(local.suffix)))}${local.compact_environment}${local.suffix}",
    0,
    24,
  )
  release_storage_name = substr(
    "${substr(local.compact_project, 0, min(8, 24 - length(local.compact_environment) - length("rel") - length(local.suffix)))}${local.compact_environment}rel${local.suffix}",
    0,
    24,
  )
  key_vault_name          = "kv-${substr(local.name_base, 0, 12)}-${local.suffix}"
  acr_name                = substr("${substr(local.name_base, 0, 44)}${local.suffix}", 0, 50)
  siem_ingress_private_ip = var.siem_host == null ? null : cidrhost(var.siem_host.address_prefix, 10)
  krakend_subnet_cidr     = var.krakend_gateway == null ? null : cidrsubnet(var.address_space, 11, 2)
  provider_egress_fqdns = var.siem_host == null ? toset([]) : toset(concat(
    try(var.siem_host.provider_ingestion["sophos_enabled"], "false") == "true" ? [
      "id.sophos.com",
      "api.central.sophos.com",
      "api-${var.siem_host.provider_ingestion["sophos_data_region"]}.central.sophos.com",
    ] : [],
    try(var.siem_host.provider_ingestion["cato_enabled"], "false") == "true" ? ["api.catonetworks.com"] : [],
  ))
}

# KrakenD's private Indexer reader is bootstrapped by the SIEM VM. The role is
# opt-in, scoped to this resource group for definition/assignability, and later
# assigned only to the two pre-existing Key Vault secret resource IDs.
locals {
  indexer_proxy_secret_role_id = uuidv5(
    "url",
    "${data.azurerm_resource_group.this.id}:qapaq:indexer-proxy-secret-seed",
  )
}

data "azurerm_resource_group" "this" {
  name = "rg-${local.name_base}-${local.suffix}"
}

module "network" {
  source                        = "./modules/network"
  resource_group_name           = data.azurerm_resource_group.this.name
  location                      = data.azurerm_resource_group.this.location
  name_base                     = local.name_base
  address_space                 = var.address_space
  ankay_subnet_address_prefix   = var.ankay_host == null ? null : cidrsubnet(var.address_space, 11, 1)
  krakend_subnet_address_prefix = local.krakend_subnet_cidr
  enable_siem_firewall          = var.siem_host != null
  tags                          = var.tags
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
  additional_github_environments   = var.additional_github_environments
  environment                      = var.environment
  key_vault_id                     = module.data.key_vault_id
  raw_container_id                 = module.data.raw_container_id
  siem_release_container_id        = module.data.siem_release_container_id
  legacy_siem_release_container_id = module.data.legacy_siem_release_container_id
  tags                             = var.tags
}

# The approved EUS2 seed workflow uses a dedicated identity. It is intentionally
# separate from the Terraform and artifact-publisher identities, and only receives
# the control-plane permissions needed by the create-only secret workflow.
module "key_vault_seed_identity" {
  count  = var.environment == "demo-eus2" ? 1 : 0
  source = "./modules/key_vault_seed_identity"

  resource_group_id   = data.azurerm_resource_group.this.id
  resource_group_name = data.azurerm_resource_group.this.name
  location            = data.azurerm_resource_group.this.location
  name_base           = local.name_base
  key_vault_id        = module.data.key_vault_id
  tags                = var.tags

  depends_on = [module.data]
}

resource "azurerm_role_definition" "indexer_proxy_secret_seed" {
  count = var.krakend_gateway == null ? 0 : 1

  role_definition_id = local.indexer_proxy_secret_role_id
  name               = "QAPAQ ${var.environment} Indexer Proxy Secret Seed"
  scope              = data.azurerm_resource_group.this.id
  description        = "QAPAQ SIEM bootstrap may get/set exactly two pre-created Key Vault secrets for the opt-in read-only Indexer proxy."

  permissions {
    actions = []
    data_actions = [
      "Microsoft.KeyVault/vaults/secrets/getSecret/action",
      "Microsoft.KeyVault/vaults/secrets/setSecret/action",
    ]
    not_actions      = []
    not_data_actions = []
  }

  assignable_scopes = [data.azurerm_resource_group.this.id]
}

# Azure networking is provisioned with its own egress firewall. The SIEM VM no longer
# depends on an AWS-era or manually pre-existing firewall/policy reference.
module "egress_firewall" {
  count  = var.siem_host == null ? 0 : 1
  source = "./modules/egress_firewall"

  resource_group_name        = data.azurerm_resource_group.this.name
  location                   = data.azurerm_resource_group.this.location
  name_base                  = local.name_base
  firewall_subnet_id         = module.network.firewall_subnet_id
  log_analytics_workspace_id = module.observability.log_analytics_workspace_id
  source_cidrs = toset(concat(
    [var.siem_host.address_prefix],
    var.ankay_host == null ? [] : [cidrsubnet(var.address_space, 11, 1)],
  ))
  container_apps_source_cidrs = local.krakend_subnet_cidr == null ? toset([]) : toset([local.krakend_subnet_cidr])
  container_apps_allowed_fqdns = var.krakend_gateway == null ? toset([]) : toset([
    "mcr.microsoft.com",
    "*.data.mcr.microsoft.com",
    "packages.aks.azure.com",
    "acs-mirror.azureedge.net",
    module.identity_registry.container_registry_login_server,
    "*.blob.core.windows.net",
    "login.microsoft.com",
    "login.microsoftonline.com",
    "*.login.microsoftonline.com",
    "*.login.microsoft.com",
    "*.identity.azure.net",
  ])
  container_apps_allowed_service_tags = var.krakend_gateway == null ? toset([]) : toset([
    "MicrosoftContainerRegistry",
    "AzureFrontDoorFirstParty",
    "AzureContainerRegistry",
    "AzureActiveDirectory",
    "AzureKeyVault",
  ])
  ingress_lb_private_ip   = local.siem_ingress_private_ip
  dashboard_ingress_cidrs = var.siem_host == null ? toset([]) : var.siem_host.dashboard_ingress_cidrs
  allowed_fqdns = setunion(toset([
    "archive.ubuntu.com",
    "azure.archive.ubuntu.com",
    "graph.microsoft.com",
    "login.microsoftonline.com",
    "packages.microsoft.com",
    "*.logic.azure.com",
    "*.api.powerplatform.com",
    "security.ubuntu.com",
    format("%s.virustotal.com", "api"),
    "acme-v02.api.letsencrypt.org",
    ]), local.provider_egress_fqdns, var.ankay_host == null ? toset([]) : toset([
    "download.docker.com",
    module.identity_registry.container_registry_login_server,
    "azurecr.io",
    "*.blob.core.windows.net",
  ]))
  ingress_http_enabled = var.siem_host != null
  tags                 = var.tags

  depends_on = [module.network]
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
  firewall_private_ip          = try(module.egress_firewall[0].private_ip_address, "")
  firewall_policy_reference    = try(module.egress_firewall[0].policy_id, "")
  private_endpoint_subnet_cidr = cidrsubnet(var.address_space, 12, 257)
  postgres_subnet_cidr         = cidrsubnet(var.address_space, 12, 256)
  address_prefix               = try(var.siem_host.address_prefix, "")
  private_ip_address           = try(var.siem_host.private_ip_address, null)
  ingress_lb_private_ip        = try(local.siem_ingress_private_ip, "")
  vm_size                      = try(var.siem_host.vm_size, "")
  admin_ssh_public_key         = try(var.siem_host.admin_ssh_public_key, "")
  ubuntu_image_version         = try(var.siem_host.ubuntu_image_version, "")
  data_disk_size_gb            = try(var.siem_host.data_disk_size_gb, 128)
  dashboard_ingress_cidrs      = try(var.siem_host.dashboard_ingress_cidrs, toset([]))
  ingress_http_enabled         = true
  agent_ingress_cidrs          = try(var.siem_host.agent_ingress_cidrs, toset([]))
  krakend_source_cidrs         = local.krakend_subnet_cidr == null ? toset([]) : toset([local.krakend_subnet_cidr])
  key_vault_id                 = module.data.key_vault_id
  key_vault_uri                = module.data.key_vault_uri
  core_secret_names            = try(var.siem_host.core_secret_names, {})
  wazuh_secret_names           = try(var.siem_host.wazuh_secret_names, {})
  indexer_proxy = var.krakend_gateway == null ? null : {
    reader_secret_name   = var.krakend_gateway.indexer_reader_secret_name
    proxy_ca_secret_name = var.krakend_gateway.indexer_proxy_ca_secret_name
  }
  indexer_proxy_secret_role_definition_id = var.krakend_gateway == null ? null : azurerm_role_definition.indexer_proxy_secret_seed[0].role_definition_resource_id
  core_environment = merge(
    try(var.siem_host.core_environment, {}),
    var.krakend_gateway == null ? {} : {
      QAPAQ_INGESTION_SOURCE        = "wazuh"
      QAPAQ_WAZUH_GATEWAY_BASE_URL  = module.krakend_gateway[0].gateway_base_url
      QAPAQ_INGESTION_GATEWAY_SCOPE = var.krakend_gateway.client_scope
    },
  )
  office365                   = try(var.siem_host.office365, null)
  provider_ingestion          = try(var.siem_host.provider_ingestion, {})
  container_registry_id       = module.identity_registry.container_registry_id
  artifact_container_scope_id = module.data.siem_release_container_id
  evidence_container_scope_id = module.data.raw_container_id
  bootstrap_bundle_blob_url   = try(var.siem_host.bootstrap_bundle_blob_url, "")
  bootstrap_bundle_sha256     = try(var.siem_host.bootstrap_bundle_sha256, "")
  tags                        = var.tags

  depends_on = [module.network, module.data, module.identity_registry]
}

# Optional private ingestion gateway. It publishes exactly the two Wazuh read routes
# consumed by Core and is absent unless the operator supplies a pinned ACR digest and
# existing Key Vault references in var.krakend_gateway.
module "krakend_gateway" {
  count  = var.krakend_gateway == null ? 0 : 1
  source = "./modules/krakend_gateway"

  resource_group_name             = data.azurerm_resource_group.this.name
  location                        = data.azurerm_resource_group.this.location
  name_base                       = local.name_base
  tags                            = var.tags
  virtual_network_id              = module.network.virtual_network_id
  subnet_id                       = module.network.krakend_subnet_id
  subnet_cidr                     = local.krakend_subnet_cidr
  siem_indexer_proxy_ip           = try(var.siem_host.private_ip_address, "")
  firewall_private_ip             = try(module.egress_firewall[0].private_ip_address, "")
  log_analytics_workspace_id      = module.observability.log_analytics_workspace_id
  container_registry_id           = module.identity_registry.container_registry_id
  container_registry_login_server = module.identity_registry.container_registry_login_server
  key_vault_id                    = module.data.key_vault_id
  key_vault_uri                   = module.data.key_vault_uri
  image                           = var.krakend_gateway.image
  tenant_id                       = var.krakend_gateway.tenant_id
  client_scope                    = var.krakend_gateway.client_scope
  core_client_id                  = var.krakend_gateway.core_client_id
  indexer_reader_secret_name      = var.krakend_gateway.indexer_reader_secret_name
  indexer_proxy_ca_secret_name    = var.krakend_gateway.indexer_proxy_ca_secret_name
  siem_bootstrap_extension_id     = module.siem_host[0].bootstrap_extension_id

  depends_on = [module.egress_firewall, module.identity_registry, module.data]
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
  firewall_private_ip             = try(module.egress_firewall[0].private_ip_address, "")
  firewall_policy_reference       = try(module.egress_firewall[0].policy_id, "")
  admin_ssh_public_key            = try(var.ankay_host.admin_ssh_public_key, "")
  vm_size                         = try(var.ankay_host.vm_size, "")
  ubuntu_image_version            = try(var.ankay_host.ubuntu_image_version, "")
  data_disk_size_gb               = try(var.ankay_host.data_disk_size_gb, 128)
  container_registry_id           = module.identity_registry.container_registry_id
  container_registry_login_server = module.identity_registry.container_registry_login_server
  container_images                = try(var.ankay_host.container_images, {})
  compose_yaml                    = try(var.ankay_host.compose_yaml, "")
  compose_sha256                  = try(var.ankay_host.compose_sha256, "")
  key_vault_id                    = module.data.key_vault_id
  key_vault_uri                   = module.data.key_vault_uri
  key_vault_private_ip            = module.data.key_vault_private_ip
  secret_names                    = try(var.ankay_host.secret_names, {})
  docker_package_versions         = try(var.ankay_host.docker_package_versions, {})
  tags                            = var.tags

  depends_on = [module.network, module.identity_registry, module.egress_firewall, module.siem_host]
}
