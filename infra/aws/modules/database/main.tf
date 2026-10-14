resource "aws_db_subnet_group" "this" {
  name        = "${var.project}-${var.environment}-data"
  description = "Private data subnets for QAPAQ SECOPS demo PostgreSQL."
  subnet_ids  = var.subnet_ids

  tags = {
    Name    = "${var.project}-${var.environment}-postgres-subnets"
    Service = "postgres"
  }
}

resource "aws_db_parameter_group" "this" {
  name        = "${var.project}-${var.environment}-postgres18"
  family      = "postgres18"
  description = "Require TLS for every QAPAQ SECOPS demo PostgreSQL connection."

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "immediate"
  }

  tags = {
    Name    = "${var.project}-${var.environment}-postgres18"
    Service = "postgres"
  }
}

resource "aws_db_instance" "this" {
  identifier                  = "${var.project}-${var.environment}-postgres"
  engine                      = "postgres"
  engine_version              = var.engine_version
  instance_class              = var.instance_class
  db_name                     = "qapaq_secops"
  username                    = "qapaq_admin"
  manage_master_user_password = true
  port                        = 5432

  allocated_storage = var.allocated_storage_gb
  storage_type      = "gp3"
  storage_encrypted = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.security_group_id]
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false
  multi_az               = false

  backup_retention_period  = var.backup_retention_days
  backup_window            = "04:00-04:30"
  maintenance_window       = "sun:05:00-sun:06:00"
  copy_tags_to_snapshot    = true
  delete_automated_backups = true

  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : var.final_snapshot_identifier

  performance_insights_enabled = false
  auto_minor_version_upgrade   = false

  tags = {
    Name    = "${var.project}-${var.environment}-postgres"
    Service = "postgres"
  }

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = var.skip_final_snapshot || (var.final_snapshot_identifier != null && var.final_snapshot_identifier != "")
      error_message = "Set postgres_final_snapshot_identifier when postgres_skip_final_snapshot is false."
    }
  }
}
