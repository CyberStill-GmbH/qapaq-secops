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
wazuh_dashboard_hostname      = "wazuh.jappi.net.pe"
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

# Verified manifest from Publish verified images run 38397376826 (commit e8fce18).
# All digests below are immutable and must not be replaced by tags.
runtime_image_manifest_commit = "e8fce18f53565230f26ce671a7b21d660d370c92"
runtime_image_digests = {
  api     = "sha256:e497641347315e4f4eadabbce3aa35d59aecbed0b52e875f4bdac7b14cca64cc"
  worker  = "sha256:5c9cc9eca2f15dba57f45a9ed5c0a15ef616d9acb2a909d9d23c43c1533b775e"
  krakend = "sha256:18c4b672889732130d90d50c53197c925470571962699ecfe4efc4e1ab3ab038"
}
migrator_image_digest = "sha256:b8c732340ac4cd2f8ce144cd1357d0668347f31db7c9012bfb65e2700da34ae1"
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
  # Excepción MFA solo-demo: una identidad ya autorizada de Accesos_SOC entra sin prueba de MFA
  # en el token hasta esta fecha. Temporal, para la demostración; se retira cuando el admin
  # configure MFA/passkey en Entra (ver rama secure-mfa-admission).
  QAPAQ_DEMO_MFA_EXCEPTION_UNTIL = "2026-10-27T23:59:00Z"
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

