variable "resource_group_name" {
  description = "Resource group precreado por bootstrap."
  type        = string
}

variable "location" {
  description = "Región del workspace y del Container Apps Environment."
  type        = string
}

variable "name_base" {
  description = "Base compacta de nombres derivada de project y environment."
  type        = string
}

variable "container_apps_subnet_id" {
  description = "Subnet /27 delegada a Microsoft.App/environments."
  type        = string
}

variable "tags" {
  description = "Etiquetas comunes de gobierno y costo."
  type        = map(string)
}

variable "enable_runtime" {
  description = "Crea el Container Apps Environment solo cuando el runtime genérico está habilitado."
  type        = bool
  default     = false
}
