# C-1 — tarea one-off de base de datos: bootstrap de roles y migraciones (decisiones D-6/D-7).
#
# Este módulo NO ejecuta nada al aplicarse: define la task definition, sus roles y los
# contenedores de secreto. El workflow `migrate-database.yml` la lanza con `run-task` y
# falla el release si la tarea no termina con código 0.
#
# Secretos:
# - `postgres/migrator` y `postgres/soc-runtime`: Terraform crea solo los contenedores. Los
#   valores (usuario y contraseña) los genera la propia tarea en modo `bootstrap-roles`, de
#   modo que las contraseñas nunca pasan por el state ni por el plan.
# - El master administrado por RDS solo se inyecta en esta tarea, nunca en el API.

locals {
  name      = "${var.project}-${var.environment}-migrator"
  log_group = "/${var.project}/${var.environment}/migrator"
  image     = var.image_digest == null ? null : "${var.repository_url}@${var.image_digest}"
}

resource "aws_secretsmanager_secret" "role" {
  for_each = {
    migrator    = "Credencial de qapaq_migrator (DDL, solo tarea de migración)."
    soc_runtime = "Credencial de qapaq_soc_runtime (DML del API, sin DDL)."
  }

  name                    = "${var.project}/${var.environment}/postgres/${replace(each.key, "_", "-")}"
  description             = each.value
  recovery_window_in_days = 7

  tags = {
    Project     = var.project
    Environment = var.environment
    Purpose     = "postgres-${replace(each.key, "_", "-")}"
  }
}

# D-10b — clave HMAC de las referencias opacas de entidad. La genera `bootstrap-roles` solo
# si el secreto no tiene versión vigente; nunca se rota sola porque invalidaría las
# referencias guardadas en `soc_alerts.entity_refs`.
# Sprint 5 — clave privada VAPID del Web Push. La genera `bootstrap-roles` solo si no tiene
# versión vigente; rotarla invalidaría las suscripciones de todos los dispositivos.
resource "aws_secretsmanager_secret" "vapid_private_key" {
  name                    = "${var.project}/${var.environment}/api/vapid-private-key"
  description             = "Clave privada VAPID (P-256, PKCS#8 base64) para avisos Web Push del API."
  recovery_window_in_days = 7

  tags = {
    Project     = var.project
    Environment = var.environment
    Purpose     = "api-web-push"
  }
}

resource "aws_secretsmanager_secret" "entity_ref_key" {
  name                    = "${var.project}/${var.environment}/api/entity-ref-key"
  description             = "Clave HMAC de las referencias opacas de entidad del API (D-10b)."
  recovery_window_in_days = 7

  tags = {
    Project     = var.project
    Environment = var.environment
    Purpose     = "api-entity-ref-key"
  }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = local.log_group
  retention_in_days = 30

  tags = {
    Project     = var.project
    Environment = var.environment
    Service     = "migrator"
    DataClass   = "operational-only"
  }
}

data "aws_iam_policy_document" "ecs_tasks_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution roles separados por modo: el de `bootstrap` puede leer la credencial master y el
# de `migrate` solo la del migrator. Ninguno es el rol de los servicios del runtime.
locals {
  execution_secrets = {
    bootstrap = [var.master_secret_arn]
    migrate   = [aws_secretsmanager_secret.role["migrator"].arn]
  }
}

resource "aws_iam_role" "execution" {
  for_each           = local.execution_secrets
  name               = "${local.name}-${each.key}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  tags               = { Project = var.project, Environment = var.environment, Service = "migrator" }
}

resource "aws_iam_role_policy" "execution" {
  for_each = local.execution_secrets
  name     = "pull-migrator-and-inject-${each.key}-credentials"
  role     = aws_iam_role.execution[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrAuthToken"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid      = "PullOnlyMigratorImage"
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource = [var.repository_arn]
      },
      {
        Sid      = "WriteOnlyMigratorLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${aws_cloudwatch_log_group.this.arn}:*"]
      },
      {
        Sid      = "InjectOnlyThisModeCredential"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = each.value
      }
    ]
  })
}

# Task role: solo publica las credenciales que el bootstrap genera, en sus dos secretos.
resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  tags               = { Project = var.project, Environment = var.environment, Service = "migrator" }
}

resource "aws_iam_role_policy" "task" {
  name = "rotate-postgres-role-secrets"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "StageAndPromoteRoleCredentials"
      Effect = "Allow"
      # GetSecretValue: el protocolo D-11 relee la candidata AWSPENDING de una corrida
      # incompleta para reaplicar exactamente esa contraseña.
      Action = [
        "secretsmanager:PutSecretValue",
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret",
        "secretsmanager:UpdateSecretVersionStage",
      ]
      Resource = concat(
        [for secret in aws_secretsmanager_secret.role : secret.arn],
        [aws_secretsmanager_secret.entity_ref_key.arn, aws_secretsmanager_secret.vapid_private_key.arn],
      )
    }]
  })
}

resource "aws_ecs_task_definition" "bootstrap" {
  # Sin imagen publicada no hay tarea: el módulo puede aplicarse antes del primer build.
  count = local.image == null ? 0 : 1

  family                   = "${local.name}-bootstrap"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution["bootstrap"].arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "migrator"
    image     = local.image
    essential = true
    command   = ["bootstrap-roles"]
    environment = [
      { name = "AWS_REGION", value = var.region },
      { name = "QAPAQ_POSTGRES_HOST", value = var.postgres.host },
      { name = "QAPAQ_POSTGRES_PORT", value = tostring(var.postgres.port) },
      { name = "QAPAQ_POSTGRES_DATABASE", value = var.postgres.database },
      { name = "QAPAQ_POSTGRES_TLS", value = "true" },
      { name = "QAPAQ_MIGRATOR_SECRET_ID", value = aws_secretsmanager_secret.role["migrator"].arn },
      { name = "QAPAQ_RUNTIME_SECRET_ID", value = aws_secretsmanager_secret.role["soc_runtime"].arn },
      { name = "QAPAQ_ENTITY_REF_SECRET_ID", value = aws_secretsmanager_secret.entity_ref_key.arn },
      { name = "QAPAQ_VAPID_SECRET_ID", value = aws_secretsmanager_secret.vapid_private_key.arn },
    ]
    # ECS lee las claves JSON del secret administrado por RDS al arrancar la tarea.
    secrets = [
      { name = "QAPAQ_MASTER_USERNAME", valueFrom = "${var.master_secret_arn}:username::" },
      { name = "QAPAQ_MASTER_PASSWORD", valueFrom = "${var.master_secret_arn}:password::" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.this.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "bootstrap"
      }
    }
  }])

  depends_on = [aws_iam_role_policy.execution]

  tags = {
    Project             = var.project
    Environment         = var.environment
    Service             = "migrator"
    ImageManifestCommit = var.image_manifest_commit
  }
}

# Task definition separada para `migrate`: inyecta la credencial del migrator y no la master.
resource "aws_ecs_task_definition" "migrate" {
  count = local.image == null ? 0 : 1

  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution["migrate"].arn
  # `migrate` no publica secretos: no necesita task role.
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "migrator"
    image     = local.image
    essential = true
    command   = ["migrate"]
    environment = [
      { name = "QAPAQ_POSTGRES_HOST", value = var.postgres.host },
      { name = "QAPAQ_POSTGRES_PORT", value = tostring(var.postgres.port) },
      { name = "QAPAQ_POSTGRES_DATABASE", value = var.postgres.database },
      { name = "QAPAQ_POSTGRES_TLS", value = "true" },
    ]
    secrets = [
      {
        name      = "QAPAQ_MIGRATOR_PASSWORD"
        valueFrom = "${aws_secretsmanager_secret.role["migrator"].arn}:password::"
      },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.this.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "migrate"
      }
    }
  }])

  depends_on = [aws_iam_role_policy.execution]

  tags = {
    Project             = var.project
    Environment         = var.environment
    Service             = "migrator"
    ImageManifestCommit = var.image_manifest_commit
  }
}
