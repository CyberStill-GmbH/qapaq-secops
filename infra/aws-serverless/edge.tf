# Borde: CloudFront (us-east-1) → API Gateway HTTP API, con WAFv2 opcional.
#
# Limitación de esta versión: el dashboard de Wazuh NO se publica por CloudFront. Se accede
# por 443 directamente al nodo (EIP), restringido por SG a allowed_admin_cidrs (VPN/oficina).
# Publicarlo detrás de CloudFront exige un origen HTTPS con certificado válido y
# autenticación coherente con Cognito; queda para una versión posterior.

data "aws_cloudfront_cache_policy" "disabled" {
  provider = aws.us_east_1
  name     = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  provider = aws.us_east_1
  name     = "Managed-AllViewerExceptHostHeader"
}

data "aws_cloudfront_response_headers_policy" "security_headers" {
  provider = aws.us_east_1
  name     = "Managed-SecurityHeadersPolicy"
}

locals {
  custom_domain  = var.domain_name != "" && (var.certificate_arn != "" || local.managed_certificate)
  api_origin_id  = "qapaq-http-api"
  api_origin_dns = replace(aws_apigatewayv2_api.http.api_endpoint, "https://", "")
  waf_rate_limit = 1000
}

resource "aws_cloudfront_distribution" "main" {
  provider = aws.us_east_1

  enabled         = true
  comment         = "${local.name} QAPAQ SOC"
  price_class     = "PriceClass_100"
  http_version    = "http2and3"
  is_ipv6_enabled = true
  aliases         = local.custom_domain ? [var.domain_name] : []
  web_acl_id      = var.enable_waf ? aws_wafv2_web_acl.edge[0].arn : null

  origin {
    origin_id   = local.api_origin_id
    domain_name = local.api_origin_dns

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }

    custom_header {
      name  = local.origin_verify_header
      value = random_password.origin_verify.result
    }
  }

  default_cache_behavior {
    target_origin_id           = local.api_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security_headers.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = !local.custom_domain
    acm_certificate_arn            = local.custom_domain ? local.edge_certificate_arn : null
    ssl_support_method             = local.custom_domain ? "sni-only" : null
    minimum_protocol_version       = local.custom_domain ? "TLSv1.2_2021" : "TLSv1"
  }

  lifecycle {
    precondition {
      condition     = var.domain_name == "" || var.certificate_arn != "" || var.route53_zone_name != ""
      error_message = "domain_name requiere certificate_arn o route53_zone_name (certificado gestionado)."
    }
  }
}

# ---------------------------------------------------------------------------
# WAFv2 (alcance CLOUDFRONT, us-east-1)
# ---------------------------------------------------------------------------
locals {
  waf_managed_rules = {
    AWSManagedRulesCommonRuleSet          = 10
    AWSManagedRulesKnownBadInputsRuleSet  = 20
    AWSManagedRulesAmazonIpReputationList = 30
  }
}

resource "aws_wafv2_web_acl" "edge" {
  count    = var.enable_waf ? 1 : 0
  provider = aws.us_east_1

  name  = "${local.name}-edge"
  scope = "CLOUDFRONT"

  default_action {
    allow {}
  }

  dynamic "rule" {
    for_each = local.waf_managed_rules
    content {
      name     = rule.key
      priority = rule.value

      override_action {
        none {}
      }

      statement {
        managed_rule_group_statement {
          vendor_name = "AWS"
          name        = rule.key
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = rule.key
        sampled_requests_enabled   = true
      }
    }
  }

  rule {
    name     = "RateLimitPerIp"
    priority = 40

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit                 = local.waf_rate_limit
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimitPerIp"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-edge"
    sampled_requests_enabled   = true
  }
}
