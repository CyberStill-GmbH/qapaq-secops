locals {
  name        = "${var.name_base}-krakend"
  environment = "cae-${var.name_base}-krakend"
  secret_names = {
    wazuh-basic-auth-b64 = var.indexer_reader_secret_name
    wazuh-indexer-ca-pem = var.indexer_proxy_ca_secret_name
  }
  # Core requests tokens with the v2 token endpoint, but QAPAQ's existing app
  # registration issues v1 access-token issuer claims (same contract as AWS).
  issuer         = "https://sts.windows.net/${var.tenant_id}/"
  jwks_url       = "https://login.microsoftonline.com/${var.tenant_id}/discovery/v2.0/keys"
  audience       = trimsuffix(var.client_scope, "/.default")
  core_client_id = var.core_client_id
}

resource "azurerm_route_table" "this" {
  name                          = "rt-${local.name}"
  location                      = var.location
  resource_group_name           = var.resource_group_name
  bgp_route_propagation_enabled = false
  tags                          = merge(var.tags, { service = "krakend-egress" })

  route {
    name                   = "force-egress-through-firewall"
    address_prefix         = "0.0.0.0/0"
    next_hop_type          = "VirtualAppliance"
    next_hop_in_ip_address = var.firewall_private_ip
  }
}

resource "azurerm_subnet_route_table_association" "this" {
  subnet_id      = var.subnet_id
  route_table_id = azurerm_route_table.this.id
}

resource "azurerm_user_assigned_identity" "this" {
  name                = "id-${local.name}"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = merge(var.tags, { service = "krakend" })
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = var.container_registry_id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.this.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "key_vault_secret_read" {
  for_each = toset(values(local.secret_names))

  scope                = "${trimsuffix(var.key_vault_id, "/")}/secrets/${each.value}"
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.this.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_container_app_environment" "this" {
  name                           = local.environment
  location                       = var.location
  resource_group_name            = var.resource_group_name
  log_analytics_workspace_id     = var.log_analytics_workspace_id
  infrastructure_subnet_id       = var.subnet_id
  internal_load_balancer_enabled = true
  public_network_access          = "Disabled"
  zone_redundancy_enabled        = false
  tags                           = merge(var.tags, { service = "krakend-environment" })

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
    minimum_count         = 0
    maximum_count         = 0
  }
}

resource "azurerm_private_dns_zone" "this" {
  name                = azurerm_container_app_environment.this.default_domain
  resource_group_name = var.resource_group_name
  tags                = merge(var.tags, { service = "krakend-private-dns" })
}

resource "azurerm_private_dns_zone_virtual_network_link" "this" {
  name                  = "${local.name}-vnet"
  resource_group_name   = var.resource_group_name
  private_dns_zone_name = azurerm_private_dns_zone.this.name
  virtual_network_id    = var.virtual_network_id
  registration_enabled  = false
  tags                  = merge(var.tags, { service = "krakend-private-dns" })
}

resource "azurerm_private_dns_a_record" "wildcard" {
  name                = "*"
  zone_name           = azurerm_private_dns_zone.this.name
  resource_group_name = var.resource_group_name
  ttl                 = 300
  records             = [azurerm_container_app_environment.this.static_ip_address]
  tags                = merge(var.tags, { service = "krakend-private-dns" })
}

resource "azurerm_container_app" "this" {
  name                         = local.name
  resource_group_name          = var.resource_group_name
  container_app_environment_id = azurerm_container_app_environment.this.id
  revision_mode                = "Single"
  tags                         = merge(var.tags, { service = "krakend-gateway" })

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.this.id]
  }

  registry {
    server   = var.container_registry_login_server
    identity = azurerm_user_assigned_identity.this.id
  }

  dynamic "secret" {
    for_each = local.secret_names
    content {
      name                = secret.key
      key_vault_secret_id = "${trimsuffix(var.key_vault_uri, "/")}/secrets/${secret.value}"
      identity            = azurerm_user_assigned_identity.this.id
    }
  }

  template {
    min_replicas = 2
    max_replicas = 4

    container {
      name   = "krakend"
      image  = var.image
      cpu    = 0.5
      memory = "1Gi"
      args   = ["run", "-c", "/etc/krakend/krakend-azure-ingestion.tmpl"]

      env {
        name  = "GATEWAY_ENDPOINT_TIMEOUT"
        value = "4s"
      }
      env {
        name  = "GATEWAY_METRICS_PORT"
        value = "9091"
      }
      env {
        name  = "GATEWAY_RATE_PER_SECOND"
        value = "20"
      }
      env {
        name  = "GATEWAY_RATE_BURST"
        value = "40"
      }
      env {
        name  = "OIDC_DISABLE_JWK_SECURITY"
        value = "false"
      }
      env {
        name  = "OIDC_ISSUER"
        value = local.issuer
      }
      env {
        name  = "OIDC_JWKS_URL"
        value = local.jwks_url
      }
      env {
        name  = "OIDC_AUDIENCE"
        value = local.audience
      }
      env {
        name  = "QAPAQ_CORE_CLIENT_ID"
        value = local.core_client_id
      }
      env {
        name  = "WAZUH_INDEXER_URL"
        value = "https://${var.siem_indexer_proxy_ip}:9200"
      }
      env {
        name  = "WAZUH_INDEXER_CA_FILE"
        value = "/tmp/qapaq/indexer-ca.pem"
      }
      env {
        name  = "WAZUH_INDEX_PATTERN"
        value = "wazuh-alerts-*"
      }

      env {
        name        = "WAZUH_BASIC_AUTH_B64"
        secret_name = "wazuh-basic-auth-b64"
      }
      env {
        name        = "WAZUH_INDEXER_CA_PEM"
        secret_name = "wazuh-indexer-ca-pem"
      }

      startup_probe {
        transport               = "TCP"
        port                    = 8080
        initial_delay           = 1
        interval_seconds        = 1
        timeout                 = 3
        failure_count_threshold = 30
      }

      liveness_probe {
        transport               = "TCP"
        port                    = 8080
        initial_delay           = 3
        interval_seconds        = 10
        timeout                 = 5
        failure_count_threshold = 3
      }

      readiness_probe {
        transport               = "TCP"
        port                    = 8080
        initial_delay           = 3
        interval_seconds        = 5
        timeout                 = 5
        failure_count_threshold = 3
      }
    }
  }

  ingress {
    external_enabled           = true
    target_port                = 8080
    transport                  = "http"
    allow_insecure_connections = false

    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  depends_on = [
    azurerm_role_assignment.acr_pull,
    azurerm_role_assignment.key_vault_secret_read,
    azurerm_private_dns_a_record.wildcard,
  ]
}
