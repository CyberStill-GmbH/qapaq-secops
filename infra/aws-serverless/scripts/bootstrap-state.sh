#!/usr/bin/env bash
# Crea (de forma idempotente) el bucket S3 del estado de Terraform para infra/aws-serverless:
# versionado, cifrado SSE-KMS (clave gestionada aws/s3), bloqueo de acceso público y política
# TLS-only. El bloqueo de concurrencia usa el lockfile nativo de S3 (use_lockfile = true).
#
# Uso: scripts/bootstrap-state.sh <project> <environment> [region]
# Requiere credenciales AWS con permisos sobre S3 en la cuenta destino.
set -Eeuo pipefail

PROJECT="${1:?Uso: $0 <project> <environment> [region]}"
ENVIRONMENT="${2:?Uso: $0 <project> <environment> [region]}"
REGION="${3:-us-east-1}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${PROJECT}-tfstate-${ACCOUNT_ID}-${REGION}"

if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "El bucket $BUCKET ya existe; se reaplican los controles."
else
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION"
  fi
fi

aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"},"BucketKeyEnabled":true}]}'

aws s3api put-bucket-ownership-controls --bucket "$BUCKET" --ownership-controls \
  '{"Rules":[{"ObjectOwnership":"BucketOwnerEnforced"}]}'

aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "DenyInsecureTransport",
    "Effect": "Deny",
    "Principal": "*",
    "Action": "s3:*",
    "Resource": ["arn:aws:s3:::${BUCKET}", "arn:aws:s3:::${BUCKET}/*"],
    "Condition": {"Bool": {"aws:SecureTransport": "false"}}
  }]
}
JSON
)"

aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration \
  '{"Rules":[{"ID":"expire-old-state-versions","Status":"Enabled","Filter":{},"NoncurrentVersionExpiration":{"NoncurrentDays":90}}]}'

cat > backend.hcl <<HCL
bucket       = "${BUCKET}"
key          = "aws-serverless/${ENVIRONMENT}/terraform.tfstate"
region       = "${REGION}"
encrypt      = true
use_lockfile = true
HCL

echo "Listo. Ejecuta: terraform init -backend-config=backend.hcl"
