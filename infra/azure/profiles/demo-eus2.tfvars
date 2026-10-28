# Perfil común del state aislado EUS2. Solo contiene parámetros no secretos.
# El workflow terraform-azure-demo-eus2.yml consume este archivo al crear el plan.
project                        = "qapaq-secops"
environment                    = "demo-eus2"
location                       = "eastus2"
address_space                  = "10.80.0.0/16"
postgres_admin_login           = "qapaqbootstrap"
postgres_sku_name              = "GP_Standard_D2s_v3"
postgres_storage_mb            = 32768
postgres_backup_retention_days = 14
enable_runtime                 = false
cost_budget_amount             = 200
cost_budget_start_date         = "2026-10-01T00:00:00Z"
cost_budget_end_date           = "2030-10-01T00:00:00Z"
cost_alert_emails              = ["cguevara@qapaq.pe"]

# Decisión del dueño (2026-10-27): ver las capacidades completas sin dimensionar para producción.
siem_firewall_sku_tier = "Basic"

tags = {
  project     = "qapaq-secops"
  environment = "demo-eus2"
  managed_by  = "terraform"
  cloud       = "azure"
  data_class  = "security-sensitive"
}

# La identidad de Terraform no puede asignar Storage Blob Data Reader (condición ABAC); un Owner
# lo asigna a la identidad del SIEM sobre el contenedor siem-release.
siem_artifact_read_assignment_managed = false
