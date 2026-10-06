resource "aws_route53_zone" "public_api" {
  count = var.public_route53_zone_name != null ? 1 : 0

  name = local.public_route53_zone_name

  tags = {
    Project     = var.project
    Environment = var.environment
    Purpose     = "public-dns"
  }
}

locals {
  public_route53_zone_name = var.public_route53_zone_name != null ? trimsuffix(lower(var.public_route53_zone_name), ".") : ""
  public_api_hostname      = var.enable_https && var.public_api_hostname != null ? lower(var.public_api_hostname) : ""
  public_api_hostname_in_zone = var.enable_https ? (
    local.public_api_hostname == local.public_route53_zone_name ||
    endswith(local.public_api_hostname, ".${local.public_route53_zone_name}")
  ) : true
}

resource "aws_acm_certificate" "public_api" {
  count = var.enable_https ? 1 : 0

  domain_name       = var.public_api_hostname
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true

    precondition {
      condition     = local.public_api_hostname_in_zone
      error_message = "public_api_hostname must be inside the public Route 53 zone selected by public_route53_zone_id."
    }
  }

  tags = {
    Project     = var.project
    Environment = var.environment
    Purpose     = "public-api-tls"
  }
}

resource "aws_route53_record" "acm_validation" {
  for_each = var.enable_https ? {
    for option in aws_acm_certificate.public_api[0].domain_validation_options : option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  } : {}

  zone_id         = aws_route53_zone.public_api[0].zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "public_api" {
  count = var.enable_https ? 1 : 0

  certificate_arn = aws_acm_certificate.public_api[0].arn
  validation_record_fqdns = [
    for record in aws_route53_record.acm_validation : record.fqdn
  ]
}

resource "aws_route53_record" "public_api" {
  count = var.enable_https ? 1 : 0

  zone_id = aws_route53_zone.public_api[0].zone_id
  name    = var.public_api_hostname
  type    = "A"

  alias {
    name                   = module.runtime.load_balancer_dns_name
    zone_id                = module.runtime.load_balancer_zone_id
    evaluate_target_health = true
  }
}

output "public_api_url" {
  description = "Public QAPAQ API URL."
  value       = var.enable_https ? "https://${var.public_api_hostname}" : module.wazuh_public.api_url
}

output "public_route53_zone_name_servers" {
  description = "Delegate the public child zone at its parent DNS provider to these Route 53 name servers."
  value       = var.public_route53_zone_name != null ? aws_route53_zone.public_api[0].name_servers : []
}
