aws_region  = "us-east-1"
project     = "qapaq-secops"
environment = "demo"
vpc_cidr    = "10.0.0.0/16"
az_count    = 2

# Empty means no inbound path to the Wazuh Dashboard.
allowed_admin_cidrs = []

# Public application traffic must terminate TLS at the ALB; Terraform requires
# an ACM certificate ARN in this region before planning or applying.
enable_https                      = true
public_api_hostname               = "api.jappi.net.pe"
public_route53_zone_name          = "api.jappi.net.pe"
public_root_route53_zone_name     = "jappi.net.pe"
wazuh_dashboard_hostname          = "app.jappi.net.pe"
wazuh_dashboard_legacy_hostname   = "wazuh.jappi.net.pe"
wazuh_dashboard_redirect_hostname = "qapaq-secops.jappi.net.pe"
siem_app_cutover                  = true
wazuh_version                     = "4.14.8"
wazuh_instance_type               = "t3.xlarge"
wazuh_volume_size_gb              = 100

# Phase 3: small, temporary data plane in isolated private data subnets.
postgres_engine_version            = "18.6"
postgres_instance_class            = "db.t4g.micro"
postgres_allocated_storage_gb      = 20
postgres_backup_retention_days     = 1
postgres_deletion_protection       = false
postgres_skip_final_snapshot       = true
postgres_final_snapshot_identifier = null
valkey_node_type                   = "cache.t4g.micro"
valkey_engine_version              = "8.0"

# Verified manifest from Publish verified images run 38851884156 (commit 2c87809).
# All digests below are immutable and must not be replaced by tags.
runtime_image_manifest_commit = "2c87809e938c10bc6411759e6d2923a67f1a90bd"
runtime_image_digests = {
  api     = "sha256:68836710cfab1d220862869e36dea526e1f7ddf7c506451aa76aa49a0729db35"
  worker  = "sha256:e260c7cd189f1746423b45c6ff418ccfbd3c2d5b95c31cdd692f06ac6001d211"
  krakend = "sha256:4bfec92a8b8e23660092f18dd0ba1be0b32c13a41b3c4597cc898e33a9329a73"
}
migrator_image_digest = "sha256:80fe9960f2c2e16c0d0cf2e051e5d962effa511472cd52a681e191b60a26a745"
# Estado SOC durable (PostgreSQL). Solo tras `bootstrap-roles` y `migrate` exitosos.
soc_database_enabled = true

# Public Vercel-origin requests pass through the private KrakenD/API tasks.
runtime_api_environment = {
  QAPAQ_ACCESS_ALLOWED_CIDRS        = "0.0.0.0/0,::/0"
  QAPAQ_ACCESS_TRUSTED_PROXY_CIDRS  = "10.0.0.0/16"
  QAPAQ_ENTRA_TENANT_ID             = "45f2f938-dbe3-4a3e-8a54-930893f94ef8"
  QAPAQ_ENTRA_CLIENT_ID             = "336d44fe-b99d-4cfd-9c6e-0ed2d7e48998"
  QAPAQ_ENTRA_REDIRECT_URI          = "https://app.jappi.net.pe/api/auth/callback"
  QAPAQ_ENTRA_ALLOWED_REDIRECT_URIS = "https://app.jappi.net.pe/api/auth/callback"
  QAPAQ_CONSOLE_BASE_URL            = "https://app.jappi.net.pe"
  # Sprint 5: asignación permanente (sin vencimiento) de la persona analista del demo. El dueño
  # del grupo de admisión recibe admin por `soc_group_owner_oids` (variable de GitHub); los
  # miembros del grupo de admisión, por `QAPAQ_ADMIN_GROUP_IDS` (identity.tf).
  QAPAQ_ROLE_BINDINGS = "707e3194-cdbe-4072-b17e-712c4e5fdadb=qapaq.soc.analyst"
  # Excepción temporal solo para el demo; vence en 24 h (hora Lima: 2026-10-16 22:41).
  # Se retira al terminar la prueba; no cambia MFA ni Conditional Access en Entra.
  QAPAQ_DEMO_MFA_EXCEPTION_UNTIL = "2026-10-17T03:41:30Z"
}

# El token de workload de la ingesta es v1.0 (scope `<clientid>/.default`, la app no expone
# `api://…`): su emisor es sts.windows.net, no login.microsoftonline.com/v2.0. KrakenD valida
# contra ese emisor; las claves de firma del tenant las sirve el mismo JWKS v2.0.
runtime_krakend_environment = {
  OIDC_ISSUER   = "https://sts.windows.net/45f2f938-dbe3-4a3e-8a54-930893f94ef8/"
  OIDC_JWKS_URL = "https://login.microsoftonline.com/45f2f938-dbe3-4a3e-8a54-930893f94ef8/discovery/v2.0/keys"
  OIDC_AUDIENCE = "336d44fe-b99d-4cfd-9c6e-0ed2d7e48998"
}

# Sprint 5 — demo operativo sin pasos manuales (docs/09-plan-de-lanzamiento.md).
# Wazuh se inicializa por SSM en el apply: lector del Indexer, proxy TLS privado, usuario admin
# local (`qapaq-admin`, contraseña en Secrets Manager) y usuario analista de solo lectura, más la
# recolección de Office 365 con la misma app de Entra del API.
wazuh_bootstrap_enabled = true
wazuh_analyst_username  = "cguevara@qapaq.pe"
wazuh_office365_enabled = true
# Ingesta Wazuh → SOC por KrakenD con token de workload de la app del API.
wazuh_ingestion_enabled = true
# Padrón por Graph: el API resuelve el grupo por nombre; los dueños son admin automáticamente.
soc_directory_group_id   = "bbf1d58b-19e6-4261-b196-5ebcd8176d85"
soc_directory_group_name = "Accesos_SOC"
# Avisos: si Teams no confirma la entrega, el aviso sale por correo desde este buzón (Mail.Send
# de la app del API). Teams se activa con teams_notifications_enabled cuando exista el secreto.
alert_mail_sender = "cguevara@qapaq.pe"

