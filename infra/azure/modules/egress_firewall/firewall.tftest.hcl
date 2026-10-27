mock_provider "azurerm" {}

run "standard_egress_policy_is_restrictive" {
  command = plan

  variables {
    resource_group_name        = "rg-qapaq-test"
    location                   = "chilecentral"
    name_base                  = "qapaqsecops"
    firewall_subnet_id         = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-qapaq-test/providers/Microsoft.Network/virtualNetworks/vnet-qapaq/subnets/AzureFirewallSubnet"
    log_analytics_workspace_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-qapaq-test/providers/Microsoft.OperationalInsights/workspaces/law-qapaq"
    source_cidrs               = ["10.80.16.0/27"]
    ingress_lb_private_ip      = "10.80.16.10"
    dashboard_ingress_cidrs    = ["198.51.100.25/32"]
    sku_tier                   = "Standard"
    tags                       = { project = "qapaq-secops", environment = "test" }
  }

  assert {
    condition     = azurerm_firewall.this.sku_tier == "Standard" && azurerm_firewall.this.threat_intel_mode == "Deny"
    error_message = "The managed egress firewall must use Standard SKU with threat-intelligence deny mode."
  }

  assert {
    condition     = azurerm_firewall_policy.this.dns[0].proxy_enabled
    error_message = "The firewall policy must enable DNS proxy for FQDN application rules."
  }

  assert {
    condition     = contains(azurerm_firewall_policy_rule_collection_group.egress.application_rule_collection[0].rule[0].destination_fqdns, "graph.microsoft.com")
    error_message = "The default allowlist must include Microsoft Graph for the M365 connector."
  }

  assert {
    condition = (
      contains(azurerm_firewall_policy_rule_collection_group.egress.application_rule_collection[0].rule[0].destination_fqdns, "*.logic.azure.com") &&
      contains(azurerm_firewall_policy_rule_collection_group.egress.application_rule_collection[0].rule[0].destination_fqdns, "*.api.powerplatform.com")
    )
    error_message = "The default allowlist must permit HTTPS egress to current Teams Workflows endpoints."
  }

  assert {
    condition = (
      length(azurerm_firewall_policy_rule_collection_group.egress.nat_rule_collection) == 1 &&
      length(azurerm_firewall_policy_rule_collection_group.egress.nat_rule_collection[0].rule) == 2 &&
      contains(azurerm_firewall_policy_rule_collection_group.egress.nat_rule_collection[0].rule[*].destination_ports[0], "443")
    )
    error_message = "Public SIEM ingress must DNAT only HTTP ACME and approved-source HTTPS to the internal load balancer."
  }

  assert {
    condition     = contains([for log in azurerm_monitor_diagnostic_setting.nat_ingress.enabled_log : log.category], "AZFWNatRule") && azurerm_monitor_diagnostic_setting.nat_ingress.log_analytics_destination_type == "Dedicated"
    error_message = "Azure Firewall DNAT logs must be exported to a dedicated resource-specific Log Analytics table for client IP attribution."
  }
}

run "basic_egress_keeps_fqdn_allowlist_and_management_plane" {
  command = plan

  variables {
    resource_group_name        = "rg-qapaq-test"
    location                   = "eastus2"
    name_base                  = "qapaqsecops"
    firewall_subnet_id         = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-qapaq-test/providers/Microsoft.Network/virtualNetworks/vnet-qapaq/subnets/AzureFirewallSubnet"
    management_subnet_id       = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-qapaq-test/providers/Microsoft.Network/virtualNetworks/vnet-qapaq/subnets/AzureFirewallManagementSubnet"
    log_analytics_workspace_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-qapaq-test/providers/Microsoft.OperationalInsights/workspaces/law-qapaq"
    source_cidrs               = ["10.80.16.32/27"]
    ingress_lb_private_ip      = "10.80.16.42"
    dashboard_ingress_cidrs    = ["198.51.100.25/32"]
    agent_public_cidrs         = ["198.51.100.0/28"]
    agent_target_ip            = "10.80.16.36"
    sku_tier                   = "Basic"
    tags                       = { project = "qapaq-secops", environment = "test" }
  }

  assert {
    condition     = azurerm_firewall.this.sku_tier == "Basic" && azurerm_firewall_policy.this.sku == "Basic"
    error_message = "Firewall y política deben compartir el SKU Basic."
  }

  assert {
    condition     = azurerm_firewall.this.threat_intel_mode == "Alert" && length(azurerm_firewall_policy.this.dns) == 0
    error_message = "Basic solo admite Threat Intelligence en alerta y no tiene DNS proxy."
  }

  assert {
    condition     = length(azurerm_firewall.this.management_ip_configuration) == 1 && length(azurerm_public_ip.management) == 1
    error_message = "Basic requiere la configuración IP de gestión."
  }

  assert {
    condition     = contains(azurerm_firewall_policy_rule_collection_group.egress.application_rule_collection[0].rule[0].destination_fqdns, "graph.microsoft.com")
    error_message = "El allowlist por FQDN se mantiene igual en Basic."
  }

  assert {
    condition = (
      length(azurerm_firewall_policy_rule_collection_group.egress.nat_rule_collection[0].rule) == 4 &&
      contains(azurerm_firewall_policy_rule_collection_group.egress.nat_rule_collection[0].rule[*].translated_address, "10.80.16.36")
    )
    error_message = "Los agentes deben publicar solo 1514 y 1515 hacia la IP fija del SIEM."
  }
}
