resource "aws_security_group" "alb" {
  name        = "${var.project}-${var.environment}-alb"
  description = "Public web ingress terminates at the ALB."
  vpc_id      = var.vpc_id

  tags = { Name = "${var.project}-${var.environment}-alb" }
}

resource "aws_security_group" "krakend" {
  name        = "${var.project}-${var.environment}-krakend"
  description = "KrakenD accepts public application traffic from the ALB and internal Wazuh queries from API/worker."
  vpc_id      = var.vpc_id

  tags = { Name = "${var.project}-${var.environment}-krakend" }
}

resource "aws_security_group" "api" {
  name        = "${var.project}-${var.environment}-api"
  description = "QAPAQ API accepts traffic only from KrakenD."
  vpc_id      = var.vpc_id

  tags = { Name = "${var.project}-${var.environment}-api" }
}

resource "aws_security_group" "worker" {
  name        = "${var.project}-${var.environment}-worker"
  description = "QAPAQ worker has no inbound listeners."
  vpc_id      = var.vpc_id

  tags = { Name = "${var.project}-${var.environment}-worker" }
}

resource "aws_security_group" "postgres" {
  name        = "${var.project}-${var.environment}-postgres"
  description = "RDS PostgreSQL accepts traffic only from API and worker."
  vpc_id      = var.vpc_id

  tags = { Name = "${var.project}-${var.environment}-postgres" }
}

resource "aws_security_group" "redis" {
  name        = "${var.project}-${var.environment}-redis"
  description = "Redis/Valkey accepts traffic only from API and worker."
  vpc_id      = var.vpc_id

  tags = { Name = "${var.project}-${var.environment}-redis" }
}

resource "aws_security_group" "wazuh" {
  name        = "${var.project}-${var.environment}-wazuh"
  description = "Wazuh dashboard is closed by default; Indexer is reachable only through KrakenD."
  vpc_id      = var.vpc_id

  tags = { Name = "${var.project}-${var.environment}-wazuh" }
}

resource "aws_security_group" "public_proxy" {
  name        = "${var.project}-${var.environment}-public-proxy"
  description = "Public HTTPS edge for Wazuh and QAPAQ API; no SSH ingress."
  vpc_id      = var.vpc_id

  tags = { Name = "${var.project}-${var.environment}-public-proxy" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  count             = var.enable_https ? 1 : 0
  security_group_id = aws_security_group.alb.id
  description       = "Public HTTP demo entry point."
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  ip_protocol       = "tcp"
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "alb_http_from_proxy" {
  count = var.enable_https ? 0 : 1

  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.public_proxy.id
  description                  = "HTTP from the HTTPS public edge only."
  from_port                    = 80
  ip_protocol                  = "tcp"
  to_port                      = 80
}

resource "aws_vpc_security_group_ingress_rule" "public_proxy_http" {
  security_group_id = aws_security_group.public_proxy.id
  description       = "ACME HTTP-01 validation and HTTP to HTTPS redirect."
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  ip_protocol       = "tcp"
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "public_proxy_https" {
  security_group_id = aws_security_group.public_proxy.id
  description       = "Public HTTPS for Wazuh Dashboard and the QAPAQ web API."
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  ip_protocol       = "tcp"
  to_port           = 443
}

# La instancia Wazuh all-in-one necesita salida a internet: paquetes del SO y de Wazuh, APIs de AWS (SSM, Secrets Manager) y renovación ACME por HTTPS. Los destinos no son
# fijos (CDN de paquetes, endpoints regionales de AWS, ACME), así que no se puede acotar por IP.
#trivy:ignore:AWS-0104
resource "aws_vpc_security_group_egress_rule" "public_proxy_https" {
  security_group_id = aws_security_group.public_proxy.id
  description       = "HTTPS egress for package repositories, AWS APIs, and ACME certificate issuance/renewal."
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  ip_protocol       = "tcp"
  to_port           = 443
}

# La instancia Wazuh all-in-one necesita salida a internet: espejos de paquetes y validación ACME HTTP-01 del certificado por IP. Los destinos no son
# fijos (CDN de paquetes, endpoints regionales de AWS, ACME), así que no se puede acotar por IP.
#trivy:ignore:AWS-0104
resource "aws_vpc_security_group_egress_rule" "public_proxy_http" {
  security_group_id = aws_security_group.public_proxy.id
  description       = "HTTP egress for package mirrors and ACME IP certificate validation."
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  ip_protocol       = "tcp"
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "public_proxy_to_alb" {
  security_group_id            = aws_security_group.public_proxy.id
  referenced_security_group_id = aws_security_group.alb.id
  description                  = "HTTPS edge proxy to the private-by-SG HTTP ALB origin."
  from_port                    = 80
  ip_protocol                  = "tcp"
  to_port                      = 80
}

# Edge unificado (wazuh/edge): nginx del host Wazuh -> API por Cloud Map, dentro de la VPC.
# Por el ALB público la API vería la EIP del host como cliente (fuera de la cadena de
# proxies confiables) y la política de red trataría a todos como externos.
resource "aws_vpc_security_group_egress_rule" "public_proxy_to_api" {
  security_group_id            = aws_security_group.public_proxy.id
  referenced_security_group_id = aws_security_group.api.id
  description                  = "Unified edge to QAPAQ API over the private network."
  from_port                    = var.api_port
  ip_protocol                  = "tcp"
  to_port                      = var.api_port
}

resource "aws_vpc_security_group_ingress_rule" "api_from_public_proxy" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.public_proxy.id
  description                  = "QAPAQ API from the unified edge on the Wazuh host."
  from_port                    = var.api_port
  ip_protocol                  = "tcp"
  to_port                      = var.api_port
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each = var.enable_https ? toset(["enabled"]) : toset([])

  security_group_id = aws_security_group.alb.id
  description       = "Public HTTPS demo entry point when configured."
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  ip_protocol       = "tcp"
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "krakend_from_alb" {
  security_group_id            = aws_security_group.krakend.id
  referenced_security_group_id = aws_security_group.alb.id
  description                  = "ALB to KrakenD."
  from_port                    = var.krakend_port
  ip_protocol                  = "tcp"
  to_port                      = var.krakend_port
}

resource "aws_vpc_security_group_ingress_rule" "krakend_from_api" {
  security_group_id            = aws_security_group.krakend.id
  referenced_security_group_id = aws_security_group.api.id
  description                  = "Internal API queries through KrakenD to Wazuh."
  from_port                    = var.krakend_port
  ip_protocol                  = "tcp"
  to_port                      = var.krakend_port
}

resource "aws_vpc_security_group_ingress_rule" "krakend_from_worker" {
  security_group_id            = aws_security_group.krakend.id
  referenced_security_group_id = aws_security_group.worker.id
  description                  = "Internal worker queries through KrakenD to Wazuh."
  from_port                    = var.krakend_port
  ip_protocol                  = "tcp"
  to_port                      = var.krakend_port
}

resource "aws_vpc_security_group_ingress_rule" "api_from_krakend" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.krakend.id
  description                  = "KrakenD to QAPAQ API."
  from_port                    = var.api_port
  ip_protocol                  = "tcp"
  to_port                      = var.api_port
}

resource "aws_vpc_security_group_ingress_rule" "postgres_from_api" {
  security_group_id            = aws_security_group.postgres.id
  referenced_security_group_id = aws_security_group.api.id
  description                  = "PostgreSQL from API tasks."
  from_port                    = var.postgres_port
  ip_protocol                  = "tcp"
  to_port                      = var.postgres_port
}

resource "aws_vpc_security_group_ingress_rule" "postgres_from_worker" {
  security_group_id            = aws_security_group.postgres.id
  referenced_security_group_id = aws_security_group.worker.id
  description                  = "PostgreSQL from worker tasks."
  from_port                    = var.postgres_port
  ip_protocol                  = "tcp"
  to_port                      = var.postgres_port
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_api" {
  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = aws_security_group.api.id
  description                  = "Redis/Valkey from API tasks."
  from_port                    = var.redis_port
  ip_protocol                  = "tcp"
  to_port                      = var.redis_port
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_worker" {
  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = aws_security_group.worker.id
  description                  = "Redis/Valkey from worker tasks."
  from_port                    = var.redis_port
  ip_protocol                  = "tcp"
  to_port                      = var.redis_port
}

resource "aws_vpc_security_group_ingress_rule" "wazuh_indexer_from_krakend" {
  security_group_id            = aws_security_group.wazuh.id
  referenced_security_group_id = aws_security_group.krakend.id
  description                  = "Wazuh Indexer only through KrakenD."
  from_port                    = var.wazuh_indexer_port
  ip_protocol                  = "tcp"
  to_port                      = var.wazuh_indexer_port
}

resource "aws_vpc_security_group_ingress_rule" "wazuh_dashboard_admin" {
  for_each = toset(var.allowed_admin_cidrs)

  security_group_id = aws_security_group.wazuh.id
  description       = "Wazuh Dashboard restricted to explicitly approved admin networks."
  cidr_ipv4         = each.key
  from_port         = var.wazuh_dashboard_port
  ip_protocol       = "tcp"
  to_port           = var.wazuh_dashboard_port
}

resource "aws_vpc_security_group_egress_rule" "alb_to_krakend" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.krakend.id
  description                  = "ALB health checks and app traffic to KrakenD."
  from_port                    = var.krakend_port
  ip_protocol                  = "tcp"
  to_port                      = var.krakend_port
}

resource "aws_vpc_security_group_egress_rule" "krakend_to_api" {
  security_group_id            = aws_security_group.krakend.id
  referenced_security_group_id = aws_security_group.api.id
  description                  = "KrakenD to QAPAQ API."
  from_port                    = var.api_port
  ip_protocol                  = "tcp"
  to_port                      = var.api_port
}

resource "aws_vpc_security_group_egress_rule" "krakend_to_wazuh" {
  security_group_id            = aws_security_group.krakend.id
  referenced_security_group_id = aws_security_group.wazuh.id
  description                  = "KrakenD to Wazuh Indexer."
  from_port                    = var.wazuh_indexer_port
  ip_protocol                  = "tcp"
  to_port                      = var.wazuh_indexer_port
}

resource "aws_vpc_security_group_egress_rule" "api_to_postgres" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.postgres.id
  description                  = "API database connections."
  from_port                    = var.postgres_port
  ip_protocol                  = "tcp"
  to_port                      = var.postgres_port
}

resource "aws_vpc_security_group_egress_rule" "worker_to_postgres" {
  security_group_id            = aws_security_group.worker.id
  referenced_security_group_id = aws_security_group.postgres.id
  description                  = "Worker database connections."
  from_port                    = var.postgres_port
  ip_protocol                  = "tcp"
  to_port                      = var.postgres_port
}

resource "aws_vpc_security_group_egress_rule" "api_to_redis" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.redis.id
  description                  = "API cache and queue connections."
  from_port                    = var.redis_port
  ip_protocol                  = "tcp"
  to_port                      = var.redis_port
}

resource "aws_vpc_security_group_egress_rule" "worker_to_redis" {
  security_group_id            = aws_security_group.worker.id
  referenced_security_group_id = aws_security_group.redis.id
  description                  = "Worker queue connections."
  from_port                    = var.redis_port
  ip_protocol                  = "tcp"
  to_port                      = var.redis_port
}

resource "aws_vpc_security_group_egress_rule" "api_to_krakend" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.krakend.id
  description                  = "API Wazuh requests go through the gateway."
  from_port                    = var.krakend_port
  ip_protocol                  = "tcp"
  to_port                      = var.krakend_port
}

resource "aws_vpc_security_group_egress_rule" "worker_to_krakend" {
  security_group_id            = aws_security_group.worker.id
  referenced_security_group_id = aws_security_group.krakend.id
  description                  = "Worker Wazuh requests go through the gateway."
  from_port                    = var.krakend_port
  ip_protocol                  = "tcp"
  to_port                      = var.krakend_port
}

# Microsoft Graph/Teams service addresses rotate. This private worker egress is limited to TCP 443
# through the NAT; replace with a managed domain allowlist before the exception expires.
#trivy:ignore:AWS-0104:exp:2027-04-14
resource "aws_vpc_security_group_egress_rule" "worker_to_external_https" {
  security_group_id = aws_security_group.worker.id
  description       = "HTTPS egress for Microsoft Graph, Teams Workflows, and approved notification providers through the private-subnet NAT."
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  ip_protocol       = "tcp"
  to_port           = 443
}
