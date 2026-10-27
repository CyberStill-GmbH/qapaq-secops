resource "azurerm_log_analytics_workspace" "this" {
  name                = "law-${var.name_base}"
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = var.tags

  lifecycle {
    prevent_destroy = true
  }
}


resource "azurerm_container_app_environment" "this" {
  count                          = var.enable_runtime ? 1 : 0
  name                           = "cae-${var.name_base}"
  location                       = var.location
  resource_group_name            = var.resource_group_name
  log_analytics_workspace_id     = azurerm_log_analytics_workspace.this.id
  infrastructure_subnet_id       = var.container_apps_subnet_id
  internal_load_balancer_enabled = false
  tags                           = var.tags

  # La subnet delegada es /27. Un entorno Consumption-only exige /23 y falla al crearse;
  # Workload Profiles admite /27 y conserva el modelo de pago por consumo.
  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }

  lifecycle {
    prevent_destroy = true
  }
}
