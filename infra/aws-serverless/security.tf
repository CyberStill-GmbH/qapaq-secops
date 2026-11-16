# Controles de seguridad de cuenta/región. Si una cuenta de seguridad delegada (Organizations)
# ya gestiona GuardDuty, Security Hub o un trail organizacional, desactivar los toggles para
# no duplicar costo ni chocar con la configuración central.

resource "aws_cloudtrail" "main" {
  count = var.enable_cloudtrail ? 1 : 0

  name                          = "${local.name}-trail"
  s3_bucket_name                = module.bucket_logs.id
  s3_key_prefix                 = "cloudtrail"
  kms_key_id                    = aws_kms_key.audit.arn
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true

  depends_on = [module.bucket_logs]
}

resource "aws_guardduty_detector" "main" {
  count = var.enable_guardduty ? 1 : 0

  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
}

resource "aws_securityhub_account" "main" {
  count = var.enable_security_hub ? 1 : 0

  enable_default_standards  = false
  control_finding_generator = "SECURITY_CONTROL"
  auto_enable_controls      = true
}

resource "aws_securityhub_standards_subscription" "fsbp" {
  count = var.enable_security_hub ? 1 : 0

  standards_arn = "arn:${local.partition}:securityhub:${local.region}::standards/aws-foundational-security-best-practices/v/1.0.0"

  depends_on = [aws_securityhub_account.main]
}

resource "aws_accessanalyzer_analyzer" "account" {
  count = var.enable_account_level_controls ? 1 : 0

  analyzer_name = "${local.name}-account"
  type          = "ACCOUNT"
}

# Cifrado EBS por defecto con la clave gestionada de AWS (no la CMK, para no romper otras
# cargas de la cuenta que no tengan permisos sobre ella). El nodo Wazuh usa la CMK explícita.
resource "aws_ebs_encryption_by_default" "this" {
  count = var.enable_account_level_controls ? 1 : 0

  enabled = true
}

resource "aws_s3_account_public_access_block" "this" {
  count = var.enable_account_level_controls ? 1 : 0

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
