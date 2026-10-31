mock_provider "azurerm" {
  override_during = plan

  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-qapaq-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-qapaqtest-ankay"
      client_id    = "00000000-0000-0000-0000-0000000000aa"
      principal_id = "00000000-0000-0000-0000-0000000000bb"
    }
  }
}

variables {
  resource_group_name             = "rg-qapaq-test"
  location                        = "eastus2"
  name_base                       = "qapaqtest"
  tags                            = { environment = "test" }
  subnet_id                       = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-qapaq-test/providers/Microsoft.Network/virtualNetworks/vnet-qapaqtest/subnets/snet-ankay"
  confirm_dedicated_subnet        = true
  private_ip_address              = "10.80.0.36"
  edge_subnet_cidr                = "10.80.16.36/32"
  qapaq_api_subnet_cidr           = "10.80.16.36/32"
  qapaq_api_private_ip            = "10.80.16.36"
  wazuh_manager_private_ip        = "10.80.16.36"
  firewall_private_ip             = "10.80.64.4"
  firewall_policy_reference       = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-qapaq-test/providers/Microsoft.Network/firewallPolicies/afwp-qapaqtest"
  admin_ssh_public_key            = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMZtB99HNW7C1awUsxjcycJxl1cgLFu285G+ZY5EVanq ankay-test-fixture"
  vm_size                         = "Standard_E2bds_v5"
  ubuntu_image_version            = "24.04.202610210"
  container_registry_id           = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-qapaq-test/providers/Microsoft.ContainerRegistry/registries/qapaqsecopsdemoeus3a2405f3"
  container_registry_login_server = "qapaqsecopsdemoeus3a2405f3.azurecr.io"
  container_images = {
    docker-guard = "qapaqsecopsdemoeus3a2405f3.azurecr.io/ankay-qapaq-docker-guard@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    frontend     = "qapaqsecopsdemoeus3a2405f3.azurecr.io/ankay-qapaq-frontend@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    backend      = "qapaqsecopsdemoeus3a2405f3.azurecr.io/ankay-qapaq-backend@sha256:3333333333333333333333333333333333333333333333333333333333333333"
    orborus      = "qapaqsecopsdemoeus3a2405f3.azurecr.io/ankay-qapaq-orborus@sha256:4444444444444444444444444444444444444444444444444444444444444444"
    opensearch   = "qapaqsecopsdemoeus3a2405f3.azurecr.io/ankay-qapaq-opensearch@sha256:5555555555555555555555555555555555555555555555555555555555555555"
    worker       = "qapaqsecopsdemoeus3a2405f3.azurecr.io/ankay-qapaq-worker@sha256:6666666666666666666666666666666666666666666666666666666666666666"
  }
  app_images = {
    "ankay/apps:qapaq-ankay_1.0.0" = "qapaqsecopsdemoeus3a2405f3.azurecr.io/ankay-qapaq-app-qapaq-ankay@sha256:7777777777777777777777777777777777777777777777777777777777777777"
  }
  compose_yaml         = file("tests/fixtures/compose.yaml")
  compose_sha256       = sha256(file("tests/fixtures/compose.yaml"))
  key_vault_id         = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-qapaq-test/providers/Microsoft.KeyVault/vaults/kv-qapaqtest"
  key_vault_uri        = "https://kv-qapaqtest.vault.azure.net/"
  key_vault_private_ip = "10.80.32.20"
  # Nombres neutros en la prueba: la variable real es ANKAY_OPENSEARCH_PASSWORD (por defecto).
  opensearch_admin_secret_env = "ANKAY_OPENSEARCH_ADMIN_REF"
  secret_names = {
    ANKAY_ENCRYPTION_MODIFIER    = "ankay-shuffle-encryption-modifier"
    ANKAY_OPENSEARCH_ADMIN_REF   = "ankay-opensearch-admin-password"
    ANKAY_ADMIN_LOGIN_REF        = "ankay-admin-password"
    ANKAY_ADMIN_API_KEY          = "ankay-admin-api-key"
    ANKAY_WAZUH_WEBHOOK_TOKEN    = "ankay-wazuh-webhook-token"
    ANKAY_DISPATCH_WEBHOOK_TOKEN = "ankay-dispatch-webhook-token"
    ANKAY_DISPATCH_HMAC_KEY      = "ankay-dispatch-hmac-key"
  }
  docker_package_versions = {
    "docker-ce"             = "5:29.9.2-1~ubuntu.24.04~noble"
    "docker-ce-cli"         = "5:29.9.2-1~ubuntu.24.04~noble"
    "containerd.io"         = "2.4.2-3~ubuntu.24.04~noble"
    "docker-buildx-plugin"  = "0.38.1-1~ubuntu.24.04~noble"
    "docker-compose-plugin" = "5.6.1-1~ubuntu.24.04~noble"
    "azure-cli"             = "2.91.0-1~noble"
  }
}

run "eus2_profile_plans_a_private_quota_compatible_host" {
  command = plan

  assert {
    condition     = azurerm_linux_virtual_machine.ankay.size == "Standard_E2bds_v5" && azurerm_linux_virtual_machine.ankay.source_image_reference[0].version == "24.04.202610210"
    error_message = "The host must use the EBDSv5 SKU and the exact Ubuntu image version."
  }

  assert {
    condition     = azurerm_network_interface.ankay.ip_configuration[0].public_ip_address_id == null && azurerm_network_interface.ankay.ip_configuration[0].private_ip_address == "10.80.0.36"
    error_message = "Ankay must have only its static private IP."
  }

  assert {
    condition     = length(azurerm_role_assignment.key_vault_secret_read) == 7
    error_message = "The identity must read exactly the seven named Ankay secrets."
  }

  assert {
    condition     = length(base64encode(local.cloud_init)) <= 87380
    error_message = "VM custom_data must stay within Azure's 64 KiB limit."
  }

  assert {
    condition     = local.compose_socket_only_in_guard && local.compose_has_no_host_privileges && local.compose_keeps_internal_services_unpublished
    error_message = "The rendered Compose must keep the Docker socket in docker-guard only, without host privileges or published internal ports."
  }

  assert {
    condition     = strcontains(local.start_compose, "ankay/apps:qapaq-ankay_1.0.0") && strcontains(local.start_compose, var.container_images.worker) && strcontains(local.start_compose, "ankay-prepare-opensearch-tls")
    error_message = "Startup must pre-pull worker/app images by digest, prepare OpenSearch TLS and import playbooks."
  }

  assert {
    condition     = strcontains(local.install_runtime, "groupadd --system --gid 2375 docker") && strcontains(local.install_runtime, "vm.max_map_count = 262144")
    error_message = "The host must fix the docker group GID for docker-guard and set the OpenSearch sysctl."
  }
}

run "rejects_skus_outside_the_ebdsv5_quota" {
  command = plan

  variables {
    vm_size = "Standard_F4s_v2"
  }

  expect_failures = [var.vm_size]
}

run "rejects_the_unlicensed_shuffle_security_component" {
  command = plan

  variables {
    container_images = {
      shuffle-security = "qapaqsecopsdemoeus3a2405f3.azurecr.io/ankay-qapaq-shuffle-security@sha256:1111111111111111111111111111111111111111111111111111111111111111"
      frontend         = "qapaqsecopsdemoeus3a2405f3.azurecr.io/ankay-qapaq-frontend@sha256:2222222222222222222222222222222222222222222222222222222222222222"
      backend          = "qapaqsecopsdemoeus3a2405f3.azurecr.io/ankay-qapaq-backend@sha256:3333333333333333333333333333333333333333333333333333333333333333"
      orborus          = "qapaqsecopsdemoeus3a2405f3.azurecr.io/ankay-qapaq-orborus@sha256:4444444444444444444444444444444444444444444444444444444444444444"
      opensearch       = "qapaqsecopsdemoeus3a2405f3.azurecr.io/ankay-qapaq-opensearch@sha256:5555555555555555555555555555555555555555555555555555555555555555"
      worker           = "qapaqsecopsdemoeus3a2405f3.azurecr.io/ankay-qapaq-worker@sha256:6666666666666666666666666666666666666666666666666666666666666666"
    }
  }

  expect_failures = [var.container_images]
}

run "rejects_a_compose_that_gives_the_socket_to_the_backend" {
  command = plan

  variables {
    compose_yaml   = replace(file("tests/fixtures/compose.yaml"), "      - /mnt/ankay/files:/shuffle-files\n", "      - /mnt/ankay/files:/shuffle-files\n      - /var/run/docker.sock:/var/run/docker.sock\n")
    compose_sha256 = sha256(replace(file("tests/fixtures/compose.yaml"), "      - /mnt/ankay/files:/shuffle-files\n", "      - /mnt/ankay/files:/shuffle-files\n      - /var/run/docker.sock:/var/run/docker.sock\n"))
  }

  expect_failures = [azurerm_linux_virtual_machine.ankay]
}

run "rejects_a_compose_whose_digest_does_not_match" {
  command = plan

  variables {
    compose_sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
  }

  expect_failures = [azurerm_linux_virtual_machine.ankay]
}

run "rejects_an_importer_secret_outside_key_vault_names" {
  command = plan

  variables {
    playbook_import_secret_env = { SHUFFLE_API_KEY = "NOT_A_KEY_VAULT_VARIABLE" }
  }

  expect_failures = [azurerm_linux_virtual_machine.ankay]
}
