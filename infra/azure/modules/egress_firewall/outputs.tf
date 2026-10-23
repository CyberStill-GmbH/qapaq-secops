output "private_ip_address" {
  description = "Private next-hop IP used by the isolated SIEM and Ankay subnet route tables."
  value       = azurerm_firewall.this.ip_configuration[0].private_ip_address
}
output "policy_id" {
  description = "Standard FQDN-filtering policy attached to the SIEM egress firewall."
  value       = azurerm_firewall_policy.this.id
}
output "public_ip_address" {
  description = "Stable public egress and QAPAQ SIEM DNAT entry IP; DNS must be changed separately after health/TLS validation."
  value       = azurerm_public_ip.firewall.ip_address
}
