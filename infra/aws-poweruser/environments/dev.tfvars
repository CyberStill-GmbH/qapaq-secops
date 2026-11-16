allowed_admin_cidrs = ["38.250.148.109/32", "38.250.148.107/32", "168.181.8.186/32"]
agent_cidrs         = ["0.0.0.0/0"] # puertos 1514/1515 solo para agentes Wazuh (aprobado por el dueño, 2026-11-03)
ssh_public_key      = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMCGw4WUA8A+emnG64bpq2Gu2Q5n9M+BxKNgt1Bbvnks qapaq-soc-dev"
domain_name         = "dev.security.qapaq.pe"
monthly_budget_usd  = 300 # ~240 USD/mes esperados (EC2 r7i.xlarge, ALB, WAF, EBS, KMS)
instance_type       = "r7i.xlarge"
