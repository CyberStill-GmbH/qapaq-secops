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
  key_vault_id                 = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-qapaq-test/providers/Microsoft.KeyVault/vaults/kv-qapaq-test"
  key_vault_uri                = "https://kv-qapaq-test.vault.azure.net/"
  container_registry_id        = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-qapaq-test/providers/Microsoft.ContainerRegistry/registries/acrqapaqtest"
  artifact_container_scope_id  = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-qapaq-test/providers/Microsoft.Storage/storageAccounts/stqapaqtest/blobServices/default/containers/artifacts"
  bootstrap_bundle_blob_url    = "https://stqapaqtest.blob.core.windows.net/artifacts/siem-bootstrap.tar.gz"
  bootstrap_bundle_sha256      = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
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
