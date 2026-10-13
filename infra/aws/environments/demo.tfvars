aws_region  = "us-east-1"
project     = "qapaq-secops"
environment = "demo"
vpc_cidr    = "10.0.0.0/16"
az_count    = 2

# Empty means no inbound path to the Wazuh Dashboard.
allowed_admin_cidrs = []

# Public application traffic must terminate TLS at the ALB; Terraform requires
# an ACM certificate ARN in this region before planning or applying.
enable_https                  = true
public_api_hostname           = "api.jappi.net.pe"
public_route53_zone_name      = "api.jappi.net.pe"
public_root_route53_zone_name = "jappi.net.pe"
wazuh_version                 = "4.14.8"
wazuh_instance_type           = "t3.xlarge"
wazuh_volume_size_gb          = 100

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

# Verified Fase 2C manifest: image digests are immutable and must not be replaced by tags.
runtime_image_manifest_commit = "3dd5fcb0f1afbade3b4454e88456ca22bb27a770"
runtime_image_digests = {
  api     = "sha256:f651fb8a0e961503ddf5ab28cb5ff39e214d9936c89d487aa9df869f020f5550"
  worker  = "sha256:cfd30e222acf54e86ff0f59a1e6884efbbd5bdafc21a7861c6e83095c1c8c342"
  krakend = "sha256:491cc5cb797f4757a0c58e52679ebb9ab3f8a06b268c9540171f2dc1043b23ed"
}
migrator_image_digest = "sha256:4dc9cc9f440a7f5769efcb50acf53d598b603e0306067cf90eca8aeb187bcf22"
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
  # del grupo de admisión recibe admin por `soc_group_owner_oids` (variable de GitHub).
  QAPAQ_ROLE_BINDINGS = "707e3194-cdbe-4072-b17e-712c4e5fdadb=qapaq.soc.analyst"
}

runtime_krakend_environment = {
  OIDC_ISSUER   = "https://login.microsoftonline.com/45f2f938-dbe3-4a3e-8a54-930893f94ef8/v2.0"
  OIDC_JWKS_URL = "https://login.microsoftonline.com/45f2f938-dbe3-4a3e-8a54-930893f94ef8/discovery/v2.0/keys"
  OIDC_AUDIENCE = "336d44fe-b99d-4cfd-9c6e-0ed2d7e48998"
}

# Sprint 5 — demo operativo sin pasos manuales (docs/deployment/sprint5-activacion.md).
# Wazuh se inicializa por SSM en el apply: lector del Indexer, proxy TLS privado, usuario admin
# local (`qapaq-admin`, contraseña en Secrets Manager) y usuario analista de solo lectura, más la
# recolección de Office 365 con la misma app de Entra del API.
wazuh_bootstrap_enabled = true
wazuh_analyst_username  = "cguevara@qapaq.pe"
wazuh_office365_enabled = true
# Ingesta Wazuh → SOC por KrakenD con token de workload de la app del API.
wazuh_ingestion_enabled = true
# Padrón por Graph: el API resuelve el grupo por nombre; los dueños son admin automáticamente.
soc_directory_group_name = "QAPAQ-SecOps-Users"
# Avisos: si Teams no confirma la entrega, el aviso sale por correo desde este buzón (Mail.Send
# de la app del API). Teams se activa con teams_notifications_enabled cuando exista el secreto.
alert_mail_sender = "cguevara@qapaq.pe"

