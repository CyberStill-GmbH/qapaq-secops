aws_region  = "us-east-1"
project     = "qapaq-secops"
environment = "demo"
vpc_cidr    = "10.0.0.0/16"
az_count    = 2

# Empty means no inbound path to the Wazuh Dashboard.
allowed_admin_cidrs = []

# Phase 1 uses the temporary public HTTP ALB ingress only.
enable_https = false
