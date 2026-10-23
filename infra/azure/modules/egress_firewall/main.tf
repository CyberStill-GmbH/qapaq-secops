locals {
  firewall_name = "afw-${var.name_base}"
  policy_name   = "afwp-${var.name_base}"
}

resource "azurerm_public_ip" "firewall" {
  name                = "pip-${var.name_base}-firewall"
  location            = var.location
  resource_group_name = var.resource_group_name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = merge(var.tags, { service = "siem-egress" })
}

resource "azurerm_firewall_policy" "this" {
  name                     = local.policy_name
  location                 = var.location
  resource_group_name      = var.resource_group_name
  sku                      = "Standard"
  threat_intelligence_mode = "Deny"
  dns {
    proxy_enabled = true
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
  sku_tier            = "Standard"
  firewall_policy_id  = azurerm_firewall_policy.this.id
  threat_intel_mode   = "Deny"
  tags                = merge(var.tags, { service = "siem-egress" })

  ip_configuration {
    name                 = "primary"
    subnet_id            = var.firewall_subnet_id
    public_ip_address_id = azurerm_public_ip.firewall.id
  }
}
