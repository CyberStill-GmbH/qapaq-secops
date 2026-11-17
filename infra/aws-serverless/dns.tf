# Dominio público en Route 53: si route53_zone_name está definido, Terraform emite el
# certificado ACM (us-east-1, validación DNS en la zona) y crea los alias A/AAAA de
# domain_name hacia CloudFront. Con certificate_arn explícito se usa ese certificado y solo
# se crean los alias.

locals {
  route53_enabled      = var.route53_zone_name != "" && var.domain_name != ""
  managed_certificate  = local.route53_enabled && var.certificate_arn == ""
  edge_certificate_arn = local.managed_certificate ? aws_acm_certificate_validation.edge[0].certificate_arn : var.certificate_arn
}

data "aws_route53_zone" "public" {
  count = local.route53_enabled ? 1 : 0

  name         = var.route53_zone_name
  private_zone = false
}

resource "aws_acm_certificate" "edge" {
  count    = local.managed_certificate ? 1 : 0
  provider = aws.us_east_1

  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "edge_cert_validation" {
  for_each = local.managed_certificate ? {
    for o in aws_acm_certificate.edge[0].domain_validation_options : o.domain_name => o
  } : {}

  zone_id         = data.aws_route53_zone.public[0].zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "edge" {
  count    = local.managed_certificate ? 1 : 0
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.edge[0].arn
  validation_record_fqdns = [for r in aws_route53_record.edge_cert_validation : r.fqdn]
}

resource "aws_route53_record" "edge_alias" {
  for_each = local.route53_enabled ? toset(["A", "AAAA"]) : toset([])

  zone_id = data.aws_route53_zone.public[0].zone_id
  name    = var.domain_name
  type    = each.value

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}
