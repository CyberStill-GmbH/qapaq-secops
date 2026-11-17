data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

resource "random_id" "suffix" {
  byte_length = 3
}

locals {
  name       = "${var.project}-${var.environment}"
  is_prod    = var.environment == "prod"
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.region
  suffix     = random_id.suffix.hex

  # Nombre único global para buckets: <project>-<env>-<uso>-<cuenta>.
  bucket_prefix = "${local.name}-${local.account_id}"

  common_tags = merge({
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "terraform"
    Stack       = "aws-serverless"
    Owner       = "cybersecurity"
  }, var.extra_tags)

  deletion_protection = local.is_prod ? true : var.deletion_protection

  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)

  # /20 por subred: públicas en 0..2, privadas en 8..10.
  public_subnet_cidrs  = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i)]
  private_subnet_cidrs = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i + 8)]

  ssm_prefix = "/${var.project}/${var.environment}"

  lambda_memory  = var.lambda_memory_mb
  lambda_timeout = var.lambda_timeout_s

  # Qapaqzito: con Bedrock (cliente Mantle) los IDs llevan prefijo "anthropic.".
  qapaqzito_model_id  = var.qapaqzito_provider == "bedrock" && !startswith(var.qapaqzito_model, "anthropic.") ? "anthropic.${var.qapaqzito_model}" : var.qapaqzito_model
  qapaqzito_model_ids = length(var.qapaqzito_model_ids) > 0 ? var.qapaqzito_model_ids : [local.qapaqzito_model_id]
  qapaqzito_bedrock   = var.enable_qapaqzito && var.qapaqzito_provider == "bedrock"
  qapaqzito_anthropic = var.enable_qapaqzito && var.qapaqzito_provider == "anthropic"

  # Etiquetas de enrolamiento de agentes.
  agent_tag_key       = "${var.project}-agent"
  agent_group_tag_key = "${var.project}-agent-group"
}
