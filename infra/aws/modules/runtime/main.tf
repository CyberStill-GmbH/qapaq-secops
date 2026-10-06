locals {
  service_names = toset(["krakend", "api", "worker"])
  repository_names = {
    api     = "${var.project}-api"
    worker  = "${var.project}-worker"
    krakend = "${var.project}-krakend"
  }
  repository_arns = [
    for name in values(local.repository_names) : "arn:aws:ecr:${var.region}:${var.account_id}:repository/${name}"
  ]
  log_group_arns = [for group in aws_cloudwatch_log_group.service : "${group.arn}:*"]
  api_environment = merge({
    NODE_ENV                      = "production"
    QAPAQ_PROFILE                 = "production"
    QAPAQ_API_HOST                = "0.0.0.0"
    QAPAQ_API_PORT                = "3000"
    QAPAQ_ENTRA_CLIENT_SECRET_REF = "secret://aws-secretsmanager/qapaq-secops/demo/entra/client-secret"
  }, var.api_environment)
  krakend_environment = merge({
    QAPAQ_API_UPSTREAM        = "http://api.${var.environment}.qapaq.internal:3000"
    GATEWAY_ENDPOINT_TIMEOUT  = "4s"
    GATEWAY_METRICS_PORT      = "9091"
    GATEWAY_RATE_PER_SECOND   = "20"
    GATEWAY_RATE_BURST        = "40"
    OIDC_DISABLE_JWK_SECURITY = "false"
  }, var.krakend_environment)
  container_definitions = {
    krakend = {
      name              = "krakend"
      image             = "${var.account_id}.dkr.ecr.${var.region}.amazonaws.com/${local.repository_names.krakend}@${var.image_digests.krakend}"
      essential         = true
      cpu               = 256
      memoryReservation = 384
      portMappings      = [{ containerPort = 8080, hostPort = 8080, protocol = "tcp" }]
      environment       = [for key, value in local.krakend_environment : { name = key, value = value }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.service["krakend"].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
    api = {
      name              = "api"
      image             = "${var.account_id}.dkr.ecr.${var.region}.amazonaws.com/${local.repository_names.api}@${var.image_digests.api}"
      essential         = true
      cpu               = 512
      memoryReservation = 768
      portMappings      = [{ containerPort = 3000, hostPort = 3000, protocol = "tcp" }]
      environment       = [for key, value in local.api_environment : { name = key, value = value }]
      healthCheck = {
        command     = ["CMD", "/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 20
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.service["api"].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
    worker = {
      name              = "worker"
      image             = "${var.account_id}.dkr.ecr.${var.region}.amazonaws.com/${local.repository_names.worker}@${var.image_digests.worker}"
      essential         = true
      cpu               = 256
      memoryReservation = 384
      environment       = [{ name = "NODE_ENV", value = "production" }, { name = "QAPAQ_PROFILE", value = "production" }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.service["worker"].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
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

resource "aws_ecs_cluster" "this" {
  name = "${var.project}-${var.environment}"

  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = {
    Project     = var.project
    Environment = var.environment
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.project}-${var.environment}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  tags               = { Project = var.project, Environment = var.environment }
}

resource "aws_iam_role_policy" "execution" {
  name = "pull-images-and-write-operational-logs"
  role = aws_iam_role.execution.id
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
        Sid      = "PullOnlyQapaqImages"
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource = local.repository_arns
      },
      {
        Sid      = "WriteOnlyRuntimeLogGroups"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = local.log_group_arns
      }
    ]
  })
}

resource "aws_iam_role" "task" {
  for_each           = local.service_names
  name               = "${var.project}-${var.environment}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  tags               = { Project = var.project, Environment = var.environment, Service = each.key }
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = local.service_names
  name              = "/${var.project}/${var.environment}/${each.key}"
  retention_in_days = 7

  tags = {
    Project     = var.project
    Environment = var.environment
    Service     = each.key
    DataClass   = "operational-only"
  }
}

resource "aws_service_discovery_private_dns_namespace" "this" {
  name        = "${var.environment}.qapaq.internal"
  description = "Private ECS service discovery for QAPAQ SECOPS demo."
  vpc         = var.vpc_id
  tags        = { Project = var.project, Environment = var.environment }
}

resource "aws_service_discovery_service" "api" {
  name = "api"

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.this.id
    routing_policy = "MULTIVALUE"
    dns_records {
      ttl  = 10
      type = "A"
    }
  }

  tags = { Project = var.project, Environment = var.environment }
}

# El ALB público es el punto de entrada requerido para esta demo; retirar al migrar a origen privado.
#trivy:ignore:AWS-0053
resource "aws_lb" "this" {
  name                       = "${var.project}-${var.environment}-alb"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [var.security_group_ids.alb]
  subnets                    = var.public_subnet_ids
  enable_deletion_protection = false
  drop_invalid_header_fields = true

  tags = { Project = var.project, Environment = var.environment }
}

resource "aws_lb_target_group" "krakend" {
  name                 = "${var.project}-${var.environment}-krakend"
  port                 = 8080
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 20

  health_check {
    enabled             = true
    path                = "/__health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Project = var.project, Environment = var.environment, Service = "krakend" }
}

# HTTP es temporal mientras no haya dominio/certificado ACM; no transportar sesiones ni credenciales reales.
#trivy:ignore:AWS-0054
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.krakend.arn
  }
}

resource "aws_ecs_task_definition" "this" {
  for_each                 = local.service_names
  family                   = "${var.project}-${var.environment}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.key == "api" ? "512" : "256"
  memory                   = each.key == "api" ? "1024" : "512"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task[each.key].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([local.container_definitions[each.key]])

  tags = {
    Project             = var.project
    Environment         = var.environment
    Service             = each.key
    ImageManifestCommit = var.image_manifest_commit
  }
}

resource "aws_ecs_service" "krakend" {
  name            = "${var.project}-${var.environment}-krakend"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this["krakend"].arn
  desired_count   = var.desired_counts.krakend
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.app_subnet_ids
    security_groups  = [var.security_group_ids.krakend]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.krakend.arn
    container_name   = "krakend"
    container_port   = 8080
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100
  health_check_grace_period_seconds  = var.health_check_grace_period_seconds
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"

  depends_on = [aws_lb_listener.http]
  tags       = { Project = var.project, Environment = var.environment, Service = "krakend" }
}

resource "aws_ecs_service" "api" {
  name            = "${var.project}-${var.environment}-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this["api"].arn
  desired_count   = var.desired_counts.api
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.app_subnet_ids
    security_groups  = [var.security_group_ids.api]
    assign_public_ip = false
  }

  service_registries {
    registry_arn   = aws_service_discovery_service.api.arn
    container_name = "api"
    container_port = 3000
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"
  tags                               = { Project = var.project, Environment = var.environment, Service = "api" }
}

resource "aws_ecs_service" "worker" {
  name            = "${var.project}-${var.environment}-worker"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this["worker"].arn
  desired_count   = var.desired_counts.worker
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.app_subnet_ids
    security_groups  = [var.security_group_ids.worker]
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"
  tags                               = { Project = var.project, Environment = var.environment, Service = "worker" }
}

resource "aws_eip" "api_egress" {
  domain = "vpc"
  tags   = { Name = "${var.project}-${var.environment}-api-egress", Project = var.project, Environment = var.environment }
}

resource "aws_nat_gateway" "api_egress" {
  allocation_id     = aws_eip.api_egress.id
  subnet_id         = var.public_subnet_ids[0]
  connectivity_type = "public"

  tags = { Name = "${var.project}-${var.environment}-api-egress", Project = var.project, Environment = var.environment }
}

resource "aws_route" "api_egress" {
  route_table_id         = var.app_route_table_id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.api_egress.id
}

resource "aws_vpc_security_group_egress_rule" "api_to_entra_https" {
  security_group_id = var.security_group_ids.api
  description       = "HTTPS egress for Entra OIDC discovery, JWKS, and server-side token exchange through the demo NAT gateway."
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  ip_protocol       = "tcp"
  to_port           = 443
}
