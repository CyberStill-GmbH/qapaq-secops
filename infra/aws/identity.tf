# Sprint 5 — identidad: quién es administrador por ser dueño del grupo de admisión.
#
# El OID del dueño no se versiona: llega como variable de GitHub (`QAPAQ_GROUP_OWNER_OIDS`) y
# el workflow Terraform Demo la pasa como `TF_VAR_soc_group_owner_oids`. Es el respaldo hasta
# que la lectura del grupo por Microsoft Graph tenga consentimiento (fase 3); entonces los
# dueños leídos se suman a estos. Las asignaciones fijas (p. ej. analista) van en
# `QAPAQ_ROLE_BINDINGS` dentro de `runtime_api_environment`.

variable "soc_group_owner_oids" {
  description = "OID de Entra de los dueños del grupo de admisión, separados por coma; reciben qapaq.platform.admin."
  type        = string
  default     = ""

  validation {
    condition = var.soc_group_owner_oids == "" || alltrue([
      for oid in split(",", var.soc_group_owner_oids) :
      can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$", trimspace(oid)))
    ])
    error_message = "soc_group_owner_oids debe ser una lista de OID separados por coma."
  }
}

variable "soc_directory_group_id" {
  description = <<-EOT
    Object ID del grupo de admisión (QAPAQ-SecOps-Users). Con valor, el API sincroniza el padrón
    por Microsoft Graph (fase 3). Requiere que el app registration del API tenga el permiso de
    aplicación GroupMember.Read.All con consentimiento de administrador; sin él, cada ciclo
    falla con DIRECTORY_FORBIDDEN y la vista de usuarios lo muestra. Variable de GitHub
    QAPAQ_DIRECTORY_GROUP_ID.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.soc_directory_group_id == "" || can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.soc_directory_group_id))
    error_message = "soc_directory_group_id debe ser un GUID."
  }
}

variable "soc_directory_group_name" {
  description = "Nombre exacto del grupo de admisión, si no se conoce su ID (el API lo resuelve por Graph al arrancar)."
  type        = string
  default     = ""

  validation {
    condition     = var.soc_directory_group_name == "" || can(regex("^[A-Za-z0-9][A-Za-z0-9 ._-]{0,255}$", var.soc_directory_group_name))
    error_message = "soc_directory_group_name: texto simple sin comillas."
  }
}

locals {
  identity_api_environment = merge(
    var.soc_group_owner_oids == "" ? {} : {
      QAPAQ_GROUP_OWNER_OIDS = join(",", [for oid in split(",", var.soc_group_owner_oids) : lower(trimspace(oid))])
    },
    var.soc_directory_group_id != "" ? {
      QAPAQ_DIRECTORY_SYNC     = "graph"
      QAPAQ_DIRECTORY_GROUP_ID = lower(var.soc_directory_group_id)
      } : var.soc_directory_group_name != "" ? {
      QAPAQ_DIRECTORY_SYNC       = "graph"
      QAPAQ_DIRECTORY_GROUP_NAME = var.soc_directory_group_name
    } : {},
  )
}
