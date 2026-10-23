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
