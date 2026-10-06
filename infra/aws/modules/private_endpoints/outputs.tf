output "security_group_id" {
  description = "Security group that restricts VPC endpoint HTTPS ingress to application runtimes."
  value       = aws_security_group.this.id
}

output "interface_endpoint_ids" {
  description = "Interface VPC endpoint IDs keyed by AWS service suffix."
  value       = { for service, endpoint in aws_vpc_endpoint.interface : service => endpoint.id }
}

output "s3_gateway_endpoint_id" {
  description = "S3 gateway endpoint ID for private application route tables."
  value       = aws_vpc_endpoint.s3.id
}
