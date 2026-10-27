# Pruebas sin credenciales del contrato de entrada del root. El provider simulado permite
# planificar todo el grafo y comprobar que las validaciones rechacen valores peligrosos
# antes de que un plan remoto llegue a Azure.
mock_provider "azurerm" {}

variables {
  subscription_id         = "00000000-0000-0000-0000-000000000000"
  tenant_id               = "00000000-0000-0000-0000-000000000000"
  postgres_admin_password = "plan-only-placeholder-A1!"
}

run "defaults_plan_foundation_only" {
  command = plan

  assert {
    condition     = azurerm_consumption_budget_subscription.monthly.name == "qapaq-secops-demo-monthly"
    error_message = "El nombre del presupuesto debe conservarse para no reemplazar el recurso existente."
  }

  assert {
    condition     = length(azurerm_consumption_budget_subscription.monthly.notification) == 5
    error_message = "El presupuesto debe conservar los cinco umbrales de aviso."
  }

  assert {
    condition     = output.edge_default_fqdn == null && output.siem_private_ip == null && output.ankay_private_ip == null
    error_message = "Por defecto no se crean runtime, SIEM ni Ankay."
  }
}

run "eus2_profile_is_valid" {
  command = plan

  # El módulo de carga de secretos está fijado al resource group y la región reales de EUS2.
  override_data {
    target = data.azurerm_resource_group.this
    values = {
      id       = "/subscriptions/aaf787f8-5964-4470-9eb6-89d15eacda61/resourceGroups/rg-qapaqsecopsdemoeus-3a2405f3"
      name     = "rg-qapaqsecopsdemoeus-3a2405f3"
      location = "eastus2"
    }
  }

  override_resource {
    target = module.data.azurerm_key_vault.this
    values = {
      id = "/subscriptions/aaf787f8-5964-4470-9eb6-89d15eacda61/resourceGroups/rg-qapaqsecopsdemoeus-3a2405f3/providers/Microsoft.KeyVault/vaults/kv-qapaqsecopsd-3a2405f3"
    }
  }

  variables {
    subscription_id                = "aaf787f8-5964-4470-9eb6-89d15eacda61"
    environment                    = "demo-eus2"
    location                       = "eastus2"
    postgres_sku_name              = "GP_Standard_D2s_v3"
    additional_github_environments = ["azure-demo-eus2"]
  }

  assert {
    condition     = length(module.key_vault_seed_identity) == 1
    error_message = "demo-eus2 debe crear la identidad dedicada de carga de secretos."
  }
}

run "rejects_malformed_subscription" {
  command = plan

  variables {
    subscription_id = "my-subscription"
  }

  expect_failures = [var.subscription_id]
}

run "rejects_display_region_name" {
  command = plan

  variables {
    location = "East US 2"
  }

  expect_failures = [var.location]
}

run "rejects_reserved_postgres_login" {
  command = plan

  variables {
    postgres_admin_login = "azure_superuser"
  }

  expect_failures = [var.postgres_admin_login]
}

run "rejects_short_postgres_password" {
  command = plan

  variables {
    postgres_admin_password = "short"
  }

  expect_failures = [var.postgres_admin_password]
}

run "rejects_unsupported_postgres_storage" {
  command = plan

  variables {
    postgres_storage_mb = 40000
  }

  expect_failures = [var.postgres_storage_mb]
}

run "rejects_secret_value_instead_of_key_vault_uri" {
  command = plan

  variables {
    key_vault_secret_ids = {
      api = { QAPAQ_ENTRA_CLIENT_SECRET = "not-a-key-vault-uri" }
    }
  }

  expect_failures = [var.key_vault_secret_ids]
}

run "accepts_versionless_key_vault_uri" {
  command = plan

  variables {
    key_vault_secret_ids = {
      api = { QAPAQ_ENTRA_CLIENT_SECRET = "https://kv-qapaqsecopsd-66f8c73b.vault.azure.net/secrets/entra-client-secret" }
    }
  }
}

run "rejects_mutable_image_tag" {
  command = plan

  variables {
    container_images = { api = "example.azurecr.io/qapaq-api:latest" }
  }

  expect_failures = [var.container_images]
}

run "rejects_budget_start_mid_month" {
  command = plan

  variables {
    cost_budget_start_date = "2026-10-15T00:00:00Z"
  }

  expect_failures = [var.cost_budget_start_date]
}

run "rejects_budget_end_before_start" {
  command = plan

  variables {
    cost_budget_end_date = "2026-01-01T00:00:00Z"
  }

  expect_failures = [var.cost_budget_end_date]
}

run "rejects_tags_without_governance_keys" {
  command = plan

  variables {
    tags = { owner = "soc" }
  }

  expect_failures = [var.tags]
}
