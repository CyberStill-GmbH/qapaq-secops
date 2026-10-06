output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "load_balancer_dns_name" {
  description = "Public ALB hostname; HTTPS terminates at the ALB when enabled, and port 80 redirects to HTTPS."
  value       = aws_lb.this.dns_name
}

output "load_balancer_arn" {
  value = aws_lb.this.arn
}

output "load_balancer_zone_id" {
  description = "Canonical Route 53 hosted zone ID of the public ALB, used for alias records."
  value       = aws_lb.this.zone_id
}

output "private_api_hostname" {
  value = "api.${aws_service_discovery_private_dns_namespace.this.name}"
}

output "execution_role_arn" {
  value = aws_iam_role.execution.arn
}

output "task_role_arns" {
  value = { for service, role in aws_iam_role.task : service => role.arn }
}

output "nat_gateway_id" {
  value = aws_nat_gateway.api_egress.id
}
