output "aws_account_id" {
  description = "AWS account authenticated by the GitHub Actions OIDC role."
  value       = data.aws_caller_identity.current.account_id
}

output "aws_caller_arn" {
  description = "AWS principal authenticated by the GitHub Actions OIDC role."
  value       = data.aws_caller_identity.current.arn
}

output "vpc_id" {
  description = "ID of the demo VPC."
  value       = module.networking.vpc_id
}

output "availability_zones" {
  description = "Availability Zones selected for the demo network."
  value       = module.networking.availability_zones
}

output "public_subnet_ids" {
  description = "IDs of the public subnets."
  value       = module.networking.public_subnet_ids
}

output "private_app_subnet_ids" {
  description = "IDs of the private application subnets."
  value       = module.networking.app_subnet_ids
}

output "private_data_subnet_ids" {
  description = "IDs of the isolated private data subnets."
  value       = module.networking.data_subnet_ids
}

output "security_group_ids" {
  description = "IDs of the separate architecture security groups."
  value       = module.security.security_group_ids
}

output "ecr_repository_urls" {
  description = "Private ECR repository URLs for API, Worker, and KrakenD."
  value       = module.application_foundations.ecr_repository_urls
}

output "s3_bucket_names" {
  description = "Private bucket names for raw events, evidence, and artifacts."
  value       = module.application_foundations.s3_bucket_names
}

output "metadata_secret_arns" {
  description = "Secrets Manager secret ARNs. No values or secret versions are managed by Terraform."
  value       = module.application_foundations.metadata_secret_arns
}

output "github_ecr_publisher_role_arn" {
  description = "GitHub main-only OIDC role with push access to the three demo ECR repositories."
  value       = module.application_foundations.github_ecr_publisher_role_arn
}

output "postgres_endpoint" {
  description = "Private PostgreSQL hostname."
  value       = module.database.endpoint
}

output "postgres_port" {
  description = "PostgreSQL port."
  value       = module.database.port
}

output "postgres_database_name" {
  description = "PostgreSQL database name."
  value       = module.database.database_name
}

output "postgres_master_secret_arn" {
  description = "RDS-managed master credential secret ARN."
  value       = module.database.master_secret_arn
}

output "valkey_primary_endpoint" {
  description = "Private Valkey primary hostname; use TLS and AUTH."
  value       = module.cache.primary_endpoint
}

output "valkey_port" {
  description = "Valkey port."
  value       = module.cache.port
}

output "valkey_auth_secret_arn" {
  description = "Secrets Manager ARN for the Valkey AUTH token."
  value       = module.cache.auth_secret_arn
}

output "private_endpoint_ids" {
  description = "Private interface endpoint IDs for ECR, Secrets Manager, and CloudWatch Logs."
  value       = module.private_endpoints.interface_endpoint_ids
}

output "s3_gateway_endpoint_id" {
  description = "S3 gateway endpoint ID for application private route tables."
  value       = module.private_endpoints.s3_gateway_endpoint_id
}
