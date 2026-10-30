mock_provider "azurerm" {}

variables {
  resource_group_name          = "rg-qapaq-test"
  location                     = "chilecentral"
  name_base                    = "qapaq-test"
  virtual_network_name         = "vnet-qapaq-test"
  firewall_private_ip          = "10.20.0.4"
  firewall_policy_reference    = "policy-test"
  private_endpoint_subnet_cidr = "10.20.1.0/24"
  postgres_subnet_cidr         = "10.20.2.0/24"
  address_prefix               = "10.20.0.0/16"
  vm_size                      = "Standard_F4s_v2"
  admin_ssh_public_key         = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFrSSBU5aLhPsPjvwqHInna41VinFclKO7IxLy6VglY5 test@example.invalid"
  ubuntu_image_version         = "24.04.1"
  data_disk_size_gb            = 128
  dashboard_ingress_cidrs      = ["0.0.0.0/0"]
  core_secret_names            = { QAPAQ_ENTRA_CLIENT_SECRET = "entra-client-secret" }
  wazuh_secret_names           = { "wazuh-install-files.tar.b64" = "wazuh-install-files-tar-b64" }
  key_vault_id                 = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-qapaq-test/providers/Microsoft.KeyVault/vaults/kv-qapaq-test"
  key_vault_uri                = "https://kv-qapaq-test.vault.azure.net/"
  container_registry_id        = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-qapaq-test/providers/Microsoft.ContainerRegistry/registries/acrqapaqtest"
  artifact_container_scope_id  = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-qapaq-test/providers/Microsoft.Storage/storageAccounts/stqapaqtest/blobServices/default/containers/artifacts"
  bootstrap_bundle_blob_url    = "https://stqapaqtest.blob.core.windows.net/artifacts/siem-bootstrap.tar.gz"
  bootstrap_bundle_sha256      = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  office365 = {
    tenant_id  = "00000000-0000-0000-0000-000000000001"
    client_id  = "00000000-0000-0000-0000-000000000002"
    api_type   = "commercial"
    enable_dlp = false
  }
}

run "accepts_matching_key_vault_reference" {
  command = plan

  variables {
    core_environment = {
      QAPAQ_ENTRA_CLIENT_SECRET_REF = "secret://keyvault/entra-client-secret"
    }
    core_secret_names = {
      QAPAQ_ENTRA_CLIENT_SECRET = "entra-client-secret"
    }
  }

  assert {
    condition     = one([for rule in azurerm_network_security_group.siem.security_rule : rule if rule.name == "allow-acme-http-via-firewall-dnat"]).source_address_prefix == var.firewall_private_ip
    error_message = "The SIEM NSG must allow HTTP from the Azure Firewall private IP after DNAT source translation."
  }

  assert {
    condition     = one([for rule in azurerm_network_security_group.siem.security_rule : rule if rule.name == "allow-dashboard-https-approved-sources"]).source_address_prefix == var.firewall_private_ip
    error_message = "The SIEM NSG must allow HTTPS only from the Azure Firewall private IP; the Firewall DNAT rule filters the original client CIDR."
  }

  assert {
    condition = (
      one([for rule in azurerm_network_security_group.siem.security_rule : rule if rule.name == "deny-indexer-proxy-from-other-vnet"]).destination_port_range == "9443" &&
      one([for rule in azurerm_network_security_group.siem.security_rule : rule if rule.name == "deny-indexer-proxy-from-other-vnet"]).access == "Deny"
    )
    error_message = "TCP/9443 must be explicitly denied to the VNet even when the optional KrakenD proxy is disabled."
  }
}

run "rejects_worldwide_agent_enrollment" {
  command = plan

  variables {
    agent_ingress_cidrs = ["0.0.0.0/0"]
  }

  expect_failures = [var.agent_ingress_cidrs]
}

run "accepts_postgres_with_matching_key_vault_references" {
  command = plan

  variables {
    core_environment = {
      QAPAQ_SOC_PERSISTENCE       = "postgres"
      QAPAQ_POSTGRES_PASSWORD_REF = "secret://keyvault/qapaq-postgres-password"
      QAPAQ_ENTITY_REF_KEY_REF    = "secret://keyvault/qapaq-entity-ref-key"
    }
    core_secret_names = {
      QAPAQ_ENTRA_CLIENT_SECRET = "entra-client-secret"
      QAPAQ_POSTGRES_PASSWORD   = "qapaq-postgres-password"
      QAPAQ_ENTITY_REF_KEY      = "qapaq-entity-ref-key"
    }
  }
}

run "rejects_postgres_without_password_secret_mapping" {
  command = plan

  variables {
    core_environment = {
      QAPAQ_SOC_PERSISTENCE = "postgres"
    }
    core_secret_names = {
      QAPAQ_ENTRA_CLIENT_SECRET = "entra-client-secret"
      QAPAQ_ENTITY_REF_KEY      = "qapaq-entity-ref-key"
    }
  }

  expect_failures = [var.core_environment]
}

run "rejects_postgres_without_entity_reference_key_mapping" {
  command = plan

  variables {
    core_environment = {
      QAPAQ_SOC_PERSISTENCE = "postgres"
    }
    core_secret_names = {
      QAPAQ_ENTRA_CLIENT_SECRET = "entra-client-secret"
      QAPAQ_POSTGRES_PASSWORD   = "qapaq-postgres-password"
    }
  }

  expect_failures = [var.core_environment]
}

run "rejects_postgres_reference_that_does_not_match_key_vault_mapping" {
  command = plan

  variables {
    core_environment = {
      QAPAQ_SOC_PERSISTENCE       = "postgres"
      QAPAQ_POSTGRES_PASSWORD_REF = "secret://keyvault/qapaq-postgres-password"
      QAPAQ_ENTITY_REF_KEY_REF    = "secret://keyvault/unmapped-entity-ref-key"
    }
    core_secret_names = {
      QAPAQ_ENTRA_CLIENT_SECRET = "entra-client-secret"
      QAPAQ_POSTGRES_PASSWORD   = "qapaq-postgres-password"
      QAPAQ_ENTITY_REF_KEY      = "qapaq-entity-ref-key"
    }
  }

  expect_failures = [var.core_environment]
}

run "rejects_plaintext_client_secret_reference" {
  command = plan

  variables {
    core_environment = {
      QAPAQ_ENTRA_CLIENT_SECRET_REF = "client-secret-value-must-not-be-here"
    }
    core_secret_names = {
      QAPAQ_ENTRA_CLIENT_SECRET = "entra-client-secret"
    }
  }

  expect_failures = [var.core_environment]
}

run "rejects_reference_not_backed_by_secret_mapping" {
  command = plan

  variables {
    core_environment = {
      QAPAQ_ENTRA_CLIENT_SECRET_REF = "secret://keyvault/entra-client-secret"
    }
    core_secret_names = {
      QAPAQ_ENTRA_CLIENT_SECRET = "a-different-secret"
    }
  }

  expect_failures = [var.core_environment]
}

run "rejects_provider_endpoint_outside_configured_vault" {
  command = plan

  variables {
    core_environment = {
      QAPAQ_SECRET_PROVIDER_ENDPOINT = "https://other-vault.vault.azure.net"
    }
  }

  expect_failures = [var.core_environment]
}

run "rejects_non_azure_secret_provider_type" {
  command = plan

  variables {
    core_environment = {
      QAPAQ_SECRET_PROVIDER_TYPE = "environment"
    }
  }

  expect_failures = [var.core_environment]
}

run "rejects_secret_value_in_environment" {
  command = plan

  variables {
    core_environment = {
      QAPAQ_ENTRA_CLIENT_SECRET = "secret://keyvault/entra-client-secret"
    }
    core_secret_names = {
      QAPAQ_ENTRA_CLIENT_SECRET = "entra-client-secret"
    }
  }

  expect_failures = [var.core_environment]
}

run "rejects_plaintext_entity_reference_key" {
  command = plan

  variables {
    core_environment = {
      QAPAQ_ENTITY_REF_KEY = "synthetic-entity-key-must-not-enter-terraform"
    }
    core_secret_names = {
      QAPAQ_ENTRA_CLIENT_SECRET = "entra-client-secret"
      QAPAQ_ENTITY_REF_KEY      = "qapaq-entity-ref-key"
    }
  }

  expect_failures = [var.core_environment]
}

run "rejects_plaintext_teams_workflow_url" {
  command = plan

  variables {
    core_environment = {
      QAPAQ_TEAMS_WORKFLOW_URL = "https://example.invalid/workflows/demo?sig=synthetic"
    }
    core_secret_names = {
      QAPAQ_ENTRA_CLIENT_SECRET = "entra-client-secret"
      QAPAQ_TEAMS_WORKFLOW_URL  = "qapaq-teams-workflow-url"
    }
  }

  expect_failures = [var.core_environment]
}

run "rejects_secret_reference_in_secret_names" {
  command = plan

  variables {
    core_environment = {}
    core_secret_names = {
      QAPAQ_ENTRA_CLIENT_SECRET_REF = "entra-client-secret-reference"
    }
  }

  expect_failures = [var.core_secret_names]
}

run "rejects_unverified_vm_size" {
  command = plan

  variables {
    vm_size = "Standard_B2s"
  }

  expect_failures = [var.vm_size]
}

run "rejects_invalid_office365_ids" {
  command = plan

  variables {
    office365 = {
      tenant_id  = "not-a-guid"
      client_id  = "00000000-0000-4000-8000-000000000002"
      api_type   = "commercial"
      enable_dlp = false
    }
  }

  expect_failures = [var.office365]
}

run "rejects_missing_wazuh_install_archive_reference" {
  command = plan

  variables {
    wazuh_secret_names = {}
  }

  expect_failures = [var.wazuh_secret_names]
}

run "grants_proxy_secret_write_only_at_the_two_named_secret_scopes" {
  command = plan

  variables {
    indexer_proxy = {
      reader_secret_name   = "wazuh-reader-b64"
      proxy_ca_secret_name = "wazuh-proxy-ca"
    }
    indexer_proxy_secret_role_definition_id = "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/00000000-0000-4000-8000-000000000099"
    krakend_source_cidrs                    = ["10.20.4.0/27"]
  }

  assert {
    condition = length(azurerm_role_assignment.indexer_proxy_secret_seed) == 2 && alltrue([
      for assignment in values(azurerm_role_assignment.indexer_proxy_secret_seed) :
      startswith(assignment.scope, "${trimsuffix(var.key_vault_id, "/")}/secrets/") &&
      assignment.role_definition_id == var.indexer_proxy_secret_role_definition_id
    ])
    error_message = "Indexer bootstrap must get/set only its two pre-existing secret scopes with the dedicated custom role."
  }

  assert {
    condition = (
      one([for rule in azurerm_network_security_group.siem.security_rule : rule if rule.name == "allow-indexer-read-proxy-from-krakend"]).destination_port_range == "9443" &&
      length(one([for rule in azurerm_network_security_group.siem.security_rule : rule if rule.name == "allow-indexer-read-proxy-from-krakend"]).source_address_prefixes) == 1 &&
      contains(one([for rule in azurerm_network_security_group.siem.security_rule : rule if rule.name == "allow-indexer-read-proxy-from-krakend"]).source_address_prefixes, "10.20.4.0/27")
    )
    error_message = "Only KrakenD may connect to the private read-only proxy on port 9443."
  }

  assert {
    condition     = one([for rule in azurerm_network_security_group.siem.security_rule : rule if rule.name == "deny-direct-indexer-vnet-access"]).destination_port_range == "9200"
    error_message = "No VNet workload may access the Indexer directly on port 9200."
  }

  assert {
    condition = (
      one([for rule in azurerm_network_security_group.siem.security_rule : rule if rule.name == "deny-indexer-proxy-from-other-vnet"]).priority == 122 &&
      one([for rule in azurerm_network_security_group.siem.security_rule : rule if rule.name == "deny-indexer-proxy-from-other-vnet"]).access == "Deny" &&
      one([for rule in azurerm_network_security_group.siem.security_rule : rule if rule.name == "deny-indexer-proxy-from-other-vnet"]).source_address_prefix == "VirtualNetwork"
    )
    error_message = "Other VNet workloads must be denied after the exact KrakenD subnet allow rule."
  }
}

run "rejects_proxy_when_krakend_source_allowlist_is_empty" {
  command = plan

  variables {
    indexer_proxy = {
      reader_secret_name   = "wazuh-reader-b64"
      proxy_ca_secret_name = "wazuh-proxy-ca"
    }
    indexer_proxy_secret_role_definition_id = "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/00000000-0000-4000-8000-000000000099"
    krakend_source_cidrs                    = []
  }

  expect_failures = [var.krakend_source_cidrs]
}

run "rejects_non_private_krakend_source_cidr" {
  command = plan

  variables {
    indexer_proxy = {
      reader_secret_name   = "wazuh-reader-b64"
      proxy_ca_secret_name = "wazuh-proxy-ca"
    }
    indexer_proxy_secret_role_definition_id = "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/00000000-0000-4000-8000-000000000099"
    krakend_source_cidrs                    = ["192.0.2.0/24"]
  }

  expect_failures = [var.krakend_source_cidrs]
}

run "assistant_secret_grants_exact_read_without_touching_bootstrap" {
  command = plan

  variables {
    core_environment      = {}
    assistant_secret_name = "qapaq-anthropic-api-key"
  }

  assert {
    condition     = azurerm_role_assignment.assistant_secret_read[0].scope == "${var.key_vault_id}/secrets/qapaq-anthropic-api-key"
    error_message = "The assistant key must be readable only at its exact Key Vault secret scope."
  }

  # bootstrap_config lleva el client_id de la identidad (desconocido en plan); el custom_data no.
  assert {
    condition     = !strcontains(local.cloud_init, "anthropic")
    error_message = "Enabling the assistant must not change the VM custom_data."
  }
}

run "assistant_disabled_by_default" {
  command = plan

  variables {
    core_environment = {}
  }

  assert {
    condition     = length(azurerm_role_assignment.assistant_secret_read) == 0
    error_message = "Without assistant_secret_name no assistant secret grant may exist."
  }
}

run "rejects_assistant_secret_value" {
  command = plan

  variables {
    core_environment      = {}
    assistant_secret_name = "sk-ant-api03 not a name"
  }

  expect_failures = [var.assistant_secret_name]
}
