# Nodo Wazuh all-in-one (Manager + Indexer + Dashboard): la única pieza con servidor.
#
# Robustez: se eligió UNA instancia EC2 con auto-recovery (alarma StatusCheckFailed_System →
# ec2:recover) y reinicio (StatusCheckFailed_Instance → ec2:reboot) en vez de un ASG min=max=1,
# por simplicidad y porque recover conserva el volumen EBS, la IP privada, la EIP y el ID de
# instancia (los agentes no se reconfiguran). La pérdida del volumen se cubre con los snapshots
# diarios de DLM y los snapshots del Indexer a S3 (configurados por el overlay).
#
# lifecycle.ignore_changes en ami y user_data: el nodo tiene estado y no debe reemplazarse por
# una AMI nueva o un cambio de script. Para reconstruirlo: `terraform apply -replace=aws_instance.wazuh`.

data "aws_ssm_parameter" "ubuntu_arm64" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

# ---------------------------------------------------------------------------
# Secretos
# ---------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "wazuh_admin" {
  name                    = "${local.ssm_prefix}/wazuh/admin"
  description             = "Usuario admin del Indexer Wazuh. Lo escribe el bootstrap del nodo (contenedor sin valor inicial)."
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = local.is_prod ? 30 : 0
}

resource "random_password" "agent_registration" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "agent_registration" {
  name                    = "${local.ssm_prefix}/wazuh/agent-registration"
  description             = "Contraseña de registro de agentes Wazuh (authd use_password)"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = local.is_prod ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "agent_registration" {
  secret_id     = aws_secretsmanager_secret.agent_registration.id
  secret_string = random_password.agent_registration.result
}

# ---------------------------------------------------------------------------
# Security group
# ---------------------------------------------------------------------------
resource "aws_security_group" "wazuh" {
  name        = "${local.name}-wazuh"
  description = "Nodo Wazuh: agentes, dashboard admin y acceso privado desde Lambda"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.name}-wazuh" }
}

locals {
  agent_source_cidrs = toset(concat([var.vpc_cidr], var.agent_cidrs))
  agent_ingress = { for pair in setproduct(tolist(local.agent_source_cidrs), ["1514", "1515"]) :
    "${pair[0]}-${pair[1]}" => { cidr = pair[0], port = tonumber(pair[1]) }
  }
}

resource "aws_vpc_security_group_ingress_rule" "wazuh_agents" {
  for_each = local.agent_ingress

  security_group_id = aws_security_group.wazuh.id
  description       = "Agentes Wazuh ${each.value.port == 1514 ? "eventos" : "registro"}"
  ip_protocol       = "tcp"
  from_port         = each.value.port
  to_port           = each.value.port
  cidr_ipv4         = each.value.cidr
}

resource "aws_vpc_security_group_ingress_rule" "wazuh_dashboard" {
  for_each = toset(var.allowed_admin_cidrs)

  security_group_id = aws_security_group.wazuh.id
  description       = "Dashboard Wazuh desde CIDR administrativo"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_ingress_rule" "wazuh_from_lambda" {
  for_each = toset(["9200", "55000"])

  security_group_id            = aws_security_group.wazuh.id
  description                  = "Wazuh ${each.value == "9200" ? "Indexer" : "API"} desde Lambda"
  ip_protocol                  = "tcp"
  from_port                    = tonumber(each.value)
  to_port                      = tonumber(each.value)
  referenced_security_group_id = aws_security_group.lambda.id
}

resource "aws_vpc_security_group_egress_rule" "wazuh_https" {
  security_group_id = aws_security_group.wazuh.id
  description       = "HTTPS saliente (paquetes Wazuh, APIs AWS)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "wazuh_http" {
  security_group_id = aws_security_group.wazuh.id
  description       = "HTTP saliente (espejos apt de Ubuntu)"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

# ---------------------------------------------------------------------------
# IAM
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "wazuh" {
  name               = "${local.name}-wazuh-node"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "wazuh_ssm" {
  role       = aws_iam_role.wazuh.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "wazuh" {
  statement {
    sid       = "AdminSecretWrite"
    actions   = ["secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [aws_secretsmanager_secret.wazuh_admin.arn]
  }

  statement {
    sid       = "RegistrationSecretRead"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.agent_registration.arn]
  }

  statement {
    sid       = "Snapshots"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads"]
    resources = [module.bucket_wazuh_snapshots.arn]
  }

  statement {
    sid       = "SnapshotObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
    resources = ["${module.bucket_wazuh_snapshots.arn}/*"]
  }

  statement {
    sid       = "OverlayRead"
    actions   = ["s3:GetObject"]
    resources = ["${module.bucket_artifacts.arn}/wazuh/*"]
  }

  statement {
    sid       = "DataKey"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey", "kms:Encrypt"]
    resources = [aws_kms_key.data.arn]
  }

  statement {
    sid       = "PublishAlerts"
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.security.arn]
  }
}

resource "aws_iam_role_policy" "wazuh" {
  name   = "wazuh-node"
  role   = aws_iam_role.wazuh.id
  policy = data.aws_iam_policy_document.wazuh.json
}

resource "aws_iam_instance_profile" "wazuh" {
  name = "${local.name}-wazuh-node"
  role = aws_iam_role.wazuh.name
}

# ---------------------------------------------------------------------------
# Instancia
# ---------------------------------------------------------------------------
resource "aws_instance" "wazuh" {
  ami                     = data.aws_ssm_parameter.ubuntu_arm64.insecure_value
  instance_type           = var.wazuh_instance_type
  subnet_id               = aws_subnet.public[0].id
  vpc_security_group_ids  = [aws_security_group.wazuh.id]
  iam_instance_profile    = aws_iam_instance_profile.wazuh.name
  ebs_optimized           = true
  monitoring              = false
  disable_api_termination = local.is_prod

  associate_public_ip_address = false

  user_data = templatefile("${path.module}/templates/wazuh-bootstrap.sh.tftpl", {
    aws_region              = local.region
    wazuh_version           = var.wazuh_version
    admin_secret_arn        = aws_secretsmanager_secret.wazuh_admin.arn
    registration_secret_arn = aws_secretsmanager_secret.agent_registration.arn
    overlay_s3_uri          = var.wazuh_overlay_s3_uri
  })
  user_data_replace_on_change = false

  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.wazuh_root_volume_gb
    encrypted             = true
    kms_key_id            = aws_kms_key.data.arn
    delete_on_termination = !local.is_prod
    tags                  = { Name = "${local.name}-wazuh-root" }
  }

  maintenance_options {
    auto_recovery = "default"
  }

  tags = {
    Name                     = "${local.name}-wazuh"
    "${local.agent_tag_key}" = "disabled"
    "${var.project}-backup"  = "wazuh-daily"
  }

  lifecycle {
    ignore_changes = [ami, user_data]
  }

  depends_on = [aws_secretsmanager_secret_version.agent_registration, aws_iam_role_policy.wazuh]
}

resource "aws_eip" "wazuh" {
  domain   = "vpc"
  instance = aws_instance.wazuh.id
  tags     = { Name = "${local.name}-wazuh" }

  depends_on = [aws_internet_gateway.main]
}

# ---------------------------------------------------------------------------
# Auto-recuperación y reinicio
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "wazuh_recover" {
  alarm_name          = "${local.name}-wazuh-system-check-recover"
  alarm_description   = "Falla de hardware/host: recupera la instancia conservando EBS, IP y EIP"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_System"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  dimensions          = { InstanceId = aws_instance.wazuh.id }
  alarm_actions       = ["arn:${local.partition}:automate:${local.region}:ec2:recover", aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "wazuh_reboot" {
  alarm_name          = "${local.name}-wazuh-instance-check-reboot"
  alarm_description   = "Falla del SO: reinicia la instancia"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_Instance"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  dimensions          = { InstanceId = aws_instance.wazuh.id }
  alarm_actions       = ["arn:${local.partition}:automate:${local.region}:ec2:reboot", aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# ---------------------------------------------------------------------------
# Snapshots EBS diarios (Data Lifecycle Manager)
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "dlm_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["dlm.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dlm" {
  name               = "${local.name}-dlm"
  assume_role_policy = data.aws_iam_policy_document.dlm_assume.json
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "wazuh" {
  description        = "${local.name} snapshots diarios del nodo Wazuh"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["INSTANCE"]
    target_tags    = { "${var.project}-backup" = "wazuh-daily" }

    schedule {
      name      = "daily"
      copy_tags = true

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["04:00"]
      }

      retain_rule {
        count = var.wazuh_snapshot_retention_days
      }

      tags_to_add = { SnapshotCreator = "dlm" }
    }
  }
}
