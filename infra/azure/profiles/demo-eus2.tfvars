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

tags = {
  project     = "qapaq-secops"
  environment = "demo-eus2"
  managed_by  = "terraform"
  cloud       = "azure"
  data_class  = "security-sensitive"
}
