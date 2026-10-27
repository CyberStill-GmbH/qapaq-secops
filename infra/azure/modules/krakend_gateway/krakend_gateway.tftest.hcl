mock_provider "azurerm" {}

run "private_wazuh_ingestion_gateway_contract" {
  command = plan

  variables {
    resource_group_name             = "rg-qapaq-test"
    location                        = "eastus2"
    name_base                       = "qapaqtest"
    tags                            = { environment = "test" }
    virtual_network_id              = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-qapaq-test/providers/Microsoft.Network/virtualNetworks/vnet-qapaqtest"
    subnet_id                       = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-qapaq-test/providers/Microsoft.Network/virtualNetworks/vnet-qapaqtest/subnets/snet-krakend-private"
    subnet_cidr                     = "10.80.0.64/27"
    siem_indexer_proxy_ip           = "10.80.4.4"
    firewall_private_ip             = "10.80.64.4"
    log_analytics_workspace_id      = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-qapaq-test/providers/Microsoft.OperationalInsights/workspaces/law-qapaqtest"
    container_registry_id           = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-qapaq-test/providers/Microsoft.ContainerRegistry/registries/acrqapaqtest"
    container_registry_login_server = "acrqapaqtest.azurecr.io"
    key_vault_id                    = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-qapaq-test/providers/Microsoft.KeyVault/vaults/kv-qapaqtest"
    key_vault_uri                   = "https://kv-qapaqtest.vault.azure.net/"
    image                           = "acrqapaqtest.azurecr.io/qapaq-secops-krakend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    tenant_id                       = "00000000-0000-0000-0000-000000000001"
    client_scope                    = "api://00000000-0000-0000-0000-000000000002/.default"
    indexer_reader_secret_name      = "wazuh-reader-b64"
    indexer_proxy_ca_secret_name    = "wazuh-proxy-ca"
  }

  assert {
    condition     = azurerm_container_app_environment.this.internal_load_balancer_enabled && azurerm_container_app_environment.this.public_network_access == "Disabled"
    error_message = "KrakenD ACA environment must have only a private internal load balancer."
  }

  assert {
    condition     = azurerm_container_app.this.ingress[0].external_enabled && !azurerm_container_app.this.ingress[0].allow_insecure_connections && azurerm_container_app.this.template[0].min_replicas == 2 && azurerm_container_app.this.template[0].max_replicas == 4
    error_message = "Ingress must be VNet-accessible HTTPS only and keep 2–4 replicas."
  }

  assert {
    condition     = azurerm_container_app.this.template[0].container[0].image == var.image && azurerm_container_app.this.template[0].container[0].cpu == 0.5 && azurerm_container_app.this.template[0].container[0].memory == "1Gi"
    error_message = "The app must use the pinned digest and bounded per-replica resources."
  }

  assert {
    condition     = length(local.secret_names) == 2 && local.secret_names.wazuh-basic-auth-b64 == var.indexer_reader_secret_name && local.secret_names.wazuh-indexer-ca-pem == var.indexer_proxy_ca_secret_name
    error_message = "Only the two exact reader/CA Key Vault references may be injected."
  }

  assert {
    condition     = length(azurerm_route_table.this.route) == 1 && alltrue([for route in azurerm_route_table.this.route : route.address_prefix == "0.0.0.0/0" && route.next_hop_in_ip_address == var.firewall_private_ip])
    error_message = "ACA outbound must use the Azure Firewall UDR."
  }
}
