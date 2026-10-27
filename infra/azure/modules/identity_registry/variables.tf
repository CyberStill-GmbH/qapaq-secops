variable "resource_group_name" {
  description = "Resource group precreado por bootstrap."
  type        = string
}

variable "location" {
  description = "Región de identidades y ACR."
  type        = string
}

variable "name_base" {
  description = "Base compacta de nombres derivada de project y environment."
  type        = string
}

variable "suffix" {
  description = "Sufijo determinista del entorno. Se conserva en la interfaz para nombres globales futuros."
  type        = string
}

variable "environment" {
  description = "Entorno; nombra la credencial federada principal."
  type        = string
}

variable "acr_name" {
  description = "Nombre global del Azure Container Registry."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z0-9]{5,50}$", var.acr_name))
    error_message = "ACR admite 5-50 caracteres alfanuméricos, sin guiones."
  }
}

variable "github_repository" {
  description = "Repositorio GitHub en formato owner/repo."
  type        = string
}

variable "github_owner_id" {
  description = "ID numérico inmutable del owner GitHub usado en el subject OIDC."
  type        = string
}

variable "github_repository_id" {
  description = "ID numérico inmutable del repositorio GitHub usado en el subject OIDC."
  type        = string
}

variable "github_environment" {
  description = "GitHub Environment principal autorizado para el publicador."
  type        = string
}

variable "additional_github_environments" {
  description = "GitHub Environments extra autorizados para la misma identidad publicadora."
  type        = set(string)
}

variable "key_vault_id" {
  description = "Key Vault donde el runtime recibe Key Vault Secrets User."
  type        = string
}

variable "raw_container_id" {
  description = "Contenedor security-event-raw; único alcance de escritura Blob del runtime."
  type        = string
}

variable "siem_release_container_id" {
  description = "Contenedor de releases donde el publicador GitHub escribe bundles."
  type        = string
}

variable "legacy_siem_release_container_id" {
  description = "Contenedor de releases heredado; mantiene su asignación para no forzar destroy."
  type        = string
}

variable "log_analytics_workspace_id" {
  description = "Workspace que recibe los eventos de auditoría de ACR."
  type        = string
}

variable "tags" {
  description = "Etiquetas comunes de gobierno y costo."
  type        = map(string)
}
