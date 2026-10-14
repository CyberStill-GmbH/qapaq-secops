ephemeral "random_password" "auth_token" {
  length           = 64
  special          = true
  override_special = "!&#$^<>-"
  min_lower        = 1
  min_numeric      = 1
  min_special      = 1
  min_upper        = 1
}

resource "aws_elasticache_subnet_group" "this" {
  name        = "${var.project}-${var.environment}-data"
  description = "Private data subnets for QAPAQ SECOPS demo Valkey."
  subnet_ids  = var.subnet_ids

  tags = {
    Name    = "${var.project}-${var.environment}-valkey-subnets"
    Service = "valkey"
  }
}

resource "aws_secretsmanager_secret" "auth_token" {
  name                    = "${var.project}/${var.environment}/valkey/auth-token"
  description             = "ElastiCache Valkey AUTH token; generated ephemerally and never stored in Terraform state."
  recovery_window_in_days = 7

  tags = {
    Name    = "${var.project}-${var.environment}-valkey-auth-token"
    Service = "valkey"
  }
}

resource "aws_secretsmanager_secret_version" "auth_token" {
  secret_id                = aws_secretsmanager_secret.auth_token.id
  secret_string_wo         = ephemeral.random_password.auth_token.result
  secret_string_wo_version = 1
}

# BullMQ exige `noeviction`: con una política LRU, Valkey podría expulsar jobs pendientes. Toda
# clave de caché lleva TTL (docs/11-cache-y-colas.md), así que la memoria no crece sin límite.
resource "aws_elasticache_parameter_group" "this" {
  name        = "${var.project}-${var.environment}-valkey8"
  family      = "valkey8"
  description = "QAPAQ SecOps: caché con TTL y colas BullMQ (noeviction)."

  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }

  tags = {
    Name    = "${var.project}-${var.environment}-valkey8"
    Service = "valkey"
  }
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id       = "${var.project}-${var.environment}-valkey"
  description                = "Valkey privado para cache (lazy loading) y colas BullMQ de QAPAQ SecOps."
  engine                     = "valkey"
  engine_version             = var.engine_version
  node_type                  = var.node_type
  num_cache_clusters         = 1
  parameter_group_name       = aws_elasticache_parameter_group.this.name
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [var.security_group_id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  auth_token_wo              = ephemeral.random_password.auth_token.result
  auth_token_wo_version      = 1
  automatic_failover_enabled = false
  multi_az_enabled           = false
  snapshot_retention_limit   = 0
  auto_minor_version_upgrade = true
  apply_immediately          = false
  maintenance_window         = "sun:06:00-sun:07:00"

  tags = {
    Name    = "${var.project}-${var.environment}-valkey"
    Service = "valkey"
  }

  depends_on = [aws_secretsmanager_secret_version.auth_token]
}
