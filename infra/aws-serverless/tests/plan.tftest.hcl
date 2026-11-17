# Pruebas offline (sin credenciales AWS): planifican el stack con proveedores simulados para
# detectar errores de expresiones, conteos y validaciones de variables.
#   terraform init -backend=false && terraform test

mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b", "us-east-1c"] }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_region" {
    defaults = { region = "us-east-1" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_ssm_parameter" {
    defaults = { insecure_value = "ami-0123456789abcdef0" }
  }
  mock_resource "aws_rds_cluster" {
    defaults = {
      master_user_secret  = [{ secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds-abc", kms_key_id = "k", secret_status = "active" }]
      cluster_resource_id = "cluster-ABC"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
}

mock_provider "random" {}
mock_provider "time" {}
mock_provider "archive" {}

variables {
  environment         = "dev"
  allowed_admin_cidrs = ["203.0.113.10/32"]
}

run "dev_minimo" {
  command = plan

  assert {
    condition     = length(aws_vpc_endpoint.interface) == 5
    error_message = "Se esperaban 5 endpoints de interfaz sin Qapaqzito."
  }

  assert {
    condition     = length(aws_wafv2_web_acl.edge) == 1
    error_message = "WAF debe crearse por defecto."
  }
}

run "prod_completo" {
  command = plan

  variables {
    environment             = "prod"
    enable_qapaqzito            = true
    enable_security_hub     = true
    enable_flow_logs        = true
    hybrid_activation_limit = 10
    agent_target_mode       = "all"
    github_repository       = "org/qapaq-secops"
    aurora_min_capacity     = 0.5
    aurora_instance_count   = 2
  }

  assert {
    condition     = local.qapaqzito_model_id == "anthropic.claude-opus-5-5"
    error_message = "Con Bedrock el modelo debe llevar el prefijo anthropic."
  }

  assert {
    condition     = contains(keys(aws_vpc_endpoint.interface), "bedrock-runtime")
    error_message = "Con Qapaqzito en Bedrock debe existir el endpoint bedrock-runtime."
  }

  assert {
    condition     = local.deletion_protection
    error_message = "prod debe forzar deletion_protection."
  }

  assert {
    condition     = length(aws_ssm_activation.agents) == 1 && length(aws_ssm_association.install_agent_hybrid) == 1
    error_message = "Debe crearse la activación híbrida y su asociación."
  }
}

run "rechaza_cidr_abierto" {
  command = plan

  variables {
    allowed_admin_cidrs = ["0.0.0.0/0"]
  }

  expect_failures = [var.allowed_admin_cidrs]
}

run "anthropic_sin_salida_avisa" {
  command = plan

  variables {
    enable_qapaqzito   = true
    qapaqzito_provider = "anthropic"
  }

  expect_failures = [check.qapaqzito_network_path]
}
