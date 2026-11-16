# ---------------------------------------------------------------------------
# Identidad del despliegue
# ---------------------------------------------------------------------------
variable "project" {
  description = "Prefijo corto del proyecto para nombres de recursos."
  type        = string
  default     = "qapaq"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,14}$", var.project))
    error_message = "project debe tener 2-15 caracteres en minúscula, dígitos o guiones."
  }
}

variable "environment" {
  description = "Entorno: dev, staging o prod. prod activa protecciones adicionales."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment debe ser dev, staging o prod."
  }
}

variable "aws_region" {
  description = "Región AWS de la carga de trabajo."
  type        = string
  default     = "us-east-1"
}

variable "extra_tags" {
  description = "Etiquetas adicionales aplicadas a todos los recursos."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------
# Red
# ---------------------------------------------------------------------------
variable "vpc_cidr" {
  description = "CIDR de la VPC."
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && tonumber(split("/", var.vpc_cidr)[1]) <= 20
    error_message = "vpc_cidr debe ser un CIDR IPv4 válido de /20 o mayor."
  }
}

variable "az_count" {
  description = "Número de zonas de disponibilidad (2 o 3)."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count debe ser 2 o 3."
  }
}

variable "allowed_admin_cidrs" {
  description = "CIDRs administrativos (VPN/oficina) con acceso al dashboard Wazuh en 443. No se admite 0.0.0.0/0."
  type        = list(string)

  validation {
    condition     = length(var.allowed_admin_cidrs) > 0 && alltrue([for c in var.allowed_admin_cidrs : can(cidrhost(c, 0)) && c != "0.0.0.0/0" && !endswith(c, "/0")])
    error_message = "allowed_admin_cidrs debe contener al menos un CIDR válido y ninguno puede ser /0."
  }
}

variable "agent_cidrs" {
  description = "CIDRs públicos desde los que los agentes Wazuh fuera de la VPC llegan a 1514/1515. La VPC siempre se incluye."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.agent_cidrs : can(cidrhost(c, 0)) && !endswith(c, "/0")])
    error_message = "agent_cidrs debe contener CIDRs válidos y ninguno puede ser /0."
  }
}

# ---------------------------------------------------------------------------
# Toggles de costo
# ---------------------------------------------------------------------------
variable "enable_interface_endpoints" {
  description = "Crea endpoints de VPC de interfaz (secretsmanager, ssm, states, sqs, kms...). Cuestan por hora y AZ."
  type        = bool
  default     = true
}

variable "interface_endpoint_subnet_count" {
  description = "Número de subredes privadas donde se colocan los endpoints de interfaz (1 abarata, 2+ da alta disponibilidad)."
  type        = number
  default     = 1

  validation {
    condition     = var.interface_endpoint_subnet_count >= 1 && var.interface_endpoint_subnet_count <= 3
    error_message = "interface_endpoint_subnet_count debe estar entre 1 y 3."
  }
}

variable "enable_flow_logs" {
  description = "Habilita VPC Flow Logs hacia CloudWatch Logs."
  type        = bool
  default     = false
}

variable "enable_guardduty" {
  description = "Habilita GuardDuty en la cuenta/región. Desactivar si ya lo gestiona una cuenta de seguridad delegada."
  type        = bool
  default     = true
}

variable "enable_security_hub" {
  description = "Habilita Security Hub. Desactivar si ya lo gestiona una cuenta de seguridad delegada."
  type        = bool
  default     = false
}

variable "enable_cloudtrail" {
  description = "Crea un trail multi-región propio. Desactivar si existe un trail organizacional."
  type        = bool
  default     = true
}

variable "enable_waf" {
  description = "Asocia un WebACL WAFv2 a CloudFront."
  type        = bool
  default     = true
}

variable "enable_qapaqzito" {
  description = "Habilita el asistente IA Qapaqzito en la Lambda api."
  type        = bool
  default     = false
}

variable "enable_account_level_controls" {
  description = "Gestiona controles de cuenta (EBS cifrado por defecto, bloqueo público S3 de cuenta, Access Analyzer). Desactivar si otro stack ya los gestiona."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Aurora Serverless v2
# ---------------------------------------------------------------------------
variable "aurora_min_capacity" {
  description = "ACU mínimas. 0 permite pausa automática."
  type        = number
  default     = 0

  validation {
    condition     = var.aurora_min_capacity >= 0 && var.aurora_min_capacity <= 256
    error_message = "aurora_min_capacity debe estar entre 0 y 256."
  }
}

variable "aurora_max_capacity" {
  description = "ACU máximas."
  type        = number
  default     = 4

  validation {
    condition     = var.aurora_max_capacity >= 1 && var.aurora_max_capacity <= 256
    error_message = "aurora_max_capacity debe estar entre 1 y 256."
  }
}

variable "aurora_seconds_until_auto_pause" {
  description = "Segundos de inactividad antes de pausar (solo con min_capacity = 0)."
  type        = number
  default     = 900
}

variable "aurora_instance_count" {
  description = "Instancias Serverless v2 del clúster (2 = writer + reader en otra AZ)."
  type        = number
  default     = 1

  validation {
    condition     = var.aurora_instance_count >= 1 && var.aurora_instance_count <= 3
    error_message = "aurora_instance_count debe estar entre 1 y 3."
  }
}

variable "aurora_engine_version" {
  description = "Versión de Aurora PostgreSQL (debe soportar escala a 0 ACU)."
  type        = string
  default     = "16.6"
}

variable "aurora_backup_retention_days" {
  description = "Días de retención de backups automáticos de Aurora."
  type        = number
  default     = 7
}

variable "deletion_protection" {
  description = "Protección contra borrado (Aurora, Cognito, EC2). Forzada a true en prod."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Wazuh
# ---------------------------------------------------------------------------
variable "wazuh_instance_type" {
  description = "Tipo de instancia Graviton del nodo Wazuh all-in-one."
  type        = string
  default     = "m7g.xlarge"

  validation {
    condition     = can(regex("^[a-z][0-9]+g[a-z]*\\.", var.wazuh_instance_type))
    error_message = "wazuh_instance_type debe ser una familia Graviton (arm64), p. ej. m7g.xlarge."
  }
}

variable "wazuh_root_volume_gb" {
  description = "Tamaño del volumen raíz gp3 del nodo Wazuh."
  type        = number
  default     = 200

  validation {
    condition     = var.wazuh_root_volume_gb >= 50
    error_message = "wazuh_root_volume_gb debe ser al menos 50."
  }
}

variable "wazuh_version" {
  description = "Versión de Wazuh (manager, indexer, dashboard y agentes)."
  type        = string
  default     = "4.14.8"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.wazuh_version))
    error_message = "wazuh_version debe tener el formato X.Y.Z."
  }
}

variable "wazuh_overlay_s3_uri" {
  description = "URI s3:// opcional de un tar.gz con el overlay QAPAQ (reglas, decoders, dashboard). Debe estar en el bucket artifacts."
  type        = string
  default     = ""

  validation {
    condition     = var.wazuh_overlay_s3_uri == "" || can(regex("^s3://[a-z0-9.-]+/.+", var.wazuh_overlay_s3_uri))
    error_message = "wazuh_overlay_s3_uri debe estar vacío o ser s3://bucket/clave."
  }
}

variable "wazuh_snapshot_retention_days" {
  description = "Días de retención de los snapshots EBS diarios (DLM)."
  type        = number
  default     = 14
}

# ---------------------------------------------------------------------------
# Auditoría y logs
# ---------------------------------------------------------------------------
variable "audit_lock_mode" {
  description = "Modo de Object Lock del bucket de auditoría: GOVERNANCE (reversible con permiso) o COMPLIANCE (irreversible)."
  type        = string
  default     = "GOVERNANCE"

  validation {
    condition     = contains(["GOVERNANCE", "COMPLIANCE"], var.audit_lock_mode)
    error_message = "audit_lock_mode debe ser GOVERNANCE o COMPLIANCE."
  }
}

variable "audit_lock_days" {
  description = "Retención por defecto de Object Lock en días."
  type        = number
  default     = 365

  validation {
    condition     = var.audit_lock_days >= 1
    error_message = "audit_lock_days debe ser >= 1."
  }
}

variable "audit_replica_bucket_arn" {
  description = "ARN opcional del bucket de réplica en la cuenta log-archive (con Object Lock y versionado)."
  type        = string
  default     = ""
}

variable "audit_replica_account_id" {
  description = "ID de la cuenta log-archive dueña del bucket de réplica."
  type        = string
  default     = ""
}

variable "audit_replica_kms_key_arn" {
  description = "ARN de la CMK del bucket de réplica (requerido si se configura audit_replica_bucket_arn)."
  type        = string
  default     = ""
}

variable "log_retention_days" {
  description = "Retención de los grupos de CloudWatch Logs."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days debe ser un valor admitido por CloudWatch Logs."
  }
}

# ---------------------------------------------------------------------------
# Lambda y API
# ---------------------------------------------------------------------------
variable "lambda_memory_mb" {
  description = "Memoria por función (MB)."
  type = object({
    api        = optional(number, 1024)
    worker     = optional(number, 512)
    respond    = optional(number, 512)
    onboarding = optional(number, 256)
  })
  default = {}
}

variable "lambda_timeout_s" {
  description = "Timeout por función (segundos)."
  type = object({
    api        = optional(number, 29)
    worker     = optional(number, 120)
    respond    = optional(number, 60)
    onboarding = optional(number, 120)
  })
  default = {}
}

variable "api_reserved_concurrency" {
  description = "Concurrencia reservada de la Lambda api (-1 = sin reserva). Protege las conexiones de Aurora."
  type        = number
  default     = -1
}

variable "worker_max_concurrency" {
  description = "Concurrencia máxima del event source mapping SQS → worker."
  type        = number
  default     = 5

  validation {
    condition     = var.worker_max_concurrency >= 2 && var.worker_max_concurrency <= 1000
    error_message = "worker_max_concurrency debe estar entre 2 y 1000."
  }
}

variable "api_throttle" {
  description = "Límites de throttling de la etapa por defecto del HTTP API."
  type = object({
    burst_limit = optional(number, 200)
    rate_limit  = optional(number, 100)
  })
  default = {}
}

variable "api_artifact" {
  description = "Paquete S3 opcional del código de las Lambdas Node. Si es null se usa un handler placeholder que responde 503."
  type = object({
    bucket = string
    key    = string
  })
  default = null
}

variable "github_repository" {
  description = "Repositorio GitHub (owner/repo) autorizado a desplegar el código vía OIDC. Vacío = no crear."
  type        = string
  default     = ""

  validation {
    condition     = var.github_repository == "" || can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository debe ser owner/repo o vacío."
  }
}

variable "github_deploy_branch" {
  description = "Rama autorizada a asumir el rol de despliegue."
  type        = string
  default     = "main"
}

variable "create_github_oidc_provider" {
  description = "Crea el proveedor OIDC de GitHub (false si ya existe en la cuenta; se reutiliza por data source)."
  type        = bool
  default     = true
}

variable "github_oidc_subject_prefix" {
  description = "Prefijo del claim sub de GitHub. Vacío = repo:<github_repository>. Si el repositorio usa subject inmutable, usar repo:<owner>@<owner_id>/<repo>@<repo_id> (gh api repos/<owner>/<repo>/actions/oidc/customization/sub)."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Costos y alertas
# ---------------------------------------------------------------------------
variable "alert_email" {
  description = "Correo que recibe alertas operativas y de presupuesto. Vacío = sin suscripción."
  type        = string
  default     = ""

  validation {
    condition     = var.alert_email == "" || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email debe ser un correo válido o vacío."
  }
}

variable "monthly_budget_usd" {
  description = "Presupuesto mensual en USD (0 = no crear Budget)."
  type        = number
  default     = 500
}

# ---------------------------------------------------------------------------
# Agentes Wazuh dinámicos
# ---------------------------------------------------------------------------
variable "agent_target_mode" {
  description = "tag: solo instancias con qapaq-agent=enabled; all: la Lambda de onboarding etiqueta toda instancia nueva salvo qapaq-agent=disabled."
  type        = string
  default     = "tag"

  validation {
    condition     = contains(["tag", "all"], var.agent_target_mode)
    error_message = "agent_target_mode debe ser tag o all."
  }
}

variable "agent_default_group" {
  description = "Grupo Wazuh por defecto cuando la instancia no tiene el tag qapaq-agent-group."
  type        = string
  default     = "default"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]{1,64}$", var.agent_default_group))
    error_message = "agent_default_group solo admite letras, dígitos, punto, guion y guion bajo."
  }
}

variable "agent_manager_address" {
  description = "Dirección del manager que usan los agentes AWS (vacío = IP privada del nodo; usar la EIP o un DNS si hay agentes en otras VPC/cuentas)."
  type        = string
  default     = ""
}

variable "hybrid_activation_limit" {
  description = "Máximo de nodos fuera de AWS registrables con la activación híbrida de SSM (0 = no crear)."
  type        = number
  default     = 0

  validation {
    condition     = var.hybrid_activation_limit >= 0 && var.hybrid_activation_limit <= 1000
    error_message = "hybrid_activation_limit debe estar entre 0 y 1000."
  }
}

# ---------------------------------------------------------------------------
# Dominio e identidad
# ---------------------------------------------------------------------------
variable "domain_name" {
  description = "Nombre de dominio opcional para CloudFront (requiere certificate_arn en us-east-1)."
  type        = string
  default     = ""
}

variable "certificate_arn" {
  description = "ARN de un certificado ACM en us-east-1 para domain_name."
  type        = string
  default     = ""

  validation {
    condition     = var.certificate_arn == "" || can(regex("^arn:aws:acm:us-east-1:[0-9]{12}:certificate/", var.certificate_arn))
    error_message = "certificate_arn debe ser un certificado ACM de us-east-1."
  }
}

variable "route53_zone_name" {
  description = "Zona pública de Route 53 que contiene domain_name. Si se define, Terraform emite el certificado ACM (validación DNS) y crea los alias hacia CloudFront."
  type        = string
  default     = ""
}

variable "cognito_domain_prefix" {
  description = "Prefijo del dominio hospedado de Cognito (vacío = <project>-<environment>-<sufijo>)."
  type        = string
  default     = ""
}

variable "cognito_callback_urls" {
  description = "URLs de callback OAuth adicionales del cliente BFF."
  type        = list(string)
  default     = []
}

variable "entra_tenant_id" {
  description = "Tenant de Entra ID para federación OIDC (vacío = sin federación)."
  type        = string
  default     = ""
}

variable "entra_client_id" {
  description = "Client ID de la app registrada en Entra."
  type        = string
  default     = ""
}

variable "entra_client_secret" {
  description = "Secreto de cliente de Entra. Pasarlo por TF_VAR_entra_client_secret, nunca en tfvars. Cognito lo guarda en el estado: proteger el bucket de estado."
  type        = string
  default     = ""
  sensitive   = true
}

# ---------------------------------------------------------------------------
# Qapaqzito (asistente IA)
# ---------------------------------------------------------------------------
variable "qapaqzito_provider" {
  description = "bedrock (recomendado, vía endpoint de VPC) o anthropic (API directa; requiere salida a Internet)."
  type        = string
  default     = "bedrock"

  validation {
    condition     = contains(["bedrock", "anthropic"], var.qapaqzito_provider)
    error_message = "qapaqzito_provider debe ser bedrock o anthropic."
  }
}

variable "qapaqzito_model" {
  description = "Modelo Claude de Qapaqzito. Con bedrock (cliente Mantle) se le antepone 'anthropic.' si no lo trae."
  type        = string
  default     = "claude-opus-5-5"
}

variable "qapaqzito_model_ids" {
  description = "IDs de modelo/perfil de inferencia de Bedrock autorizados. Vacío = derivado de qapaqzito_model."
  type        = list(string)
  default     = []
}

variable "qapaqzito_effort" {
  description = "Nivel de esfuerzo por defecto de Qapaqzito (QAPAQ_QAPAQZITO_EFFORT)."
  type        = string
  default     = "medium"

  validation {
    condition     = contains(["low", "medium", "high", "xhigh", "max"], var.qapaqzito_effort)
    error_message = "qapaqzito_effort debe ser low, medium, high, xhigh o max."
  }
}

variable "qapaqzito_redact_pii" {
  description = "Redacta PII antes de enviar contexto al modelo (QAPAQ_QAPAQZITO_REDACT_PII)."
  type        = bool
  default     = true
}

variable "qapaqzito_bedrock_endpoint_services" {
  description = "Servicios de endpoint de VPC para Bedrock (sufijo tras com.amazonaws.<región>.). Añadir el de Mantle si el cliente lo usa y existe en la región."
  type        = list(string)
  default     = ["bedrock-runtime"]
}

variable "qapaqzito_internet_egress_available" {
  description = "Declara que el operador añadió una salida a Internet (NAT/proxy) para las Lambdas en VPC. Necesario si qapaqzito_provider = anthropic."
  type        = bool
  default     = false
}
