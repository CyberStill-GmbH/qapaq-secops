data "aws_route53_zone" "public_api" {
  count = var.enable_https ? 1 : 0

  name         = local.public_route53_zone_lookup_name
  private_zone = false
}

locals {
  public_route53_zone_lookup_name = var.enable_https && var.public_route53_zone_name != null ? "${trimsuffix(lower(var.public_route53_zone_name), ".")}." : null
  public_route53_zone_name        = var.enable_https && var.public_route53_zone_name != null ? trimsuffix(lower(var.public_route53_zone_name), ".") : ""
  public_api_hostname             = var.enable_https && var.public_api_hostname != null ? lower(var.public_api_hostname) : ""
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

  zone_id         = data.aws_route53_zone.public_api[0].zone_id
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

  zone_id = data.aws_route53_zone.public_api[0].zone_id
  name    = var.public_api_hostname
  type    = "A"

  alias {
    name                   = module.runtime.load_balancer_dns_name
    zone_id                = module.runtime.load_balancer_zone_id
    evaluate_target_health = true
  }
}

output "public_api_url" {
  description = "HTTPS URL routed by Route 53 to the public KrakenD ALB."
  value       = var.enable_https ? "https://${var.public_api_hostname}" : null
}
