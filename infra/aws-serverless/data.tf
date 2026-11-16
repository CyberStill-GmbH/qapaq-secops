# Aurora Serverless v2 PostgreSQL. Escala a 0 ACU con pausa automática (min_capacity = 0).
# La contraseña maestra la genera y rota RDS en Secrets Manager (manage_master_user_password),
# cifrada con la CMK de datos: nunca pasa por tfvars ni por el estado.

resource "aws_security_group" "aurora" {
  name        = "${local.name}-aurora"
  description = "Aurora PostgreSQL: solo desde el SG de las Lambdas"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.name}-aurora" }
}

resource "aws_vpc_security_group_ingress_rule" "aurora_from_lambda" {
  security_group_id            = aws_security_group.aurora.id
  description                  = "PostgreSQL desde Lambda"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.lambda.id
}

resource "aws_db_subnet_group" "aurora" {
  name       = "${local.name}-aurora"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_rds_cluster_parameter_group" "aurora" {
  name   = "${local.name}-aurora-pg16"
  family = "aurora-postgresql16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "2000"
  }
}

resource "aws_rds_cluster" "main" {
  cluster_identifier = "${local.name}-aurora"
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned"
  engine_version     = var.aurora_engine_version
  database_name      = "qapaq"
  master_username    = "qapaqadmin"

  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.data.arn

  db_subnet_group_name            = aws_db_subnet_group.aurora.name
  vpc_security_group_ids          = [aws_security_group.aurora.id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.aurora.name

  storage_encrypted                   = true
  kms_key_id                          = aws_kms_key.data.arn
  iam_database_authentication_enabled = true
  enabled_cloudwatch_logs_exports     = ["postgresql"]

  backup_retention_period      = var.aurora_backup_retention_days
  preferred_backup_window      = "07:00-08:00"
  preferred_maintenance_window = "sun:08:30-sun:09:30"
  copy_tags_to_snapshot        = true
  deletion_protection          = local.deletion_protection
  skip_final_snapshot          = false
  final_snapshot_identifier    = "${local.name}-aurora-final-${local.suffix}"

  serverlessv2_scaling_configuration {
    min_capacity             = var.aurora_min_capacity
    max_capacity             = var.aurora_max_capacity
    seconds_until_auto_pause = var.aurora_min_capacity == 0 ? var.aurora_seconds_until_auto_pause : null
  }

  lifecycle {
    precondition {
      condition     = var.aurora_max_capacity >= var.aurora_min_capacity
      error_message = "aurora_max_capacity debe ser >= aurora_min_capacity."
    }
  }

  depends_on = [aws_cloudwatch_log_group.aurora]
}

resource "aws_rds_cluster_instance" "main" {
  count = var.aurora_instance_count

  identifier                   = "${local.name}-aurora-${count.index}"
  cluster_identifier           = aws_rds_cluster.main.id
  instance_class               = "db.serverless"
  engine                       = aws_rds_cluster.main.engine
  engine_version               = aws_rds_cluster.main.engine_version
  db_subnet_group_name         = aws_db_subnet_group.aurora.name
  publicly_accessible          = false
  auto_minor_version_upgrade   = true
  performance_insights_enabled = false
}

# Log group de exportación de Aurora con retención acotada (si no, RDS lo crea sin expiración).
resource "aws_cloudwatch_log_group" "aurora" {
  name              = "/aws/rds/cluster/${local.name}-aurora/postgresql"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.data.arn
}
