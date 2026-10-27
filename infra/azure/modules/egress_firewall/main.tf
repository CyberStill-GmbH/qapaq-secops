locals {
  firewall_name = "afw-${var.name_base}"
  policy_name   = "afwp-${var.name_base}"
  # Basic no admite Threat Intelligence en modo Deny ni DNS proxy: solo alerta, y las reglas
  # de aplicación por FQDN funcionan sin proxy. Standard conserva el bloqueo y el proxy.
  is_basic          = var.sku_tier == "Basic"
  threat_intel_mode = local.is_basic ? "Alert" : "Deny"
}

resource "azurerm_public_ip" "firewall" {
  name                = "pip-${var.name_base}-firewall"
  location            = var.location
  resource_group_name = var.resource_group_name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = merge(var.tags, { service = "siem-egress" })
}

# Basic separa el tráfico de gestión de la plataforma en su propia subnet e IP pública; no
# recibe reglas ni DNAT y Azure la exige para crear el Firewall en ese SKU.
resource "azurerm_public_ip" "management" {
  count               = local.is_basic ? 1 : 0
  name                = "pip-${var.name_base}-firewall-mgmt"
  location            = var.location
  resource_group_name = var.resource_group_name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = merge(var.tags, { service = "siem-egress-management" })
}

resource "azurerm_firewall_policy" "this" {
  name                     = local.policy_name
  location                 = var.location
  resource_group_name      = var.resource_group_name
  sku                      = var.sku_tier
  threat_intelligence_mode = local.threat_intel_mode
  dynamic "dns" {
    for_each = local.is_basic ? [] : [true]
    content {
      proxy_enabled = true
    }
  }
  tags = merge(var.tags, { service = "siem-egress-policy" })
}

resource "azurerm_firewall_policy_rule_collection_group" "egress" {
  name               = "siem-approved-https-egress"
  firewall_policy_id = azurerm_firewall_policy.this.id
  priority           = 100

  application_rule_collection {
    name     = "siem-https-allowlist"
    priority = 100
    action   = "Allow"

    rule {
      name             = "approved-https-destinations"
      source_addresses = sort(tolist(var.source_cidrs))

      protocols {
        type = "Https"
        port = 443
      }

      destination_fqdns = sort(tolist(var.allowed_fqdns))
    }
  }

  dynamic "application_rule_collection" {
    for_each = length(var.container_apps_source_cidrs) == 0 || length(var.container_apps_allowed_fqdns) == 0 ? [] : [true]
    content {
      name     = "private-container-apps-platform-egress"
      priority = 110
      action   = "Allow"

      rule {
        name             = "container-apps-artifact-identity-and-registry"
        source_addresses = sort(tolist(var.container_apps_source_cidrs))

        protocols {
          type = "Https"
          port = 443
        }

        destination_fqdns = sort(tolist(var.container_apps_allowed_fqdns))
      }
    }
  }

  dynamic "network_rule_collection" {
    for_each = length(var.container_apps_source_cidrs) == 0 || length(var.container_apps_allowed_service_tags) == 0 ? [] : [true]
    content {
      name     = "private-container-apps-required-service-tags"
      priority = 120
      action   = "Allow"

      rule {
        name                  = "container-apps-platform-services"
        protocols             = ["TCP"]
        source_addresses      = sort(tolist(var.container_apps_source_cidrs))
        destination_addresses = sort(tolist(var.container_apps_allowed_service_tags))
        destination_ports     = ["443"]
      }
    }
  }

  dynamic "nat_rule_collection" {
    for_each = var.ingress_lb_private_ip == null || (!var.ingress_http_enabled && length(var.dashboard_ingress_cidrs) == 0) ? [] : [true]
    content {
      name     = "qapaq-siem-public-ingress"
      priority = 120
      action   = "Dnat"

      dynamic "rule" {
        for_each = var.ingress_http_enabled ? [true] : []
        content {
          name                = "qapaq-http-acme-and-redirect"
          protocols           = ["TCP"]
          source_addresses    = ["*"]
          destination_address = azurerm_public_ip.firewall.ip_address
          destination_ports   = ["80"]
          translated_address  = var.ingress_lb_private_ip
          translated_port     = "80"
        }
      }

      dynamic "rule" {
        for_each = length(var.dashboard_ingress_cidrs) == 0 ? [] : [true]
        content {
          name                = "qapaq-dashboard-https-approved-sources"
          protocols           = ["TCP"]
          source_addresses    = sort(tolist(var.dashboard_ingress_cidrs))
          destination_address = azurerm_public_ip.firewall.ip_address
          destination_ports   = ["443"]
          translated_address  = var.ingress_lb_private_ip
          translated_port     = "443"
        }
      }
    }
  }
}

resource "azurerm_firewall" "this" {
  name                = local.firewall_name
  location            = var.location
  resource_group_name = var.resource_group_name
  sku_name            = "AZFW_VNet"
  sku_tier            = var.sku_tier
  firewall_policy_id  = azurerm_firewall_policy.this.id
  threat_intel_mode   = local.threat_intel_mode
  tags                = merge(var.tags, { service = "siem-egress" })

  ip_configuration {
    name                 = "primary"
    subnet_id            = var.firewall_subnet_id
    public_ip_address_id = azurerm_public_ip.firewall.id
  }

  dynamic "management_ip_configuration" {
    for_each = local.is_basic ? [true] : []
    content {
      name                 = "management"
      subnet_id            = var.management_subnet_id
      public_ip_address_id = azurerm_public_ip.management[0].id
    }
  }

  lifecycle {
    precondition {
      condition     = !local.is_basic || var.management_subnet_id != null
      error_message = "Azure Firewall Basic requiere AzureFirewallManagementSubnet."
    }
  }
}

# DNAT SNATea al peer del backend; conservar la IP original de analistas requiere
# consultar los eventos NAT del Firewall. Resource-specific evita mezclarlos con
# índices de alertas/archivos de Wazuh.
resource "azurerm_monitor_diagnostic_setting" "nat_ingress" {
  name                           = "diag-${var.name_base}-firewall-nat"
  target_resource_id             = azurerm_firewall.this.id
  log_analytics_workspace_id     = var.log_analytics_workspace_id
  log_analytics_destination_type = "Dedicated"

  enabled_log {
    category = "AZFWNatRule"
  }
}
