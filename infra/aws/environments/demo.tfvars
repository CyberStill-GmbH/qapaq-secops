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
  api     = "sha256:5183b8dbc8a01f0870429837db0b4bfc7dc2867cc5e8a4b6b36f32d1e7c81068"
  worker  = "sha256:5b9bfd85b87f14ce0e4bad4d5ba784c9a8b5bb530e1963411fa846784d941624"
  krakend = "sha256:7223fd58694264dec9c2630314ab3234b45af70a7cb8c3c4f5ab3573af7a5460"
}
