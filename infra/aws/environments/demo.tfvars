aws_region  = "us-east-1"
project     = "qapaq-secops"
environment = "demo"
vpc_cidr    = "10.0.0.0/16"
az_count    = 2

# Empty means no inbound path to the Wazuh Dashboard.
allowed_admin_cidrs = []

# Phase 1 uses the temporary public HTTP ALB ingress only.
enable_https = false

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
