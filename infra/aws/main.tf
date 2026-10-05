data "aws_caller_identity" "current" {}

module "networking" {
  source = "./modules/networking"

  project             = var.project
  environment         = var.environment
  vpc_cidr            = var.vpc_cidr
  az_count            = var.az_count
  availability_zones  = var.availability_zones
  public_subnet_cidrs = var.public_subnet_cidrs
  app_subnet_cidrs    = var.app_subnet_cidrs
  data_subnet_cidrs   = var.data_subnet_cidrs
}

module "security" {
  source = "./modules/security"

  project              = var.project
  environment          = var.environment
  vpc_id               = module.networking.vpc_id
  allowed_admin_cidrs  = var.allowed_admin_cidrs
  enable_https         = var.enable_https
  krakend_port         = var.krakend_port
  api_port             = var.api_port
  postgres_port        = var.postgres_port
  redis_port           = var.redis_port
  wazuh_indexer_port   = var.wazuh_indexer_port
  wazuh_dashboard_port = var.wazuh_dashboard_port
}

module "application_foundations" {
  source = "./modules/application_foundations"

  project           = var.project
  environment       = var.environment
  account_id        = data.aws_caller_identity.current.account_id
  github_repository = var.github_repository
}
