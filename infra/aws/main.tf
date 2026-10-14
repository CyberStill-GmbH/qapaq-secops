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

  project                    = var.project
  environment                = var.environment
  account_id                 = data.aws_caller_identity.current.account_id
  github_repository          = var.github_repository
  github_repository_owner_id = var.github_repository_owner_id
  github_repository_id       = var.github_repository_id
}

module "database" {
  source = "./modules/database"

  project                   = var.project
  environment               = var.environment
  subnet_ids                = module.networking.data_subnet_ids
  security_group_id         = module.security.security_group_ids.postgres
  engine_version            = var.postgres_engine_version
  instance_class            = var.postgres_instance_class
  allocated_storage_gb      = var.postgres_allocated_storage_gb
  backup_retention_days     = var.postgres_backup_retention_days
  deletion_protection       = var.postgres_deletion_protection
  skip_final_snapshot       = var.postgres_skip_final_snapshot
  final_snapshot_identifier = var.postgres_final_snapshot_identifier
}

module "cache" {
  source = "./modules/cache"

  project           = var.project
  environment       = var.environment
  region            = var.aws_region
  subnet_ids        = module.networking.data_subnet_ids
  security_group_id = module.security.security_group_ids.redis
  node_type         = var.valkey_node_type
  engine_version    = var.valkey_engine_version
}

module "private_endpoints" {
  source = "./modules/private_endpoints"

  project             = var.project
  environment         = var.environment
  region              = var.aws_region
  vpc_id              = module.networking.vpc_id
  app_subnet_ids      = module.networking.app_subnet_ids
  app_route_table_ids = [module.networking.app_route_table_id]
  runtime_security_group_ids = {
    krakend = module.security.security_group_ids.krakend
    api     = module.security.security_group_ids.api
    worker  = module.security.security_group_ids.worker
    wazuh   = module.security.security_group_ids.wazuh
  }
  ecr_image_pull_security_group_ids = {
    krakend = module.security.security_group_ids.krakend
    api     = module.security.security_group_ids.api
    worker  = module.security.security_group_ids.worker
  }
}

module "runtime" {
  source = "./modules/runtime"

  project                 = var.project
  environment             = var.environment
  region                  = var.aws_region
  account_id              = data.aws_caller_identity.current.account_id
  vpc_id                  = module.networking.vpc_id
  public_subnet_ids       = module.networking.public_subnet_ids
  app_subnet_ids          = module.networking.app_subnet_ids
  app_route_table_id      = module.networking.app_route_table_id
  security_group_ids      = module.security.security_group_ids
  enable_https            = var.enable_https
  alb_certificate_arn     = var.enable_https ? aws_acm_certificate_validation.public_api[0].certificate_arn : null
  image_digests           = var.runtime_image_digests
  image_manifest_commit   = var.runtime_image_manifest_commit
  desired_counts          = var.ecs_desired_counts
  api_environment         = merge(var.runtime_api_environment, local.identity_api_environment, local.notification_api_environment)
  api_extra_secrets       = local.notification_api_secrets
  krakend_environment     = var.runtime_krakend_environment
  entra_client_secret_arn = module.application_foundations.metadata_secret_arns["entra_client_secret"]
  # Sprint 5 · fase 0: ingesta Wazuh → SOC, activada con `wazuh_ingestion_enabled`
  # (ver wazuh_ingestion.tf).
  wazuh_ingestion = local.wazuh_ingestion
  # Valkey: caché (lazy loading) y colas BullMQ consumidas por el worker (docs/11).
  valkey = {
    host            = module.cache.primary_endpoint
    port            = module.cache.port
    auth_secret_arn = module.cache.auth_secret_arn
  }
  # C-1: estado SOC durable, activado con `soc_database_enabled` (ver migrator.tf).
  soc_database = var.soc_database_enabled ? {
    host                      = module.database.endpoint
    port                      = module.database.port
    database                  = module.database.database_name
    runtime_secret_arn        = module.database_migrator.runtime_secret_arn
    entity_ref_key_secret_arn = module.database_migrator.entity_ref_key_secret_arn
    vapid_key_secret_arn      = module.database_migrator.vapid_key_secret_arn
  } : null
  health_check_grace_period_seconds = var.ecs_health_check_grace_period_seconds

  depends_on = [
    module.networking,
    module.security,
    module.application_foundations,
    module.database,
    module.cache,
    module.private_endpoints,
  ]
}

module "wazuh_public" {
  source = "./modules/wazuh_public"

  project                        = var.project
  environment                    = var.environment
  region                         = var.aws_region
  vpc_id                         = module.networking.vpc_id
  public_subnet_id               = module.networking.public_subnet_ids[0]
  public_proxy_security_group_id = module.security.security_group_ids.public_proxy
  wazuh_security_group_id        = module.security.security_group_ids.wazuh
  api_origin                     = module.runtime.load_balancer_dns_name
  wazuh_version                  = var.wazuh_version
  instance_type                  = var.wazuh_instance_type
  volume_size_gb                 = var.wazuh_volume_size_gb

  # Sin `depends_on = [module.runtime]`: la instancia ya depende del ALB por `api_origin`, y el
  # runtime necesita la IP privada de esta instancia para la ingesta (wazuh_ingestion.tf). Un
  # depends_on de módulo completo crearía un ciclo.
}
