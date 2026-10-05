output "aws_account_id" {
  description = "AWS account authenticated by the GitHub Actions OIDC role."
  value       = data.aws_caller_identity.current.account_id
}

output "aws_caller_arn" {
  description = "AWS principal authenticated by the GitHub Actions OIDC role."
  value       = data.aws_caller_identity.current.arn
}
