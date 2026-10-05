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
