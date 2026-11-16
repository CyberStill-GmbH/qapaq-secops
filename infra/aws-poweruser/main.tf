# QAPAQ SecOps en modo PowerUser: un solo nodo EC2 sin rol IAM ni perfil de instancia.
# El permiso SSO SOC-PowerUser no permite IAM ni iam:PassRole; por eso aquí no hay Lambda,
# Step Functions, Scheduler, DLM ni Flow Logs. Los secretos se generan en el host
# (/opt/qapaq/secrets, 0600 root) y nunca pasan por Terraform, el estado ni el user_data.

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

locals {
  az = data.aws_availability_zones.available.names[0]
}

# --- KMS ---------------------------------------------------------------------

resource "aws_kms_key" "data" {
  description             = "${var.name} EBS y S3"
  enable_key_rotation     = true
  deletion_window_in_days = 7
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

# --- Red ---------------------------------------------------------------------

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-default-closed" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 2, 0)
  availability_zone       = local.az
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "soc" {
  name        = "${var.name}-node"
  description = "QAPAQ SecOps node: admin SSH/HTTPS, ACME HTTP, Wazuh agents"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${var.name}-node" }
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  for_each          = toset(var.allowed_admin_cidrs)
  security_group_id = aws_security_group.soc.id
  description       = "SSH admin"
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
  cidr_ipv4         = each.value
}

# HTTPS al nodo: solo desde el ALB (public.tf). El puerto 80 ya no se abre: TLS público lo
# termina ACM en el ALB.

resource "aws_vpc_security_group_ingress_rule" "agents" {
  for_each          = toset(var.agent_cidrs)
  security_group_id = aws_security_group.soc.id
  description       = "Wazuh agents"
  ip_protocol       = "tcp"
  from_port         = 1514
  to_port           = 1515
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.soc.id
  description       = "Egress (packages, images, ACME)"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# --- Nodo --------------------------------------------------------------------

resource "aws_key_pair" "operator" {
  key_name   = "${var.name}-operator"
  public_key = var.ssh_public_key
}

resource "aws_instance" "soc" {
  ami                         = data.aws_ssm_parameter.ubuntu.value
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.soc.id]
  key_name                    = aws_key_pair.operator.key_name
  associate_public_ip_address = false
  user_data_replace_on_change = false
  user_data                   = file("${path.module}/templates/cloud-init.sh")

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gb
    encrypted             = true
    kms_key_id            = aws_kms_key.data.arn
    delete_on_termination = true
  }

  lifecycle {
    # La EIP marca associate_public_ip_address = true; sin ignorarlo, cualquier cambio reemplazaría el nodo.
    ignore_changes = [ami, associate_public_ip_address]
  }

  tags        = { Name = "${var.name}-node" }
  volume_tags = { Name = "${var.name}-root", project = "qapaq", environment = var.environment }
}

resource "aws_eip" "soc" {
  domain   = "vpc"
  instance = aws_instance.soc.id
  tags     = { Name = "${var.name}-node" }
}

resource "aws_route53_record" "soc" {
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"
  alias {
    name                   = aws_lb.soc.dns_name
    zone_id                = aws_lb.soc.zone_id
    evaluate_target_health = true
  }
}

# Agentes Wazuh (TCP 1514/1515): el ALB no transporta esos puertos, así que van directo a la EIP.
# La apertura del SG la controla var.agent_cidrs.
resource "aws_route53_record" "agents" {
  zone_id = var.route53_zone_id
  name    = "agents.${var.domain_name}"
  type    = "A"
  ttl     = 300
  records = [aws_eip.soc.public_ip]
}

# --- Evidencia / respaldos (sin credenciales en el host: carga manual del operador) ---

resource "aws_s3_bucket" "evidence" {
  bucket        = "${var.name}-evidence-${data.aws_caller_identity.current.account_id}"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "evidence" {
  bucket                  = aws_s3_bucket.evidence.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
    bucket_key_enabled = true
  }
}

data "aws_iam_policy_document" "evidence_tls" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.evidence.arn, "${aws_s3_bucket.evidence.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "evidence" {
  bucket     = aws_s3_bucket.evidence.id
  policy     = data.aws_iam_policy_document.evidence_tls.json
  depends_on = [aws_s3_bucket_public_access_block.evidence]
}

# --- Costo --------------------------------------------------------------------

resource "aws_budgets_budget" "monthly" {
  name         = var.name
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = ["user:project$qapaq"]
  }

  dynamic "notification" {
    for_each = var.budget_email == "" ? [] : [80, 100]
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.budget_email]
    }
  }
}
