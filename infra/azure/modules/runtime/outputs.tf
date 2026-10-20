output "edge_default_fqdn" {
  description = "FQDN temporal administrado por Azure para el edge, si el runtime está activo."
  value       = try(azurerm_container_app.runtime["edge"].ingress[0].fqdn, null)
}
