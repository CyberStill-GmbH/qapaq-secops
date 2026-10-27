locals {
  # El ingress interno de ACA escucha en 443 y reenvía al target_port; con
  # allow_insecure_connections = false, HTTP recibe una redirección que los proxies no siguen.
  # Por eso los upstreams usan HTTPS y no incluyen el puerto del contenedor.
  required_images = toset(["edge", "web", "gateway", "api", "worker"])
  runtime_apps = {
    edge = {
      image        = lookup(var.container_images, "edge", "")
      port         = 8080
      external     = true
      min_replicas = 1
      max_replicas = 2
      cpu          = 0.5
      memory       = "1Gi"
      env = {
        QAPAQ_WEB_UPSTREAM     = "https://${var.name_base}-web.internal.${var.container_app_environment_default_domain}"
        QAPAQ_GATEWAY_UPSTREAM = "https://${var.name_base}-gateway.internal.${var.container_app_environment_default_domain}"
      }
    }
    web = {
      image        = lookup(var.container_images, "web", "")
      port         = 8080
      external     = false
      min_replicas = 1
      max_replicas = 2
      cpu          = 0.5
      memory       = "1Gi"
      env          = {}
    }
    gateway = {
      image        = lookup(var.container_images, "gateway", "")
      port         = 8080
      external     = false
      min_replicas = 1
      max_replicas = 2
      cpu          = 0.5
      memory       = "1Gi"
      env          = { QAPAQ_API_UPSTREAM = "https://${var.name_base}-api.internal.${var.container_app_environment_default_domain}" }
    }
    api = {
      image        = lookup(var.container_images, "api", "")
      port         = 3000
      external     = false
      min_replicas = 1
      max_replicas = 3
      cpu          = 0.5
      memory       = "1Gi"
      env = {
        NODE_ENV                = "production"
        QAPAQ_PROFILE           = "production"
        QAPAQ_API_HOST          = "0.0.0.0"
        QAPAQ_API_PORT          = "3000"
        QAPAQ_SOC_PERSISTENCE   = "postgres"
        QAPAQ_POSTGRES_HOST     = var.postgres_fqdn
        QAPAQ_POSTGRES_PORT     = "5432"
        QAPAQ_POSTGRES_DATABASE = var.app_database_name
        QAPAQ_POSTGRES_TLS      = "true"
      }
    }
    worker = {
      image        = lookup(var.container_images, "worker", "")
      port         = 0
      external     = false
      min_replicas = 1
      max_replicas = 3
      cpu          = 0.5
      memory       = "1Gi"
      env = {
        NODE_ENV      = "production"
        QAPAQ_PROFILE = "production"
      }
    }
  }
}

resource "azurerm_container_app" "runtime" {
  for_each = var.enable_runtime ? local.runtime_apps : {}

  name                         = "${var.name_base}-${each.key}"
  resource_group_name          = var.resource_group_name
  container_app_environment_id = var.container_app_environment_id
  workload_profile_name        = "Consumption"
  revision_mode                = "Single"
  tags                         = merge(var.tags, { service = each.key })

  identity {
    type         = "UserAssigned"
    identity_ids = [var.runtime_identity_id]
  }

  registry {
    server   = var.container_registry_login_server
    identity = var.runtime_identity_id
  }

  dynamic "secret" {
    for_each = lookup(var.key_vault_secret_ids, each.key, {})
    content {
      name                = lower(replace(secret.key, "_", "-"))
      key_vault_secret_id = secret.value
      identity            = var.runtime_identity_id
    }
  }

  template {
    min_replicas = each.value.min_replicas
    max_replicas = each.value.max_replicas

    container {
      name   = each.key
      image  = each.value.image
      cpu    = each.value.cpu
      memory = each.value.memory

      dynamic "env" {
        for_each = each.value.env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = lookup(var.key_vault_secret_ids, each.key, {})
        content {
          name        = env.key
          secret_name = lower(replace(env.key, "_", "-"))
        }
      }
    }
  }

  dynamic "ingress" {
    for_each = each.value.external || each.key != "worker" ? [each.value] : []
    content {
      external_enabled           = ingress.value.external
      target_port                = ingress.value.port
      transport                  = "http"
      allow_insecure_connections = false

      traffic_weight {
        percentage      = 100
        latest_revision = true
      }
    }
  }

  lifecycle {
    precondition {
      condition     = length(var.container_images) == length(local.required_images) && alltrue([for name in local.required_images : contains(keys(var.container_images), name)])
      error_message = "enable_runtime requiere digests verificados para edge, web, gateway, api y worker."
    }
  }

}
