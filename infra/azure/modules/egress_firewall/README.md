# Módulo `egress_firewall`

Azure Firewall Standard con IP pública estática, policy con threat intelligence en modo `Deny`, proxy DNS, allowlist HTTPS por FQDN, reglas de plataforma para Container Apps privadas y DNAT de entrada al Load Balancer interno del SIEM. Solo existe cuando `siem_host` está configurado.

<!-- BEGIN_TF_DOCS -->

## Requirements

| Name    | Version            |
| ------- | ------------------ |
| azurerm | >= 4.62.0, < 5.0.0 |

## Providers

| Name    | Source            |
| ------- | ----------------- |
| azurerm | hashicorp/azurerm |

## Modules

No modules.

## Resources

| Name                                                                                                                                                                          | Type     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [azurerm_firewall.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/firewall)                                                             | resource |
| [azurerm_firewall_policy.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/firewall_policy)                                               | resource |
| [azurerm_firewall_policy_rule_collection_group.egress](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/firewall_policy_rule_collection_group) | resource |
| [azurerm_monitor_diagnostic_setting.nat_ingress](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/monitor_diagnostic_setting)                  | resource |
| [azurerm_public_ip.firewall](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/public_ip)                                                       | resource |

## Inputs

| Name                                | Description                                                                                          | Type          | Default                                                                                                                                                                                                                                                                                                                           | Required |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------: |
| log_analytics_workspace_id          | Workspace de Azure Monitor que recibe los logs NAT estructurados del Firewall.                       | `string`      | n/a                                                                                                                                                                                                                                                                                                                               |   yes    |
| source_cidrs                        | Private workload subnets allowed to use the explicitly listed HTTPS destinations.                    | `set(string)` | n/a                                                                                                                                                                                                                                                                                                                               |   yes    |
| allowed_fqdns                       | Explicit HTTPS egress allowlist for Ubuntu, Entra, Graph, Teams Workflows and VirusTotal.            | `set(string)` | <pre>[<br/> "archive.ubuntu.com",<br/> "azure.archive.ubuntu.com",<br/> "graph.microsoft.com",<br/> "login.microsoftonline.com",<br/> "packages.microsoft.com",<br/> "_.logic.azure.com",<br/> "_.api.powerplatform.com",<br/> "security.ubuntu.com",<br/> "api.virustotal.com",<br/> "acme-v02.api.letsencrypt.org",<br/>]</pre> |    no    |
| container_apps_allowed_fqdns        | Exact ACA platform/registry/Entra FQDNs allowed through the firewall, scoped to ACA source CIDRs.    | `set(string)` | `[]`                                                                                                                                                                                                                                                                                                                              |    no    |
| container_apps_allowed_service_tags | Azure service tags required by private ACA with UDR, scoped to ACA source CIDRs.                     | `set(string)` | `[]`                                                                                                                                                                                                                                                                                                                              |    no    |
| container_apps_source_cidrs         | Subnets of private ACA environments routed through this firewall; empty means no ACA-specific rules. | `set(string)` | `[]`                                                                                                                                                                                                                                                                                                                              |    no    |
| dashboard_ingress_cidrs             | CIDR aprobados para HTTPS público al Dashboard. Vacío no crea regla DNAT HTTPS.                      | `set(string)` | `[]`                                                                                                                                                                                                                                                                                                                              |    no    |
| ingress_http_enabled                | Publica HTTP solo para el challenge ACME HTTP-01 y la redirección HTTPS del edge.                    | `bool`        | `true`                                                                                                                                                                                                                                                                                                                            |    no    |
| ingress_lb_private_ip               | IPv4 privada fija del Load Balancer interno que recibe el DNAT público del SIEM.                     | `string`      | `null`                                                                                                                                                                                                                                                                                                                            |    no    |

## Outputs

| Name               | Description                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| policy_id          | Standard FQDN-filtering policy attached to the SIEM egress firewall.                                           |
| private_ip_address | Private next-hop IP used by the isolated SIEM and Ankay subnet route tables.                                   |
| public_ip_address  | Stable public egress and QAPAQ SIEM DNAT entry IP; DNS must be changed separately after health/TLS validation. |

<!-- END_TF_DOCS -->
