data "aws_ssm_parameter" "ubuntu_ami" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_secretsmanager_secret" "admin" {
  name                    = "${var.project}/${var.environment}/wazuh/dashboard-admin"
  description             = "Generated Wazuh dashboard administrator credential."
  recovery_window_in_days = 7

  tags = {
    Project     = var.project
    Environment = var.environment
    Purpose     = "wazuh-dashboard-admin"
  }
}

resource "aws_iam_role" "instance" {
  name               = "${var.project}-${var.environment}-wazuh-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json
  tags               = { Project = var.project, Environment = var.environment }
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "write_admin_secret" {
  name = "write-generated-wazuh-admin-credential"
  role = aws_iam_role.instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:PutSecretValue"]
      Resource = aws_secretsmanager_secret.admin.arn
    }]
  })
}

resource "aws_iam_instance_profile" "this" {
  name = "${var.project}-${var.environment}-wazuh-instance"
  role = aws_iam_role.instance.name
}

resource "aws_instance" "this" {
  ami                         = data.aws_ssm_parameter.ubuntu_ami.value
  instance_type               = var.instance_type
  subnet_id                   = var.public_subnet_id
  vpc_security_group_ids      = [var.public_proxy_security_group_id, var.wazuh_security_group_id]
  iam_instance_profile        = aws_iam_instance_profile.this.name
  associate_public_ip_address = true
  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/bootstrap.sh.tftpl", {
    api_origin       = var.api_origin
    aws_region       = var.region
    admin_secret_arn = aws_secretsmanager_secret.admin.arn
    project          = var.project
    environment      = var.environment
    wazuh_version    = var.wazuh_version
  })

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.volume_size_gb
    encrypted             = true
    delete_on_termination = true
  }

  tags = {
    Name        = "${var.project}-${var.environment}-wazuh"
    Project     = var.project
    Environment = var.environment
    Purpose     = "wazuh-dashboard"
  }

  depends_on = [aws_iam_role_policy_attachment.ssm, aws_iam_role_policy.write_admin_secret]
}

resource "aws_eip" "this" {
  domain   = "vpc"
  instance = aws_instance.this.id

  tags = {
    Name        = "${var.project}-${var.environment}-wazuh"
    Project     = var.project
    Environment = var.environment
    Purpose     = "stable-domainless-https-endpoint"
  }
}
