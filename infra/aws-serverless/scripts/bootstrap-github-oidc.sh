#!/usr/bin/env bash
# Crea (de forma idempotente) el proveedor OIDC de GitHub y el rol que usa el workflow
# .github/workflows/terraform-serverless.yml para ejecutar plan/apply de infra/aws-serverless.
#
# El rol solo lo puede asumir el repositorio indicado, desde la rama main (plan) o desde el
# environment de GitHub "aws-<environment>" (apply, con aprobación). El subject usa el formato
# inmutable de GitHub (owner@id/repo@id) si el repositorio lo tiene activado.
#
# Uso: scripts/bootstrap-github-oidc.sh <project> <environment> <owner/repo>
# Requiere credenciales AWS con permisos IAM en la cuenta destino y `gh` autenticado.
set -Eeuo pipefail

PROJECT="${1:?Uso: $0 <project> <environment> <owner/repo>}"
ENVIRONMENT="${2:?Uso: $0 <project> <environment> <owner/repo>}"
REPO="${3:?Uso: $0 <project> <environment> <owner/repo>}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ROLE_NAME="${PROJECT}-${ENVIRONMENT}-github-terraform"
PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"

# Prefijo del subject: el que GitHub emite realmente para este repositorio.
SUB_PREFIX="$(gh api "repos/${REPO}/actions/oidc/customization/sub" --jq '.sub_claim_prefix // empty' 2>/dev/null || true)"
SUB_PREFIX="${SUB_PREFIX:-repo:${REPO}}"

if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" >/dev/null 2>&1; then
  aws iam create-open-id-connect-provider \
    --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com >/dev/null
  echo "Proveedor OIDC de GitHub creado."
fi

TRUST="$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Federated": "${PROVIDER_ARN}"},
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": [
          "${SUB_PREFIX}:ref:refs/heads/main",
          "${SUB_PREFIX}:environment:aws-${ENVIRONMENT}"
        ]
      }
    }
  }]
}
JSON
)"

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "$TRUST"
  echo "Rol $ROLE_NAME ya existe; política de confianza actualizada."
else
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST" \
    --max-session-duration 3600 \
    --tags "Key=Project,Value=${PROJECT}" "Key=Environment,Value=${ENVIRONMENT}" "Key=ManagedBy,Value=bootstrap" >/dev/null
  echo "Rol $ROLE_NAME creado."
fi

# El stack crea VPC, IAM, KMS, Aurora, CloudFront, etc.: Terraform necesita permisos amplios.
aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess

echo "ROLE_ARN=arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
echo "SUB_PREFIX=${SUB_PREFIX}"
