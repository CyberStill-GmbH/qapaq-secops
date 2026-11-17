# Entorno de desarrollo: mínimo costo. Ajustar CIDRs y correo antes de aplicar.
project     = "qapaq"
environment = "dev"
aws_region  = "us-east-1"

allowed_admin_cidrs = ["38.250.148.109/32"]

# URL pública: zona security.qapaq.pe de la cuenta (certificado ACM y alias gestionados).
route53_zone_name  = "security.qapaq.pe"
domain_name        = "dev.security.qapaq.pe"
agent_cidrs        = []
alert_email        = ""
monthly_budget_usd = 250

az_count                        = 2
enable_interface_endpoints      = true
interface_endpoint_subnet_count = 1
enable_flow_logs                = false
enable_guardduty                = false
enable_security_hub             = false
enable_cloudtrail               = false
enable_waf                      = false
enable_qapaqzito                    = false

aurora_min_capacity             = 0
aurora_max_capacity             = 2
aurora_seconds_until_auto_pause = 600
aurora_instance_count           = 1
deletion_protection             = false

wazuh_instance_type           = "m7g.large"
wazuh_root_volume_gb          = 100
wazuh_snapshot_retention_days = 7

audit_lock_mode    = "GOVERNANCE"
audit_lock_days    = 7
log_retention_days = 14

agent_target_mode       = "tag"
hybrid_activation_limit = 0

# Despliegue de código desde GitHub Actions. El proveedor OIDC lo crea
# scripts/bootstrap-github-oidc.sh, por eso Terraform solo lo referencia.
github_repository           = "CyberStill-GmbH/qapaq-secops"
github_oidc_subject_prefix  = "repo:CyberStill-GmbH@220633794/qapaq-secops@1443659704"
create_github_oidc_provider = false
