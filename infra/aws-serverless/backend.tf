# Backend S3 con configuración parcial: el bucket, la clave y la región se pasan en
# `terraform init -backend-config=backend.hcl` (ver backend.hcl.example y
# scripts/bootstrap-state.sh). El bloqueo usa el lockfile nativo de S3 (use_lockfile),
# sin tabla DynamoDB.
terraform {
  backend "s3" {}
}
