output "ecr_repository_urls" {
  description = "Private ECR repository URLs keyed by service."
  value       = { for key, repository in aws_ecr_repository.this : key => repository.repository_url }
}

output "s3_bucket_names" {
  description = "Private S3 bucket names keyed by data purpose."
  value       = { for key, bucket in aws_s3_bucket.this : key => bucket.bucket }
}

output "metadata_secret_arns" {
  description = "Secret metadata ARNs only; no values or secret versions are created."
  value       = { for key, secret in aws_secretsmanager_secret.metadata : key => secret.arn }
}

output "github_ecr_publisher_role_arn" {
  description = "OIDC role restricted to the configured GitHub repository main branch."
  value       = aws_iam_role.github_ecr_publisher.arn
}
