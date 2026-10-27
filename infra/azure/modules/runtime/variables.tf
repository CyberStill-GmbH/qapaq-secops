variable "resource_group_name" {
  description = "Resource group precreado por bootstrap."
  type        = string
}

variable "environment" {
  description = "Entorno lógico; se conserva en la interfaz para etiquetas y nombres futuros."
  type        = string
}

variable "name_base" {
  description = "Base compacta de nombres; también forma los FQDN internos de service discovery."
  type        = string
}

variable "tags" {
  description = "Etiquetas comunes de gobierno y costo."
  type        = map(string)
}

variable "container_images" {
  description = "Imágenes edge/web/gateway/api/worker fijadas por digest sha256."
  type        = map(string)
}

variable "enable_runtime" {
  description = "Crea las cinco Container Apps genéricas; apagado por defecto."
  type        = bool
}

variable "key_vault_secret_ids" {
  description = "URIs de secretos Key Vault por servicio y variable de entorno."
  type        = map(map(string))
}

variable "container_app_environment_id" {
  description = "Container Apps Environment con perfil Consumption; vacío si el runtime está apagado."
  type        = string
}

variable "container_app_environment_default_domain" {
  description = "Dominio interno del entorno para los upstreams entre apps."
  type        = string
}

variable "runtime_identity_id" {
  description = "Identidad administrada con AcrPull y Key Vault Secrets User."
  type        = string
}

variable "container_registry_login_server" {
  description = "Login server del ACR desde el que se extraen las imágenes."
  type        = string
}

variable "postgres_fqdn" {
  description = "FQDN privado de PostgreSQL."
  type        = string
}

variable "app_database_name" {
  description = "Base de datos de la API."
  type        = string
}

variable "queue_database_name" {
  description = "Base reservada para jobs; sin consumidor activo todavía."
  type        = string
}
