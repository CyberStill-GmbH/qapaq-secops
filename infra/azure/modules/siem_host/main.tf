locals {
  subnet_name           = "snet-${var.name_base}-siem"
  nsg_name              = "nsg-${var.name_base}-siem"
  nic_name              = "nic-${var.name_base}-siem"
  vm_name               = "vm-${var.name_base}-siem"
  disk_name             = "disk-${var.name_base}-siem-data"
  identity              = azurerm_user_assigned_identity.siem
  ingress_lb_private_ip = var.ingress_lb_private_ip == null ? cidrhost(var.address_prefix, 10) : var.ingress_lb_private_ip

  cloud_init = "#cloud-config\n${yamlencode({
    write_files = [{
      path        = "/usr/local/sbin/qapaq-siem-bootstrap.py"
      owner       = "root:root"
      permissions = "0700"
      content     = file("${path.module}/bootstrap-siem.py")
      }, {
      path        = "/usr/local/sbin/indexer_read_proxy.py"
      owner       = "root:root"
      permissions = "0600"
      content     = file("${path.module}/indexer_read_proxy.py")
    }]
  })}"

  bootstrap_config = jsonencode({
    artifact_url       = var.bootstrap_bundle_blob_url
    artifact_sha256    = var.bootstrap_bundle_sha256
    identity_client_id = azurerm_user_assigned_identity.siem.client_id
    key_vault_uri      = trimsuffix(var.key_vault_uri, "/")
    core_secret_names  = var.core_secret_names
    wazuh_secret_names = var.wazuh_secret_names
    provider_ingestion = var.provider_ingestion
    core_environment   = var.core_environment
    office365          = var.office365
    indexer_read_proxy = var.indexer_proxy == null ? null : {
      private_ip_address   = var.private_ip_address
      reader_secret_name   = var.indexer_proxy.reader_secret_name
      proxy_ca_secret_name = var.indexer_proxy.proxy_ca_secret_name
    }
    data_disk_size_gb = var.data_disk_size_gb
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
    for_each = var.ingress_http_enabled ? { http = true } : {}
    content {
      name                       = "allow-acme-http-via-firewall-dnat"
      priority                   = 102
      direction                  = "Inbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_port_range          = "*"
      destination_port_range     = "80"
      source_address_prefix      = var.firewall_private_ip
      destination_address_prefix = "*"
      description                = "HTTP llega por DNAT/SNAT del Firewall; el edge sirve ACME y redirige a HTTPS."
    }
  }

  dynamic "security_rule" {
    for_each = length(var.dashboard_ingress_cidrs) == 0 ? {} : { https = var.dashboard_ingress_cidrs }
    content {
      name                       = "allow-dashboard-https-approved-sources"
      priority                   = 103
      direction                  = "Inbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_port_range          = "*"
      destination_port_range     = "443"
      source_address_prefix      = var.firewall_private_ip
      destination_address_prefix = "*"
      description                = "El Firewall SNATea el flujo DNAT; el backend solo acepta su IP privada. La allowlist del cliente se evalúa en la regla DNAT."
    }
  }

  dynamic "security_rule" {
    for_each = var.ingress_http_enabled ? { http = true } : {}
    content {
      name                       = "allow-lb-health-probe-http"
      priority                   = 100
      direction                  = "Inbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_port_range          = "*"
      destination_port_range     = "80"
      source_address_prefix      = "AzureLoadBalancer"
      destination_address_prefix = "*"
      description                = "Health probe HTTP del Load Balancer interno."
    }
  }

  security_rule {
    name                       = "allow-lb-health-probe-https"
    priority                   = 101
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "AzureLoadBalancer"
    destination_address_prefix = "*"
    description                = "Health probe HTTPS del Load Balancer interno."
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

  dynamic "security_rule" {
    for_each = length(var.krakend_source_cidrs) == 0 ? {} : { krakend = var.krakend_source_cidrs }
    content {
      name                       = "allow-indexer-read-proxy-from-krakend"
      priority                   = 120
      direction                  = "Inbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_port_range          = "*"
      destination_port_range     = "9443"
      source_address_prefixes    = tolist(security_rule.value)
      destination_address_prefix = "*"
      description                = "Solo KrakenD privado puede alcanzar el proxy TLS read-only del Indexer en 9443."
    }
  }

  security_rule {
    name                       = "deny-direct-indexer-vnet-access"
    priority                   = 121
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "9200"
    source_address_prefix      = "VirtualNetwork"
    destination_address_prefix = "*"
    description                = "El Indexer permanece interno; ninguna subred VNet accede directamente al puerto de administración/búsqueda."
  }

  security_rule {
    name                       = "deny-indexer-proxy-from-other-vnet"
    priority                   = 122
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "9443"
    source_address_prefix      = "VirtualNetwork"
    destination_address_prefix = "*"
    description                = "Tras la allowlist ACA anterior, y aunque KrakenD esté apagado, evita que otros workloads VNet consulten el proxy."
  }

  # The subnet has no default outbound access. Only private dependencies and HTTP/S routed
  # through the explicitly required Azure Firewall are allowed; explicit denies precede Azure's
  # built-in AllowVnetOutBound/AllowInternetOutBound rules.
  # DNS (168.63.129.16), IMDS (169.254.169.254) y WireServer no pasan por el NSG mientras no
  # se los nombre con sus service tags, y Azure solo admite esos tags en reglas Deny. Por eso
  # no hay reglas Allow para ellos: el deny de egress general no los alcanza.

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
  count = var.manage_artifact_read_assignment ? 1 : 0

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

# The host may get/set only the two pre-created values used by the opt-in
# KrakenD proxy. The custom role contains no list, delete, or vault-management
# actions and is assigned at each exact Key Vault secret scope.
resource "azurerm_role_assignment" "indexer_proxy_secret_seed" {
  for_each = var.indexer_proxy == null ? {} : {
    reader = var.indexer_proxy.reader_secret_name
    ca     = var.indexer_proxy.proxy_ca_secret_name
  }

  scope              = "${trimsuffix(var.key_vault_id, "/")}/secrets/${each.value}"
  role_definition_id = var.indexer_proxy_secret_role_definition_id
  principal_id       = local.identity.principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_network_interface" "siem" {
  name                = local.nic_name
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = merge(var.tags, { service = "siem-host" })

  ip_configuration {
    name                          = "private"
    subnet_id                     = azurerm_subnet.siem.id
    private_ip_address_allocation = var.private_ip_address == null ? "Dynamic" : "Static"
    private_ip_address            = var.private_ip_address
    primary                       = true
  }
}

# El Firewall público aplica DNAT y el Load Balancer interno distribuye tráfico al host
# privado. La VM no recibe IP pública; el default route al Firewall conserva retorno simétrico.
resource "azurerm_lb" "siem_ingress" {
  name                = "lb-${var.name_base}-siem-internal"
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = "Standard"
  tags                = merge(var.tags, { service = "siem-ingress" })

  frontend_ip_configuration {
    name                          = "siem-private"
    subnet_id                     = azurerm_subnet.siem.id
    private_ip_address            = local.ingress_lb_private_ip
    private_ip_address_allocation = "Static"
  }
}

resource "azurerm_lb_backend_address_pool" "siem_ingress" {
  name            = "backend-siem"
  loadbalancer_id = azurerm_lb.siem_ingress.id
}

resource "azurerm_network_interface_backend_address_pool_association" "siem_ingress" {
  network_interface_id    = azurerm_network_interface.siem.id
  ip_configuration_name   = "private"
  backend_address_pool_id = azurerm_lb_backend_address_pool.siem_ingress.id
}

resource "azurerm_lb_probe" "siem_https" {
  name                = "probe-https"
  loadbalancer_id     = azurerm_lb.siem_ingress.id
  protocol            = "Tcp"
  port                = 443
  interval_in_seconds = 15
  number_of_probes    = 2
}

resource "azurerm_lb_rule" "siem_https" {
  name                           = "https"
  loadbalancer_id                = azurerm_lb.siem_ingress.id
  protocol                       = "Tcp"
  frontend_port                  = 443
  backend_port                   = 443
  frontend_ip_configuration_name = "siem-private"
  backend_address_pool_ids       = [azurerm_lb_backend_address_pool.siem_ingress.id]
  probe_id                       = azurerm_lb_probe.siem_https.id
  disable_outbound_snat          = true
  tcp_reset_enabled              = true
  idle_timeout_in_minutes        = 15
}

resource "azurerm_lb_probe" "siem_http" {
  count               = var.ingress_http_enabled ? 1 : 0
  name                = "probe-http"
  loadbalancer_id     = azurerm_lb.siem_ingress.id
  protocol            = "Tcp"
  port                = 80
  interval_in_seconds = 15
  number_of_probes    = 2
}

resource "azurerm_lb_rule" "siem_http" {
  count                          = var.ingress_http_enabled ? 1 : 0
  name                           = "http-acme"
  loadbalancer_id                = azurerm_lb.siem_ingress.id
  protocol                       = "Tcp"
  frontend_port                  = 80
  backend_port                   = 80
  frontend_ip_configuration_name = "siem-private"
  backend_address_pool_ids       = [azurerm_lb_backend_address_pool.siem_ingress.id]
  probe_id                       = azurerm_lb_probe.siem_http[0].id
  disable_outbound_snat          = true
  tcp_reset_enabled              = true
  idle_timeout_in_minutes        = 15
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
    azurerm_role_assignment.indexer_proxy_secret_seed,
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
    azurerm_role_assignment.indexer_proxy_secret_seed,
    azurerm_role_assignment.evidence_write,
  ]
}
