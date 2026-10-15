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

variable "wazuh_dashboard_legacy_hostname" {
  description = "Previous Dashboard hostname retained for rollback after the QAPAQ cutover."
  type        = string
  default     = null

  validation {
    condition = var.wazuh_dashboard_legacy_hostname == null ? true : can(regex(
      "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$",
      var.wazuh_dashboard_legacy_hostname,
    ))
    error_message = "Use a lowercase legacy hostname without a scheme, path or wildcard."
  }
}

variable "wazuh_dashboard_redirect_hostname" {
  description = "Optional branded alias that redirects to the registered app hostname."
  type        = string
  default     = null

  validation {
    condition = var.wazuh_dashboard_redirect_hostname == null ? true : can(regex(
      "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$",
      var.wazuh_dashboard_redirect_hostname,
    ))
    error_message = "Use a lowercase redirect hostname without a scheme, path or wildcard."
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

resource "aws_route53_record" "qapaq_dashboard_current" {
  # `app` already has a managed A record in https.tf. Reuse that record for the
  # authorized cutover instead of declaring the same Route 53 name/type twice.
  count = var.wazuh_dashboard_hostname != null && !(
    var.siem_app_cutover && var.public_root_route53_zone_name != null &&
    var.wazuh_dashboard_hostname == "app.${trimsuffix(lower(var.public_root_route53_zone_name), ".")}"
  ) ? 1 : 0

  zone_id = aws_route53_zone.public_root[0].zone_id
  name    = var.wazuh_dashboard_hostname
  type    = "A"
  ttl     = 60
  records = [module.wazuh_public.public_ip]

  lifecycle {
    precondition {
      condition = var.public_root_route53_zone_name != null ? endswith(
        var.wazuh_dashboard_hostname,
        ".${trimsuffix(lower(var.public_root_route53_zone_name), ".")}",
      ) : false
      error_message = "The dashboard hostname must be a subdomain of the managed root zone."
    }
  }
}

resource "aws_route53_record" "qapaq_dashboard_current_caa" {
  count = var.wazuh_dashboard_hostname != null ? 1 : 0

  zone_id = aws_route53_zone.public_root[0].zone_id
  name    = var.wazuh_dashboard_hostname
  type    = "CAA"
  ttl     = 60
  records = ["0 issue \"letsencrypt.org\""]
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
      condition = var.public_root_route53_zone_name != null && var.wazuh_dashboard_hostname != null && var.wazuh_dashboard_legacy_hostname != var.wazuh_dashboard_hostname ? endswith(
        var.wazuh_dashboard_legacy_hostname,
        ".${trimsuffix(lower(var.public_root_route53_zone_name), ".")}",
      ) : false
      error_message = "The rollback hostname must differ from the new Dashboard hostname and belong to the managed root zone."
    }
  }
}

resource "aws_route53_record" "wazuh_dashboard_legacy_caa" {
  count = var.wazuh_dashboard_legacy_hostname != null ? 1 : 0

  zone_id = aws_route53_zone.public_root[0].zone_id
  name    = var.wazuh_dashboard_legacy_hostname
  type    = "CAA"
  ttl     = 60
  records = ["0 issue \"letsencrypt.org\""]
}

resource "aws_route53_record" "qapaq_dashboard_redirect" {
  count = var.wazuh_dashboard_redirect_hostname != null ? 1 : 0

  zone_id = aws_route53_zone.public_root[0].zone_id
  name    = var.wazuh_dashboard_redirect_hostname
  type    = "A"
  ttl     = 60
  records = [module.wazuh_public.public_ip]

  lifecycle {
    precondition {
      condition = var.public_root_route53_zone_name != null && var.wazuh_dashboard_hostname != null && var.wazuh_dashboard_redirect_hostname != var.wazuh_dashboard_hostname && var.wazuh_dashboard_redirect_hostname != var.wazuh_dashboard_legacy_hostname ? endswith(
        var.wazuh_dashboard_redirect_hostname,
        ".${trimsuffix(lower(var.public_root_route53_zone_name), ".")}",
      ) : false
      error_message = "The branded redirect hostname must be distinct and belong to the managed root zone."
    }
  }
}

resource "aws_route53_record" "qapaq_dashboard_redirect_caa" {
  count = var.wazuh_dashboard_redirect_hostname != null ? 1 : 0

  zone_id = aws_route53_zone.public_root[0].zone_id
  name    = var.wazuh_dashboard_redirect_hostname
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
    description   = "Configure the Wazuh dashboard DNS hostname and HTTPS without reinstalling Wazuh."
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
          "bash \"$work/configure.sh\" '${var.wazuh_dashboard_hostname}' '${module.wazuh_public.public_ip}' '${var.wazuh_dashboard_legacy_hostname != null ? var.wazuh_dashboard_legacy_hostname : ""}' '${var.wazuh_dashboard_redirect_hostname != null ? var.wazuh_dashboard_redirect_hostname : ""}'",
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
    aws_route53_record.qapaq_dashboard_current,
    aws_route53_record.qapaq_dashboard_current_caa,
    aws_route53_record.wazuh_dashboard_legacy,
    aws_route53_record.wazuh_dashboard_legacy_caa,
    aws_route53_record.qapaq_dashboard_redirect,
    aws_route53_record.qapaq_dashboard_redirect_caa,
    aws_route53_record.vercel_apps,
  ]
}
