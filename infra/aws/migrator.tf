# C-1 — tarea one-off de base de datos (bootstrap de roles y migraciones).
#
# Vive en un archivo propio para no mezclarse con la configuración del runtime. Hasta que se
# publique la imagen migrator (`migrator_image_digest`), solo se crean los contenedores de
# secreto, los roles y el grupo de logs; no hay task definition.

variable "soc_database_enabled" {
  description = "Activa el estado SOC durable en el API. Solo después de bootstrap-roles y migrate exitosos."
  type        = bool
  default     = false
}

variable "migrator_image_digest" {
  description = "Digest de la imagen qapaq-secops-migrator del mismo commit que el API. Null mientras no exista."
  type        = string
  default     = null
  nullable    = true
}

module "database_migrator" {
  source = "./modules/database_migrator"

  project               = var.project
  environment           = var.environment
  region                = var.aws_region
  repository_url        = module.application_foundations.ecr_repository_urls["migrator"]
  repository_arn        = module.application_foundations.ecr_repository_arns_by_service["migrator"]
  image_digest          = var.migrator_image_digest
  image_manifest_commit = var.runtime_image_manifest_commit
  master_secret_arn     = module.database.master_secret_arn
  postgres = {
    host     = module.database.endpoint
    port     = module.database.port
    database = module.database.database_name
  }
}

output "database_migrator" {
  description = "Datos no secretos que el workflow migrate-database necesita para run-task."
  value = {
    cluster_name                  = module.runtime.cluster_name
    subnet_ids                    = module.networking.app_subnet_ids
    security_group_id             = module.security.security_group_ids.worker
    bootstrap_task_definition_arn = module.database_migrator.bootstrap_task_definition_arn
    migrate_task_definition_arn   = module.database_migrator.migrate_task_definition_arn
    runtime_secret_arn            = module.database_migrator.runtime_secret_arn
    entity_ref_key_secret_arn     = module.database_migrator.entity_ref_key_secret_arn
    log_group_name                = module.database_migrator.log_group_name
  }
}
