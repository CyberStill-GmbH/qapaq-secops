# Producción: protecciones activas. Los valores de Object Lock los fija Legal (U-004);
# COMPLIANCE es irreversible: confirmar audit_lock_days antes del primer apply.
project     = "qapaq"
environment = "prod"
aws_region  = "us-east-1"

allowed_admin_cidrs = ["203.0.113.0/28"]
agent_cidrs         = ["198.51.100.0/24"]
alert_email         = "soc-alerts@example.com"
monthly_budget_usd  = 1500

az_count                        = 2
enable_interface_endpoints      = true
interface_endpoint_subnet_count = 2
enable_flow_logs                = true
enable_guardduty                = true
enable_security_hub             = true
enable_cloudtrail               = true
enable_waf                      = true
enable_qapaqzito                    = true
qapaqzito_provider                  = "bedrock"
qapaqzito_model                     = "claude-opus-5-5"

aurora_min_capacity          = 0.5
aurora_max_capacity          = 16
aurora_instance_count        = 2
aurora_backup_retention_days = 14
deletion_protection          = true

wazuh_instance_type           = "m7g.xlarge"
wazuh_root_volume_gb          = 300
wazuh_snapshot_retention_days = 14

audit_lock_mode    = "COMPLIANCE"
audit_lock_days    = 365
log_retention_days = 90

api_reserved_concurrency = 50
worker_max_concurrency   = 10

agent_target_mode       = "all"
agent_default_group     = "default"
hybrid_activation_limit = 50

# domain_name     = "soc.example.com"
# certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/..."
# entra_tenant_id = "00000000-0000-0000-0000-000000000000"
# entra_client_id = "00000000-0000-0000-0000-000000000000"
# github_repository = "org/qapaq-secops"
