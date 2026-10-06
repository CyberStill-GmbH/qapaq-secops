locals {
  interface_services = toset([
    "ecr.api",
    "ecr.dkr",
    "secretsmanager",
    "logs",
  ])
}

resource "aws_security_group" "this" {
  name        = "${var.project}-${var.environment}-vpce"
  description = "HTTPS ingress to private AWS service endpoints from approved runtime security groups."
  vpc_id      = var.vpc_id

  tags = {
    Name    = "${var.project}-${var.environment}-vpce"
    Purpose = "private-service-endpoints"
  }
}

resource "aws_vpc_security_group_ingress_rule" "runtime_https" {
  for_each = toset(var.runtime_security_group_ids)

  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = each.value
  description                  = "HTTPS from an explicitly authorized application runtime."
  from_port                    = 443
  ip_protocol                  = "tcp"
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "runtime_to_endpoints" {
  for_each = toset(var.runtime_security_group_ids)

  security_group_id            = each.value
  referenced_security_group_id = aws_security_group.this.id
  description                  = "HTTPS to explicitly configured AWS VPC endpoints."
  from_port                    = 443
  ip_protocol                  = "tcp"
  to_port                      = 443
}

resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_services

  vpc_id              = var.vpc_id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = var.app_subnet_ids
  security_group_ids  = [aws_security_group.this.id]
  private_dns_enabled = true

  tags = {
    Name            = "${var.project}-${var.environment}-${replace(each.key, ".", "-")}-vpce"
    EndpointService = each.key
  }
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = var.vpc_id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = var.app_route_table_ids

  tags = {
    Name            = "${var.project}-${var.environment}-s3-vpce"
    EndpointService = "s3"
  }
}
