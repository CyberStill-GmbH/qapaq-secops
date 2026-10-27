locals {
  name              = "${var.name_base}-ankay"
  compose_document  = try(yamldecode(var.compose_yaml), {})
  compose_services  = try(local.compose_document.services, {})
  expected_services = ["shuffle-security", "frontend", "backend", "orborus", "opensearch"]
  compose_service_images_match = length(keys(local.compose_services)) == length(local.expected_services) && alltrue([
    for service in local.expected_services : try(local.compose_services[service].image == var.container_images[service], false)
  ])
  compose_has_expected_worker_image = try(
    local.compose_services.orborus.environment.SHUFFLE_WORKER_IMAGE == var.container_images.worker,
    false
    ) || try(
    contains(local.compose_services.orborus.environment, "SHUFFLE_WORKER_IMAGE=${var.container_images.worker}"),
    false
  )
  compose_keeps_internal_services_unpublished = alltrue([
    for service in ["shuffle-security", "opensearch"] : length(try(local.compose_services[service].ports, [])) == 0
  ])
  compose_has_healthchecks = alltrue([
    for service in local.expected_services : try(length(local.compose_services[service].healthcheck.test) > 0, false)
  ])
  compose_has_restart_policies = alltrue([
    for service in local.expected_services : try(contains(["always", "unless-stopped"], local.compose_services[service].restart), false)
  ])
  install_runtime = templatefile("${path.module}/install-runtime.sh.tftpl", {
    docker_apt_versions = var.docker_package_versions
  })
  start_compose = templatefile("${path.module}/start-compose.sh.tftpl", {
    registry_login_server  = var.container_registry_login_server
    registry_name          = split(".", var.container_registry_login_server)[0]
    identity_client_id     = azurerm_user_assigned_identity.ankay.client_id
    key_vault_uri          = trimsuffix(var.key_vault_uri, "/")
    secret_mapping_json    = jsonencode(var.secret_names)
    compose_sha256         = var.compose_sha256
    health_timeout_seconds = var.compose_health_timeout_seconds
  })
  registry_login = templatefile("${path.module}/registry-login.sh.tftpl", {
    registry_login_server = var.container_registry_login_server
    registry_name         = split(".", var.container_registry_login_server)[0]
    identity_client_id    = azurerm_user_assigned_identity.ankay.client_id
  })
  cloud_init = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    compose_b64         = base64encode(var.compose_yaml)
    compose_sha         = var.compose_sha256
    data_disk_gb        = var.data_disk_size_gb
    disk_bootstrap_b64  = base64encode(file("${path.module}/prepare-data-disk.py"))
    secret_fetch_b64    = base64encode(file("${path.module}/fetch-runtime-secrets.py"))
    install_script_b64  = base64encode(local.install_runtime)
    start_script_b64    = base64encode(local.start_compose)
    registry_script_b64 = base64encode(local.registry_login)
  })
}

resource "azurerm_network_security_group" "ankay" {
  name                = "nsg-${local.name}"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = merge(var.tags, { service = "ankay" })

  security_rule {
    name                       = "AllowQapaqEdgeToAnkayFrontend"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = tostring(var.frontend_port)
    source_address_prefix      = var.edge_subnet_cidr
    destination_address_prefix = var.private_ip_address
  }

  security_rule {
    name                       = "AllowQapaqApiToAnkayWebhook"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = tostring(var.backend_port)
    source_address_prefix      = var.qapaq_api_subnet_cidr
    destination_address_prefix = var.private_ip_address
  }

  security_rule {
    name                       = "DenyOtherInbound"
    priority                   = 400
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "AllowAzurePlatformDns"
    priority                   = 100
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "53"
    source_address_prefix      = "*"
    destination_address_prefix = "AzurePlatformDNS"
  }

  security_rule {
    name                       = "AllowQapaqCallback"
    priority                   = 110
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = tostring(var.api_port)
    source_address_prefix      = var.private_ip_address
    destination_address_prefix = "${var.qapaq_api_private_ip}/32"
  }

  security_rule {
    name                       = "AllowKeyVaultPrivateEndpoint"
    priority                   = 115
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = var.private_ip_address
    destination_address_prefix = "${var.key_vault_private_ip}/32"
  }

  # HTTPS to public endpoints is force-routed through Azure Firewall; default-deny FQDN policy remains a deployment gate.
  #trivy:ignore:AZU-0051:exp:2026-11-20
  security_rule {
    name                       = "AllowHttpEgressForFirewallInspection"
    priority                   = 120
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_ranges    = ["80", "443"]
    source_address_prefix      = var.private_ip_address
    destination_address_prefix = "Internet"
  }

  dynamic "security_rule" {
    for_each = var.wazuh_manager_private_ip == "" ? [] : [var.wazuh_manager_private_ip]
    content {
      name                       = "AllowWazuhAgentToManager"
      priority                   = 130
      direction                  = "Outbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_port_range          = "*"
      destination_port_range     = "1514"
      source_address_prefix      = var.private_ip_address
      destination_address_prefix = "${security_rule.value}/32"
    }
  }

  security_rule {
    name                       = "DenyOtherVnetEgress"
    priority                   = 300
    direction                  = "Outbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "VirtualNetwork"
  }

  security_rule {
    name                       = "DenyDirectInternetEgress"
    priority                   = 310
    direction                  = "Outbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "Internet"
  }
}

resource "azurerm_network_interface" "ankay" {
  name                = "nic-${local.name}"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = merge(var.tags, { service = "ankay" })

  ip_configuration {
    name                          = "private"
    subnet_id                     = var.subnet_id
    private_ip_address_allocation = "Static"
    private_ip_address            = var.private_ip_address
  }
}

resource "azurerm_network_interface_security_group_association" "ankay" {
  network_interface_id      = azurerm_network_interface.ankay.id
  network_security_group_id = azurerm_network_security_group.ankay.id
}

resource "azurerm_route_table" "ankay" {
  name                          = "rt-${local.name}"
  location                      = var.location
  resource_group_name           = var.resource_group_name
  bgp_route_propagation_enabled = false
  tags                          = merge(var.tags, { service = "ankay" })

  route {
    name                   = "force-internet-egress-through-firewall"
    address_prefix         = "0.0.0.0/0"
    next_hop_type          = "VirtualAppliance"
    next_hop_in_ip_address = var.firewall_private_ip
  }
}

resource "azurerm_subnet_route_table_association" "ankay" {
  subnet_id      = var.subnet_id
  route_table_id = azurerm_route_table.ankay.id
}

resource "azurerm_user_assigned_identity" "ankay" {
  name                = "id-${local.name}"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = merge(var.tags, { service = "ankay" })
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = var.container_registry_id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.ankay.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "key_vault_secret_read" {
  for_each = toset(values(var.secret_names))

  scope                = "${trimsuffix(var.key_vault_id, "/")}/secrets/${each.value}"
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.ankay.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_managed_disk" "ankay_data" {
  name                          = "disk-${local.name}-data"
  location                      = var.location
  resource_group_name           = var.resource_group_name
  storage_account_type          = "StandardSSD_LRS"
  create_option                 = "Empty"
  disk_size_gb                  = var.data_disk_size_gb
  network_access_policy         = "DenyAll"
  public_network_access_enabled = false
  tags                          = merge(var.tags, { service = "ankay", data_role = "workflow-and-opensearch" })

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_linux_virtual_machine" "ankay" {
  name                            = local.name
  computer_name                   = "ankay-qapaq"
  location                        = var.location
  resource_group_name             = var.resource_group_name
  size                            = var.vm_size
  admin_username                  = var.admin_username
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.ankay.id]
  custom_data                     = base64encode(local.cloud_init)
  encryption_at_host_enabled      = true
  secure_boot_enabled             = true
  vtpm_enabled                    = true
  patch_mode                      = "AutomaticByPlatform"
  provision_vm_agent              = true
  tags                            = merge(var.tags, { service = "ankay" })

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.ankay.id]
  }

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.admin_ssh_public_key
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = var.ubuntu_image_version
  }

  os_disk {
    name                 = "disk-${local.name}-os"
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = 64
  }

  boot_diagnostics {}

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = sha256(var.compose_yaml) == var.compose_sha256
      error_message = "El SHA-256 del Compose no coincide con la referencia revisada."
    }

    precondition {
      condition     = length(var.container_images) == 6 && alltrue([for image in values(var.container_images) : startswith(image, "${var.container_registry_login_server}/")])
      error_message = "Los cinco servicios Compose y el worker dinámico deben usar digests del ACR indicado."
    }

    precondition {
      condition     = local.compose_service_images_match && !contains(keys(local.compose_services), "worker") && !contains(keys(local.compose_services), "datastore")
      error_message = "Compose debe declarar exactamente shuffle-security, frontend, backend, orborus y opensearch; worker es dinámico y datastore no forma parte del contrato upstream."
    }

    precondition {
      condition     = local.compose_has_expected_worker_image
      error_message = "Orborus debe declarar SHUFFLE_WORKER_IMAGE con el digest ACR aprobado para el worker dinámico."
    }

    precondition {
      condition     = local.compose_keeps_internal_services_unpublished
      error_message = "shuffle-security y OpenSearch no pueden publicar puertos del host; el edge usa frontend y OpenSearch queda en la red Compose."
    }

    precondition {
      condition     = local.compose_has_healthchecks
      error_message = "Cada servicio Compose debe declarar un healthcheck para que cloud-init pueda esperar estado saludable antes de habilitar el host."
    }

    precondition {
      condition     = local.compose_has_restart_policies
      error_message = "Cada servicio Compose debe declarar restart: always o unless-stopped para recuperarse de reinicios del daemon."
    }
  }

  # cloud-init hace login en ACR y lee Key Vault en el primer arranque; sin este orden la
  # VM puede arrancar antes de que existan sus asignaciones RBAC.
  depends_on = [
    azurerm_role_assignment.acr_pull,
    azurerm_role_assignment.key_vault_secret_read,
  ]
}

resource "azurerm_virtual_machine_data_disk_attachment" "ankay_data" {
  managed_disk_id    = azurerm_managed_disk.ankay_data.id
  virtual_machine_id = azurerm_linux_virtual_machine.ankay.id
  lun                = 0
  caching            = "ReadWrite"
  create_option      = "Attach"
}
