variable "project" { type = string }
variable "environment" { type = string }
variable "region" { type = string }

variable "repository_url" {
  description = "URL del repositorio ECR de la imagen migrator."
  type        = string
}

variable "repository_arn" {
  description = "ARN del repositorio ECR de la imagen migrator; único repositorio que la tarea puede leer."
  type        = string
}

variable "image_digest" {
  description = "Digest de la imagen migrator construida desde el mismo commit que el API. Null: no se crea la task definition."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.image_digest == null || can(regex("^sha256:[0-9a-f]{64}$", var.image_digest))
    error_message = "image_digest debe ser un digest sha256 inmutable."
  }
}

variable "image_manifest_commit" {
  description = "Commit del que salió la imagen; se registra como tag de la task definition."
  type        = string
}

variable "master_secret_arn" {
  description = "ARN del secret administrado por RDS (claves username y password). Solo lo lee el bootstrap."
  type        = string
}

variable "postgres" {
  description = "Conexión no secreta a la base SOC."
  type = object({
    host     = string
    port     = number
    database = string
  })
}
