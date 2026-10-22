resource "azurerm_postgresql_flexible_server" "this" {
  name                          = "psql-${var.name_base}-${var.suffix}"
  resource_group_name           = var.resource_group_name
  location                      = var.location
  version                       = "16"
  zone                          = "1"
  administrator_login           = var.postgres_admin_login
  administrator_password        = var.postgres_admin_password
  sku_name                      = var.postgres_sku_name
  storage_mb                    = var.postgres_storage_mb
  backup_retention_days         = var.postgres_backup_retention_days
  geo_redundant_backup_enabled  = false
  public_network_access_enabled = false
  delegated_subnet_id           = var.postgres_subnet_id
  private_dns_zone_id           = var.postgres_private_dns_zone_id
  tags                          = var.tags

  authentication {
    active_directory_auth_enabled = false
    password_auth_enabled         = true
  }


  lifecycle {
    prevent_destroy = true
  }
}


resource "azurerm_postgresql_flexible_server_database" "app" {
  name      = "qapaq_secops"
  server_id = azurerm_postgresql_flexible_server.this.id
  collation = "en_US.utf8"
  charset   = "UTF8"

  lifecycle {
    prevent_destroy = true
  }
}


resource "azurerm_postgresql_flexible_server_database" "queue" {
  name      = "qapaq_jobs"
  server_id = azurerm_postgresql_flexible_server.this.id
  collation = "en_US.utf8"
  charset   = "UTF8"

  lifecycle {
    prevent_destroy = true
  }
}


resource "azurerm_storage_account" "evidence" {
  name                              = var.storage_name
  resource_group_name               = var.resource_group_name
  location                          = var.location
  account_tier                      = "Standard"
  account_replication_type          = "ZRS"
  account_kind                      = "StorageV2"
  min_tls_version                   = "TLS1_2"
  https_traffic_only_enabled        = true
  public_network_access_enabled     = false
  shared_access_key_enabled         = false
  default_to_oauth_authentication   = true
  allow_nested_items_to_be_public   = false
  infrastructure_encryption_enabled = true
  tags                              = var.tags

  network_rules {
    default_action = "Deny"
    bypass         = ["AzureServices"]
  }

  blob_properties {
    versioning_enabled = true
    delete_retention_policy {
      days = 30
    }
    container_delete_retention_policy {
      days = 30
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}


resource "azurerm_storage_container" "raw" {
  name                  = "security-event-raw"
  storage_account_id    = azurerm_storage_account.evidence.id
  container_access_type = "private"

  lifecycle {
    prevent_destroy = true
  }
}

# Separado de los eventos crudos para que la identidad de la VM SIEM solo lea artefactos
# versionados del release y no obtenga acceso a la evidencia SOC.
resource "azurerm_storage_container" "siem_release" {
  name                  = "siem-release"
  storage_account_id    = azurerm_storage_account.evidence.id
  container_access_type = "private"

  lifecycle {
    prevent_destroy = true
  }
}

# Excepción temporal: CI publica bundles no confidenciales por OIDC desde runners
# GitHub-hosted con egress dinámico. El endpoint exige Entra/RBAC; no hay claves
# compartidas ni acceso anónimo. Reemplazar por runner privado antes del vencimiento.
#trivy:ignore:AZU-0012:exp:2026-11-20
resource "azurerm_storage_account" "siem_release" {
  name                              = var.release_storage_name
  resource_group_name               = var.resource_group_name
  location                          = var.location
  account_tier                      = "Standard"
  account_replication_type          = "LRS"
  account_kind                      = "StorageV2"
  min_tls_version                   = "TLS1_2"
  https_traffic_only_enabled        = true
  public_network_access_enabled     = true
  shared_access_key_enabled         = false
  default_to_oauth_authentication   = true
  allow_nested_items_to_be_public   = false
  infrastructure_encryption_enabled = true
  tags                              = merge(var.tags, { data_role = "siem-release-artifacts" })

  blob_properties {
    versioning_enabled = true
    delete_retention_policy {
      days = 30
    }
    container_delete_retention_policy {
      days = 30
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container" "siem_release_public" {
  name                  = "siem-release"
  storage_account_id    = azurerm_storage_account.siem_release.id
  container_access_type = "private"

  lifecycle {
    prevent_destroy = true
  }
}


resource "azurerm_private_endpoint" "key_vault" {
  name                = "pe-${var.name_base}-vault"
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = var.private_endpoints_subnet_id
  tags                = var.tags

  private_service_connection {
    name                           = "vault-connection"
    private_connection_resource_id = azurerm_key_vault.this.id
    is_manual_connection           = false
    subresource_names              = ["vault"]
  }

  private_dns_zone_group {
    name                 = "vault-dns"
    private_dns_zone_ids = [var.key_vault_private_dns_zone_id]
  }
}


resource "azurerm_private_endpoint" "blob" {
  name                = "pe-${var.name_base}-blob"
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = var.private_endpoints_subnet_id
  tags                = var.tags

  private_service_connection {
    name                           = "blob-connection"
    private_connection_resource_id = azurerm_storage_account.evidence.id
    is_manual_connection           = false
    subresource_names              = ["blob"]
  }

  private_dns_zone_group {
    name                 = "blob-dns"
    private_dns_zone_ids = [var.blob_private_dns_zone_id]
  }
}

resource "azurerm_private_endpoint" "siem_release_blob" {
  name                = "pe-${var.name_base}-release-blob"
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = var.private_endpoints_subnet_id
  tags                = var.tags

  private_service_connection {
    name                           = "siem-release-blob-connection"
    private_connection_resource_id = azurerm_storage_account.siem_release.id
    is_manual_connection           = false
    subresource_names              = ["blob"]
  }

  private_dns_zone_group {
    name                 = "siem-release-blob-dns"
    private_dns_zone_ids = [var.blob_private_dns_zone_id]
  }
}


resource "azurerm_key_vault" "this" {
  name                          = var.key_vault_name
  location                      = var.location
  resource_group_name           = var.resource_group_name
  tenant_id                     = var.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = true
  soft_delete_retention_days    = 90
  public_network_access_enabled = false
  tags                          = var.tags

  network_acls {
    default_action = "Deny"
    bypass         = "None"
  }

  lifecycle {
    prevent_destroy = true
  }
}
