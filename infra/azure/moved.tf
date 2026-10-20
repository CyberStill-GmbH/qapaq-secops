moved {
  from = azurerm_virtual_network.this
  to   = module.network.azurerm_virtual_network.this
}

moved {
  from = azurerm_subnet.container_apps
  to   = module.network.azurerm_subnet.container_apps
}

moved {
  from = azurerm_subnet.postgres
  to   = module.network.azurerm_subnet.postgres
}

moved {
  from = azurerm_subnet.private_endpoints
  to   = module.network.azurerm_subnet.private_endpoints
}

moved {
  from = azurerm_private_dns_zone.postgres
  to   = module.network.azurerm_private_dns_zone.postgres
}

moved {
  from = azurerm_private_dns_zone_virtual_network_link.postgres
  to   = module.network.azurerm_private_dns_zone_virtual_network_link.postgres
}

moved {
  from = azurerm_private_dns_zone.key_vault
  to   = module.network.azurerm_private_dns_zone.key_vault
}

moved {
  from = azurerm_private_dns_zone_virtual_network_link.key_vault
  to   = module.network.azurerm_private_dns_zone_virtual_network_link.key_vault
}

moved {
  from = azurerm_private_dns_zone.blob
  to   = module.network.azurerm_private_dns_zone.blob
}

moved {
  from = azurerm_private_dns_zone_virtual_network_link.blob
  to   = module.network.azurerm_private_dns_zone_virtual_network_link.blob
}

moved {
  from = azurerm_log_analytics_workspace.this
  to   = module.observability.azurerm_log_analytics_workspace.this
}

moved {
  from = azurerm_container_app_environment.this
  to   = module.observability.azurerm_container_app_environment.this
}

moved {
  from = azurerm_postgresql_flexible_server.this
  to   = module.data.azurerm_postgresql_flexible_server.this
}

moved {
  from = azurerm_postgresql_flexible_server_database.app
  to   = module.data.azurerm_postgresql_flexible_server_database.app
}

moved {
  from = azurerm_postgresql_flexible_server_database.queue
  to   = module.data.azurerm_postgresql_flexible_server_database.queue
}

moved {
  from = azurerm_storage_account.evidence
  to   = module.data.azurerm_storage_account.evidence
}

moved {
  from = azurerm_storage_container.raw
  to   = module.data.azurerm_storage_container.raw
}

moved {
  from = azurerm_private_endpoint.key_vault
  to   = module.data.azurerm_private_endpoint.key_vault
}

moved {
  from = azurerm_private_endpoint.blob
  to   = module.data.azurerm_private_endpoint.blob
}

moved {
  from = azurerm_key_vault.this
  to   = module.data.azurerm_key_vault.this
}

moved {
  from = azurerm_user_assigned_identity.runtime
  to   = module.identity_registry.azurerm_user_assigned_identity.runtime
}

moved {
  from = azurerm_user_assigned_identity.github_publisher
  to   = module.identity_registry.azurerm_user_assigned_identity.github_publisher
}

moved {
  from = azurerm_federated_identity_credential.github
  to   = module.identity_registry.azurerm_federated_identity_credential.github
}

moved {
  from = azurerm_container_registry.this
  to   = module.identity_registry.azurerm_container_registry.this
}

moved {
  from = azurerm_role_assignment.acr_pull
  to   = module.identity_registry.azurerm_role_assignment.acr_pull
}

moved {
  from = azurerm_role_assignment.acr_push
  to   = module.identity_registry.azurerm_role_assignment.acr_push
}

moved {
  from = azurerm_role_assignment.key_vault_reader
  to   = module.identity_registry.azurerm_role_assignment.key_vault_reader
}

moved {
  from = azurerm_role_assignment.raw_blob_writer
  to   = module.identity_registry.azurerm_role_assignment.raw_blob_writer
}

moved {
  from = azurerm_container_app.runtime
  to   = module.runtime.azurerm_container_app.runtime
}
