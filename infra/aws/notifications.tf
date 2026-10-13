# Sprint 5 — avisos del SOC: Teams por rol, respaldo por correo y Web Push.
#
# - Teams: la URL del Teams Workflow («cuando se reciba una solicitud de webhook, publicar
#   tarjeta en un canal») es un secreto. Se carga con el workflow `Sync deploy secrets` (secreto
#   de GitHub TEAMS_WORKFLOW_URL) y se inyecta al API solo con `teams_notifications_enabled`,
#   porque ECS no arranca una tarea cuyo secreto no tiene valor.
# - Correo: si Teams no confirma la entrega, el aviso sale por Microsoft Graph desde
#   `alert_mail_sender` (permiso de aplicación Mail.Send de la app del API).
# - Web Push: la clave VAPID la genera el migrador (módulo database_migrator).

variable "teams_notifications_enabled" {
  description = "Inyecta al API la URL del Teams Workflow. Activar después de cargar el secreto."
  type        = bool
  default     = false
}

variable "alert_mail_sender" {
  description = "Buzón remitente del respaldo por correo (UPN); vacío = respaldo solo en la consola."
  type        = string
  default     = ""

  validation {
    condition     = var.alert_mail_sender == "" || can(regex("^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,24}$", var.alert_mail_sender))
    error_message = "alert_mail_sender debe ser una dirección de correo."
  }
}

resource "aws_secretsmanager_secret" "teams_workflow_url" {
  name                    = "${var.project}/${var.environment}/teams/workflow-url"
  description             = "URL del Teams Workflow del canal del SOC (quien la tiene publica en el canal)."
  recovery_window_in_days = 7

  tags = {
    Project     = var.project
    Environment = var.environment
    Purpose     = "soc-notifications"
  }
}

locals {
  notification_api_environment = var.alert_mail_sender == "" ? {} : {
    QAPAQ_ALERT_MAIL_SENDER = lower(var.alert_mail_sender)
  }
  notification_api_secrets = var.teams_notifications_enabled ? [
    { name = "QAPAQ_TEAMS_WORKFLOW_URL", valueFrom = aws_secretsmanager_secret.teams_workflow_url.arn },
  ] : []
}
