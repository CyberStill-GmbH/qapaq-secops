output "runtime_secret_arn" {
  description = "Secret de qapaq_soc_runtime (claves username y password). Es el que se inyecta en el API."
  value       = aws_secretsmanager_secret.role["soc_runtime"].arn
}

output "entity_ref_key_secret_arn" {
  description = "Secret con la clave HMAC de referencias de entidad; se inyecta en el API como QAPAQ_ENTITY_REF_KEY."
  value       = aws_secretsmanager_secret.entity_ref_key.arn
}

output "migrator_secret_arn" {
  description = "Secret de qapaq_migrator; solo lo usa la tarea migrate."
  value       = aws_secretsmanager_secret.role["migrator"].arn
}

output "bootstrap_task_definition_arn" {
  description = "Task definition del modo bootstrap-roles; null hasta publicar la imagen migrator."
  value       = try(aws_ecs_task_definition.bootstrap[0].arn, null)
}

output "migrate_task_definition_arn" {
  description = "Task definition del modo migrate; null hasta publicar la imagen migrator."
  value       = try(aws_ecs_task_definition.migrate[0].arn, null)
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.this.name
}

output "vapid_key_secret_arn" {
  description = "Secreto con la clave privada VAPID del Web Push (la genera bootstrap-roles)."
  value       = aws_secretsmanager_secret.vapid_private_key.arn
}
