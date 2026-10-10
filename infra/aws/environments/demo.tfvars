aws_region  = "us-east-1"
project     = "qapaq-secops"
environment = "demo"
vpc_cidr    = "10.0.0.0/16"
az_count    = 2

# Empty means no inbound path to the Wazuh Dashboard.
allowed_admin_cidrs = []

# Public application traffic must terminate TLS at the ALB; Terraform requires
# an ACM certificate ARN in this region before planning or applying.
enable_https             = false
public_api_hostname      = null
public_route53_zone_name = "qapaq.secops.com"
wazuh_version            = "4.14.8"
wazuh_instance_type      = "t3.xlarge"
wazuh_volume_size_gb     = 100

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
runtime_image_manifest_commit = "5ea083bd6dccf12580d00b43ee66d1086c0e06ea"
runtime_image_digests = {
  api     = "sha256:400a87f68017d2726927f2266aef22c9e425dd5456a9157c8acd2eba26ae5bac"
  worker  = "sha256:b55d7073deb4cc2895e625e70a81289f351983be66cc61146fd7a815d07e534e"
  krakend = "sha256:f0ff76bc10211244b85b5cc27c51f21b6c34587469f79af0b5f824c6075671b3"
}

# Public Vercel-origin requests pass through the private KrakenD/API tasks.
runtime_api_environment = {
  QAPAQ_ACCESS_ALLOWED_CIDRS        = "0.0.0.0/0,::/0"
  QAPAQ_ACCESS_TRUSTED_PROXY_CIDRS  = "10.0.0.0/16"
  QAPAQ_ENTRA_TENANT_ID             = "45f2f938-dbe3-4a3e-8a54-930893f94ef8"
  QAPAQ_ENTRA_CLIENT_ID             = "336d44fe-b99d-4cfd-9c6e-0ed2d7e48998"
  QAPAQ_ENTRA_REDIRECT_URI          = "https://app.jappi.net.pe/api/auth/callback"
  QAPAQ_ENTRA_ALLOWED_REDIRECT_URIS = "https://app.jappi.net.pe/api/auth/callback"
  QAPAQ_CONSOLE_BASE_URL            = "https://app.jappi.net.pe"
  QAPAQ_MVP_ROLE_BINDING_OID        = "707e3194-cdbe-4072-b17e-712c4e5fdadb"
  QAPAQ_MVP_ROLE_BINDING_ROLE       = "qapaq.soc.analyst"
  QAPAQ_MVP_ROLE_BINDING_EXPIRES_AT = "2026-10-11T04:59:59Z"
}

runtime_krakend_environment = {
  OIDC_ISSUER   = "https://login.microsoftonline.com/45f2f938-dbe3-4a3e-8a54-930893f94ef8/v2.0"
  OIDC_JWKS_URL = "https://login.microsoftonline.com/45f2f938-dbe3-4a3e-8a54-930893f94ef8/discovery/v2.0/keys"
  OIDC_AUDIENCE = "336d44fe-b99d-4cfd-9c6e-0ed2d7e48998"
}
