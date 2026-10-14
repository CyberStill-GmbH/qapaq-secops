variable "wazuh_dashboard_hostname" {
  description = "Optional dashboard hostname in the managed root zone; configured in place through SSM."
  type        = string
  default     = null

  validation {
    condition = var.wazuh_dashboard_hostname == null ? true : can(regex(
      "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$",
      var.wazuh_dashboard_hostname,
    ))
    error_message = "Use a lowercase DNS hostname without a scheme, path or wildcard."
  }
}

resource "aws_route53_record" "wazuh_dashboard" {
  count = var.wazuh_dashboard_hostname != null ? 1 : 0

  zone_id = aws_route53_zone.public_root[0].zone_id
  name    = var.wazuh_dashboard_hostname
  type    = "A"
  ttl     = 60
  records = [module.wazuh_public.public_ip]

  lifecycle {
    precondition {
      condition = var.public_root_route53_zone_name != null && var.enable_https && var.public_api_hostname != null ? endswith(
        var.wazuh_dashboard_hostname,
        ".${trimsuffix(lower(var.public_root_route53_zone_name), ".")}",
      ) : false
      error_message = "The dashboard hostname needs HTTPS, an API TLS hostname, and a subdomain in the managed root zone."
    }
  }
}

variable "wazuh_dashboard_legacy_hostname" {
  description = "Optional previous Dashboard hostname retained as a rollback alias until the QAPAQ cutover is verified."
  type        = string
  default     = null

  validation {
    condition = var.wazuh_dashboard_legacy_hostname == null ? true : can(regex(
      "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$",
      var.wazuh_dashboard_legacy_hostname,
    ))
    error_message = "Use a lowercase legacy Dashboard hostname without a scheme, path or wildcard."
  }
}

moved {
  from = aws_route53_record.wazuh_dashboard[0]
  to   = aws_route53_record.wazuh_dashboard_legacy[0]
}

moved {
  from = aws_route53_record.wazuh_dashboard_caa[0]
  to   = aws_route53_record.wazuh_dashboard_legacy_caa[0]
}

resource "aws_route53_record" "wazuh_dashboard_legacy" {
  count = var.wazuh_dashboard_legacy_hostname != null ? 1 : 0

  zone_id = aws_route53_zone.public_root[0].zone_id
  name    = var.wazuh_dashboard_legacy_hostname
  type    = "A"
  ttl     = 60
  records = [module.wazuh_public.public_ip]

  lifecycle {
    precondition {
      condition = var.public_root_route53_zone_name != null && var.enable_https && var.wazuh_dashboard_hostname != null && var.wazuh_dashboard_legacy_hostname != var.wazuh_dashboard_hostname ? endswith(
        var.wazuh_dashboard_legacy_hostname,
        ".${trimsuffix(lower(var.public_root_route53_zone_name), ".")}",
      ) : false
      error_message = "The rollback hostname must differ from the new Dashboard hostname and belong to the managed root zone."
    }
  }
}

resource "aws_route53_record" "wazuh_dashboard_caa" {
  count = var.wazuh_dashboard_hostname != null ? 1 : 0

  zone_id = aws_route53_zone.public_root[0].zone_id
  name    = var.wazuh_dashboard_hostname
  type    = "CAA"
  ttl     = 60
  records = ["0 issue \"letsencrypt.org\""]
}

resource "aws_route53_record" "wazuh_dashboard_legacy_caa" {
  count = var.wazuh_dashboard_legacy_hostname != null ? 1 : 0

  zone_id = aws_route53_zone.public_root[0].zone_id
  name    = var.wazuh_dashboard_legacy_hostname
  type    = "CAA"
  ttl     = 60
  records = ["0 issue \"letsencrypt.org\""]
}

resource "aws_ssm_document" "wazuh_dashboard_domain" {
  count           = var.wazuh_dashboard_hostname != null ? 1 : 0
  name            = "${var.project}-${var.environment}-wazuh-dashboard-domain"
  document_type   = "Command"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Configure the QAPAQ Wazuh Dashboard hostname, same-origin API proxy and HTTPS in place."
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "configureDomain"
      inputs = {
        timeoutSeconds = "1200"
        runCommand = [
          "set -eu",
          "work=$(mktemp -d)",
          "trap 'rm -rf \"$work\"' EXIT",
          "printf '%s' '${base64gzip(file("${path.module}/scripts/configure-wazuh-domain.sh"))}' | base64 -d | gunzip > \"$work/configure.sh\"",
          "bash \"$work/configure.sh\" '${var.wazuh_dashboard_hostname}' '${module.wazuh_public.public_ip}' '${module.runtime.load_balancer_dns_name}' '${var.public_api_hostname}' 'qapaq-secops-dashboard' '${var.wazuh_dashboard_legacy_hostname != null ? var.wazuh_dashboard_legacy_hostname : ""}'",
        ]
      }
    }]
  })

  tags = { Project = var.project, Environment = var.environment, Purpose = "wazuh-dashboard-https" }
}

resource "aws_ssm_association" "wazuh_dashboard_domain" {
  count                            = var.wazuh_dashboard_hostname != null ? 1 : 0
  name                             = aws_ssm_document.wazuh_dashboard_domain[0].name
  document_version                 = aws_ssm_document.wazuh_dashboard_domain[0].latest_version
  association_name                 = "${var.project}-${var.environment}-wazuh-dashboard-domain"
  wait_for_success_timeout_seconds = 1500

  targets {
    key    = "InstanceIds"
    values = [module.wazuh_public.instance_id]
  }

  depends_on = [
    aws_route53_record.wazuh_dashboard,
    aws_route53_record.wazuh_dashboard_caa,
    aws_route53_record.wazuh_dashboard_legacy,
    aws_route53_record.wazuh_dashboard_legacy_caa,
  ]
}
