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
