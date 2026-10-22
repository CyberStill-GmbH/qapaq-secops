locals {
  subnet_name = "snet-${var.name_base}-siem"
  nsg_name    = "nsg-${var.name_base}-siem"
  nic_name    = "nic-${var.name_base}-siem"
  vm_name     = "vm-${var.name_base}-siem"
  disk_name   = "disk-${var.name_base}-siem-data"
  identity    = azurerm_user_assigned_identity.siem

  cloud_init = "#cloud-config\n${yamlencode({
    write_files = [{
      path        = "/usr/local/sbin/qapaq-siem-bootstrap.py"
      owner       = "root:root"
      permissions = "0700"
      content     = file("${path.module}/bootstrap-siem.py")
    }]
  })}"

  bootstrap_config = jsonencode({
    artifact_url       = var.bootstrap_bundle_blob_url
    artifact_sha256    = var.bootstrap_bundle_sha256
    identity_client_id = azurerm_user_assigned_identity.siem.client_id
    key_vault_uri      = trimsuffix(var.key_vault_uri, "/")
    core_secret_names  = var.core_secret_names
    wazuh_secret_names = var.wazuh_secret_names
    core_environment   = var.core_environment
    data_disk_size_gb  = var.data_disk_size_gb
    expected = {
      wazuh_version = "4.14.8"
      osd_version   = "2.19.6"
      node_version  = "24.21.0"
    }
  })

  bootstrap_extension_script = <<-SCRIPT
    #!/bin/bash
    set -euo pipefail
    umask 077
    install -d -m 0700 /etc/qapaq-siem
    install -m 0600 /dev/null /var/log/qapaq-siem-bootstrap.log
    printf '%s' '${base64encode(local.bootstrap_config)}' | base64 --decode > /etc/qapaq-siem/bootstrap.json
    chmod 0600 /etc/qapaq-siem/bootstrap.json
    exec python3 /usr/local/sbin/qapaq-siem-bootstrap.py >> /var/log/qapaq-siem-bootstrap.log 2>&1
  SCRIPT
}

resource "azurerm_subnet" "siem" {
  name                            = local.subnet_name
  resource_group_name             = var.resource_group_name
  virtual_network_name            = var.virtual_network_name
  address_prefixes                = [var.address_prefix]
  default_outbound_access_enabled = false
}

resource "azurerm_network_security_group" "siem" {
  name                = local.nsg_name
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = merge(var.tags, { service = "siem-host" })

  dynamic "security_rule" {
    for_each = length(var.dashboard_ingress_cidrs) == 0 ? {} : { https = var.dashboard_ingress_cidrs }
    content {
      name                       = "allow-dashboard-https-approved-sources"
      priority                   = 100
      direction                  = "Inbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_port_range          = "*"
      destination_port_range     = "443"
      source_address_prefixes    = tolist(security_rule.value)
      destination_address_prefix = "*"
      description                = "HTTPS solo desde CIDR aprobados. Sin CIDR, 443 queda en deny por defecto."
    }
  }

  dynamic "security_rule" {
    for_each = length(var.agent_ingress_cidrs) == 0 ? {} : { agents = var.agent_ingress_cidrs }
    content {
      name                       = "allow-wazuh-agent-ports-approved-sources"
      priority                   = 110
      direction                  = "Inbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_port_range          = "*"
      destination_port_ranges    = ["1514", "1515"]
      source_address_prefixes    = tolist(security_rule.value)
      destination_address_prefix = "*"
      description                = "Wazuh agent/registration solo desde redes privadas aprobadas."
    }
  }

  # The subnet has no default outbound access. Only private dependencies and HTTP/S routed
  # through the explicitly required Azure Firewall are allowed; explicit denies precede Azure's
  # built-in AllowVnetOutBound/AllowInternetOutBound rules.
  security_rule {
    name                       = "allow-azure-platform-dns"
    priority                   = 100
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "53"
    source_address_prefix      = "*"
    destination_address_prefix = "AzurePlatformDNS"
    description                = "DNS al resolver virtual de Azure; el resto de egress queda bloqueado."
  }

  security_rule {
    name                       = "allow-azure-managed-identity-imds"
    priority                   = 106
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "80"
    source_address_prefix      = "*"
    destination_address_prefix = "AzurePlatformIMDS"
    description                = "Permite obtener tokens de Managed Identity desde IMDS, sin abrir egress general."
  }

  security_rule {
    name                       = "allow-azure-platform-wireserver"
    priority                   = 107
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_ranges    = ["80", "32526"]
    source_address_prefix      = "*"
    destination_address_prefix = "AzurePlatformLKM"
    description                = "Canal Azure WireServer/VM Agent requerido para estado Ready y extensiones; no permite el puerto 1688."
  }

  security_rule {
    name                         = "allow-private-endpoints-https"
    priority                     = 110
    direction                    = "Outbound"
    access                       = "Allow"
    protocol                     = "Tcp"
    source_port_range            = "*"
    destination_port_range       = "443"
    source_address_prefix        = "VirtualNetwork"
    destination_address_prefixes = [var.private_endpoint_subnet_cidr]
    description                  = "HTTPS solo hacia la subnet dedicada a Private Endpoints de Key Vault y Blob."
  }

  security_rule {
    name                         = "allow-postgres-private"
    priority                     = 120
    direction                    = "Outbound"
    access                       = "Allow"
    protocol                     = "Tcp"
    source_port_range            = "*"
    destination_port_range       = "5432"
    source_address_prefix        = "VirtualNetwork"
    destination_address_prefixes = [var.postgres_subnet_cidr]
    description                  = "PostgreSQL solo hacia la subnet privada aprobada."
  }

  # HTTPS to public endpoints is force-routed through Azure Firewall; default-deny FQDN policy remains a deployment gate.
  #trivy:ignore:AZU-0051:exp:2026-11-20
  security_rule {
    name                       = "allow-web-through-firewall"
    priority                   = 130
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "VirtualNetwork"
    destination_address_prefix = "Internet"
    description                = "HTTPS usa UDR 0/0 al Azure Firewall; su policy debe permitir destinos explícitos y denegar por defecto."
  }

  security_rule {
    name                       = "deny-other-vnet-egress"
    priority                   = 300
    direction                  = "Outbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "VirtualNetwork"
    description                = "Evita acceso lateral a redes virtuales fuera de los destinos privados aprobados arriba."
  }

  security_rule {
    name                       = "deny-direct-internet-egress"
    priority                   = 310
    direction                  = "Outbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "Internet"
    description                = "Bloquea Internet directo; solo HTTPS permitido arriba y enrutado por Firewall."
  }

  security_rule {
    name                       = "deny-all-outbound"
    priority                   = 320
    direction                  = "Outbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
    description                = "Cierre explícito para evitar las reglas salientes predeterminadas de Azure."
  }

  # Azure's built-in DenyAllInBound is the final inbound rule. No SSH, Wazuh API, or Indexer port is opened.
}

resource "azurerm_subnet_network_security_group_association" "siem" {
  subnet_id                 = azurerm_subnet.siem.id
  network_security_group_id = azurerm_network_security_group.siem.id
}

resource "azurerm_route_table" "siem" {
  name                          = "rt-${var.name_base}-siem"
  location                      = var.location
  resource_group_name           = var.resource_group_name
  bgp_route_propagation_enabled = false
  tags                          = merge(var.tags, { service = "siem-host-egress" })

  route {
    name                   = "force-default-egress-through-azure-firewall"
    address_prefix         = "0.0.0.0/0"
    next_hop_type          = "VirtualAppliance"
    next_hop_in_ip_address = var.firewall_private_ip
  }
}

resource "azurerm_subnet_route_table_association" "siem" {
  subnet_id      = azurerm_subnet.siem.id
  route_table_id = azurerm_route_table.siem.id
}

resource "azurerm_user_assigned_identity" "siem" {
  name                = "id-${var.name_base}-siem"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = merge(var.tags, { service = "siem-host" })
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = var.container_registry_id
  role_definition_name = "AcrPull"
  principal_id         = local.identity.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "artifact_read" {
  scope                = var.artifact_container_scope_id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = local.identity.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "evidence_write" {
  for_each = var.evidence_container_scope_id == null ? toset([]) : toset([var.evidence_container_scope_id])

  scope                = each.value
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = local.identity.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "key_vault_secret_read" {
  for_each = toset(concat(values(var.core_secret_names), values(var.wazuh_secret_names)))

  scope                = "${trimsuffix(var.key_vault_id, "/")}/secrets/${each.value}"
  role_definition_name = "Key Vault Secrets User"
  principal_id         = local.identity.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_network_interface" "siem" {
  name                = local.nic_name
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = merge(var.tags, { service = "siem-host" })

  ip_configuration {
    name                          = "private"
    subnet_id                     = azurerm_subnet.siem.id
    private_ip_address_allocation = "Dynamic"
    primary                       = true
  }
}

resource "azurerm_managed_disk" "siem_data" {
  name                 = local.disk_name
  location             = var.location
  resource_group_name  = var.resource_group_name
  storage_account_type = var.data_disk_storage_account_type
  create_option        = "Empty"
  disk_size_gb         = var.data_disk_size_gb
  tags                 = merge(var.tags, { service = "siem-data", data_class = "security-sensitive" })

  lifecycle {
    prevent_destroy = true
  }

}

resource "azurerm_linux_virtual_machine" "siem" {
  name                            = local.vm_name
  computer_name                   = "qapaq-siem"
  location                        = var.location
  resource_group_name             = var.resource_group_name
  size                            = var.vm_size
  admin_username                  = var.admin_username
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.siem.id]
  custom_data                     = base64encode(local.cloud_init)
  encryption_at_host_enabled      = true
  secure_boot_enabled             = true
  vtpm_enabled                    = true
  patch_mode                      = "ImageDefault"
  tags                            = merge(var.tags, { service = "siem-host" })

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.admin_ssh_public_key
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [local.identity.id]
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = var.ubuntu_image_version
  }

  os_disk {
    name                 = "os-${var.name_base}-siem"
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = var.os_disk_size_gb
  }

  boot_diagnostics {}

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = !contains(var.dashboard_ingress_cidrs, "0.0.0.0/0")
      error_message = "No se permite exponer el Dashboard HTTPS a Internet completa."
    }

    precondition {
      condition     = !contains(var.agent_ingress_cidrs, "0.0.0.0/0")
      error_message = "No se permite exponer puertos de agentes Wazuh a Internet completa."
    }
  }

  depends_on = [
    azurerm_role_assignment.acr_pull,
    azurerm_role_assignment.artifact_read,
    azurerm_role_assignment.key_vault_secret_read,
    azurerm_role_assignment.evidence_write,
  ]
}

resource "azurerm_virtual_machine_data_disk_attachment" "siem_data" {
  managed_disk_id    = azurerm_managed_disk.siem_data.id
  virtual_machine_id = azurerm_linux_virtual_machine.siem.id
  lun                = 0
  caching            = "ReadWrite"
}

resource "azurerm_virtual_machine_extension" "siem_bootstrap" {
  name                       = "qapaq-siem-bootstrap"
  virtual_machine_id         = azurerm_linux_virtual_machine.siem.id
  publisher                  = "Microsoft.Azure.Extensions"
  type                       = "CustomScript"
  type_handler_version       = "2.1"
  auto_upgrade_minor_version = false
  automatic_upgrade_enabled  = false
  tags                       = merge(var.tags, { service = "siem-bootstrap" })

  protected_settings = jsonencode({
    script = base64encode(local.bootstrap_extension_script)
  })

  depends_on = [
    azurerm_virtual_machine_data_disk_attachment.siem_data,
    azurerm_role_assignment.acr_pull,
    azurerm_role_assignment.artifact_read,
    azurerm_role_assignment.key_vault_secret_read,
    azurerm_role_assignment.evidence_write,
  ]
}
