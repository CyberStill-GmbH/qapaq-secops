output "private_ip_address" {
  description = "Private next-hop IP used by the isolated SIEM and Ankay subnet route tables."
  value       = azurerm_firewall.this.ip_configuration[0].private_ip_address
}
output "policy_id" {
  description = "Standard FQDN-filtering policy attached to the SIEM egress firewall."
  value       = azurerm_firewall_policy.this.id
}
output "public_ip_address" {
  description = "Public source IP used for outbound allowlisting and egress diagnostics."
  value       = azurerm_public_ip.firewall.ip_address
}
